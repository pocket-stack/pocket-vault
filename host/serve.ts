// host/serve.ts — the Pocket Vault companion. Runs on the Mac beside the
// vault folder; the 3DS finds it over the LAN and asks it for pages of
// titles, laid-out rows of a note, and edits. Everything a guest must not
// do on its own thread happens here: the SQLite index, full-text search,
// file reads and writes, and the line breaking that turns a 100 KB note
// into rows the console paints as given.
//
//   bun run companion [--vault ./vault] [--unicast <3ds-ip>] [--port 8622]
//                     [--no-beacon] [--name "evan's Mac"] [--memory]
//
// Method by method (app/protocol.ts):
//   vault.list   a page of notes, by title or by search rank
//   doc.open     layout summary: row kinds, density map, revision
//   doc.rows     one window of rows under the current revision
//   doc.outline  headings with the rows they start
//   doc.focus    show one line raw for editing (Obsidian's live preview)
//   doc.edit     replace a source range (insert, delete, split, join) under a
//                per-session sequence number; the file is written 400 ms
//                after the last edit
//   doc.save     write now
// Event `vault.changed` announces a new index version after the folder
// changed on disk; the guest re-queries its list.

import { writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { createCompanionHost, type CompanionContext } from "../vendor/pocketjs/tools/companion-host.ts";
import { serveCompanion } from "../vendor/pocketjs/tools/companion-serve.ts";
import {
  PAGE_ROWS,
  VAULT_APP,
  type DocInfo,
  type EditParams,
  type FocusParams,
  type ListParams,
  type ListResult,
  type OpenParams,
  type OutlineItem,
  type Patch,
  type RowsParams,
  type RowsResult,
} from "../app/protocol.ts";
import { VaultIndex } from "./index.ts";
import {
  docInfo,
  docTitle,
  focusLine,
  layoutDoc,
  Metrics,
  outline,
  replaceRange,
  rowsOf,
  sourceText,
  type Laid,
} from "./layout.ts";

const SAVE_DEBOUNCE_MS = 400;
const OPEN_DOCS = 8;
const MAX_ROWS_PER_REPLY = PAGE_ROWS * 4;

export interface VaultServiceOptions {
  vault: string;
  memory?: boolean;
  log?: (line: string) => void;
}

/** The companion's methods over an index and a layout cache, with no
 *  network in it — tests drive this through the sim pair. */
export function createVaultService(options: VaultServiceOptions) {
  const log = options.log ?? ((line: string) => console.error(line));
  const index = new VaultIndex(options.vault, { memory: options.memory ?? false });
  const metrics = new Metrics();
  const open = new Map<number, Laid>();
  const saveTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const titles = new Map<number, string>();
  const lastEdits = new Map<string, { seq: number; patch: Patch }>();

  const load = (id: number): Laid => {
    let doc = open.get(id);
    if (doc) {
      open.delete(id);
      open.set(id, doc); // most recent last
      return doc;
    }
    const note = index.note(id);
    if (!note) throw new Error(`no note ${id}`);
    const path = index.absolute(note);
    const text = Bun.file(path).size > 4 * 1024 * 1024 ? null : require("node:fs").readFileSync(path, "utf8");
    if (text === null) throw new Error(`${note.path} is over 4 MiB`);
    const started = performance.now();
    doc = layoutDoc(metrics, id, path, text);
    titles.set(id, docTitle(doc, note.title));
    log(`vault: laid out ${note.path}: ${doc.lines.length} lines → ${doc.rows.length} rows in ${(performance.now() - started).toFixed(0)} ms`);
    open.set(id, doc);
    while (open.size > OPEN_DOCS) {
      const [oldest, victim] = open.entries().next().value as [number, Laid];
      if (victim.dirty) save(victim);
      open.delete(oldest);
      titles.delete(oldest);
    }
    return doc;
  };

  const save = (doc: Laid): void => {
    const timer = saveTimers.get(doc.id);
    if (timer) {
      clearTimeout(timer);
      saveTimers.delete(doc.id);
    }
    if (!doc.dirty) return;
    const text = sourceText(doc);
    writeFileSync(doc.path, text);
    index.touch(doc.id, text);
    doc.dirty = false;
    log(`vault: saved ${doc.path} (${text.length} bytes)`);
  };

  const scheduleSave = (doc: Laid): void => {
    const previous = saveTimers.get(doc.id);
    if (previous) clearTimeout(previous);
    saveTimers.set(doc.id, setTimeout(() => save(doc), SAVE_DEBOUNCE_MS));
  };

  const title = (doc: Laid): string => titles.get(doc.id) ?? docTitle(doc, String(doc.id));

  const methods = {
    "vault.list": (params: ListParams): ListResult => {
      const page = index.list(params.q, params.offset ?? 0, params.limit ?? 24);
      return { ...page, version: index.currentVersion() };
    },
    "doc.open": (params: OpenParams): DocInfo => {
      const doc = load(params.id);
      return docInfo(doc, title(doc));
    },
    "doc.rows": (params: RowsParams): RowsResult => {
      const doc = load(params.id);
      if (params.rev !== doc.rev) throw new Error(`stale revision ${params.rev} (now ${doc.rev})`);
      const count = Math.min(MAX_ROWS_PER_REPLY, Math.max(0, params.count));
      return { from: params.from, rev: doc.rev, rows: rowsOf(doc, params.from, count) };
    },
    "doc.outline": (params: OpenParams): OutlineItem[] => outline(load(params.id)),
    "doc.focus": (params: FocusParams): Patch => {
      const doc = load(params.id);
      return focusLine(metrics, doc, params.line, title(doc));
    },
    "doc.edit": (params: EditParams, context: CompanionContext): Patch => {
      const doc = load(params.id);
      // A re-sent edit (the link dropped after it was applied) gets the same
      // patch again instead of being applied twice. Keyed by the GUEST
      // session from the hello, which survives a reconnect; the transport
      // session does not.
      const key = `${context.session.hello?.session ?? context.session.id}:${params.id}`;
      const last = lastEdits.get(key);
      if (last && params.seq <= last.seq) {
        if (params.seq === last.seq) return last.patch;
        throw new Error(`edit ${params.seq} is older than ${last.seq}`);
      }
      const patch = replaceRange(metrics, doc, params.from, params.to, params.text, title(doc));
      patch.seq = params.seq;
      lastEdits.set(key, { seq: params.seq, patch });
      titles.set(doc.id, docTitle(doc, index.note(doc.id)?.title ?? title(doc)));
      scheduleSave(doc);
      return patch;
    },
    "doc.save": (params: OpenParams): { saved: boolean } => {
      const doc = open.get(params.id);
      if (!doc) return { saved: false };
      const wasDirty = doc.dirty;
      save(doc);
      return { saved: wasDirty };
    },
  };

  const host = createCompanionHost({
    app: VAULT_APP,
    name: hostname().replace(/\.local$/, ""),
    methods,
    onHello: (session, hello) => {
      // A fresh guest boot starts its sequence over; forget older guests'
      // sequences so the map stays small.
      for (const key of lastEdits.keys()) if (!key.startsWith(`${hello.session}:`)) lastEdits.delete(key);
      log(`vault: guest ${hello.device ?? "?"} session ${hello.session} on ${session.peer.label ?? session.id}`);
    },
    onClose: (session) => log(`vault: guest ${session.peer.label ?? session.id} left`),
    log,
  });

  const started = performance.now();
  const changed = index.sync();
  log(`vault: ${index.count()} notes in ${options.vault} (${changed} read) in ${(performance.now() - started).toFixed(0)} ms`);
  index.onChange((version) => {
    log(`vault: folder changed → index v${version}`);
    host.publish("vault.changed", { version });
  });

  return {
    host,
    index,
    metrics,
    /** The method table, for tests that wrap a method. */
    methods,
    /** Flush every dirty note. */
    flush(): void {
      for (const doc of open.values()) save(doc);
    },
    close(): void {
      this.flush();
      index.close();
    },
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const unicast = argv.flatMap((arg, i) => (arg === "--unicast" && argv[i + 1] ? [argv[i + 1]!] : []));
  const service = createVaultService({ vault: value("--vault") ?? "vault", memory: argv.includes("--memory") });
  service.index.watch();
  const server = await serveCompanion(service.host, {
    port: value("--port") ? Number(value("--port")) : undefined,
    unicast,
    beacon: !argv.includes("--no-beacon"),
  });
  const stop = (): void => {
    service.close();
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
