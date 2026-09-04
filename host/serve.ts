// host/serve.ts — the Pocket Vault companion. Runs on the Mac beside the
// vault folder; the 3DS finds it over the LAN and asks it for a folder's
// children, a page of notes, a note's laid-out rows, its links, its tags, and
// edits. Everything a guest must not do on its own thread happens here: the
// SQLite index, full-text search, file reads and writes, and the line
// breaking that turns a 100 KB note into rows the console paints as given.
//
//   bun run companion [--vault ./vault] [--unicast <3ds-ip>] [--port 8622]
//                     [--no-beacon] [--memory]
//
// Method by method (app/protocol.ts):
//   vault.tree     one folder's subfolders (with counts) and notes
//   vault.list     a page of notes, by folder, by tag, or by search rank
//   vault.tags     every tag with its note count
//   vault.create   a new note; vault.mkdir a new folder; vault.delete to trash
//   doc.open       layout summary: row kinds, density map, revision
//   doc.rows       one window of rows under the current revision
//   doc.line       one source line, for a guest with no rows for it yet
//   doc.outline    headings with the rows they start
//   doc.links      outgoing wiki links and backlinks
//   doc.edit       replace a source range under a per-session sequence number
//   doc.task       flip a checkbox
//   doc.save       write now (a dirty note is also written 400 ms after the
//                  last edit)
// Event `vault.changed` announces a new index version after the folder
// changed on disk; the guest re-queries its tree and its list.

import { readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { createCompanionHost, type CompanionContext } from "../vendor/pocketjs/tools/companion-host.ts";
import { serveCompanion } from "../vendor/pocketjs/tools/companion-serve.ts";
import {
  PAGE_ROWS,
  VAULT_APP,
  type CreateParams,
  type DocInfo,
  type EditParams,
  type LineParams,
  type LineResult,
  type LinksResult,
  type ListParams,
  type ListResult,
  type MkdirParams,
  type OpenParams,
  type OutlineItem,
  type Patch,
  type RowsParams,
  type RowsResult,
  type TagItem,
  type TreeParams,
  type TreeResult,
} from "../app/protocol.ts";
import { VaultIndex } from "./index.ts";
import {
  docInfo,
  docLinks,
  docTitle,
  layoutDoc,
  Metrics,
  outline,
  replaceRange,
  rowsOf,
  sourceText,
  toggleTask,
  type Laid,
} from "./layout.ts";

const SAVE_DEBOUNCE_MS = 400;
const OPEN_DOCS = 8;
const MAX_ROWS_PER_REPLY = PAGE_ROWS * 4;
const MAX_NOTE_BYTES = 4 * 1024 * 1024;

export interface VaultServiceOptions {
  vault: string;
  memory?: boolean;
  log?: (line: string) => void;
}

/** The companion's methods over an index and a layout cache, with no network
 *  in it — tests drive this through the sim pair. */
export function createVaultService(options: VaultServiceOptions) {
  const log = options.log ?? ((line: string) => console.error(line));
  const index = new VaultIndex(options.vault, { memory: options.memory ?? false });
  const metrics = new Metrics();
  const open = new Map<number, Laid>();
  const saveTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const titles = new Map<number, string>();
  const lastEdits = new Map<string, { seq: number; patch: Patch }>();

  const load = (id: number): Laid => {
    const cached = open.get(id);
    if (cached) {
      open.delete(id);
      open.set(id, cached); // most recent last
      return cached;
    }
    const note = index.note(id);
    if (!note) throw new Error(`no note ${id}`);
    if (note.size > MAX_NOTE_BYTES) throw new Error(`${note.path} is over 4 MiB`);
    const path = index.absolute(note);
    const started = performance.now();
    const doc = layoutDoc(metrics, id, note.path, readFileSync(path, "utf8"), path);
    titles.set(id, docTitle(doc, note.title));
    log(
      `vault: laid out ${note.path}: ${doc.lines.length} lines → ${doc.rows.length} rows in ` +
        `${(performance.now() - started).toFixed(0)} ms`,
    );
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
    writeFileSync(doc.file, text);
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

  /** After an edit the title may have moved with the H1. */
  const retitle = (doc: Laid): void => {
    titles.set(doc.id, docTitle(doc, index.note(doc.id)?.title ?? title(doc)));
  };

  const methods = {
    "vault.tree": (params: TreeParams): TreeResult => {
      const folder = params.folder ?? "";
      return { folder, entries: index.tree(folder) };
    },
    "vault.list": (params: ListParams): ListResult => {
      const page = index.list(
        {
          ...(params.q === undefined ? {} : { q: params.q }),
          ...(params.folder === undefined ? {} : { folder: params.folder }),
          ...(params.tag === undefined ? {} : { tag: params.tag }),
        },
        params.offset ?? 0,
        params.limit ?? 24,
      );
      return { ...page, version: index.currentVersion() };
    },
    "vault.tags": (): TagItem[] => index.tags(),
    "vault.create": (params: CreateParams): { id: number; path: string } => {
      const made = index.create(params.folder ?? "", params.title, params.body);
      log(`vault: created ${made.path}`);
      return made;
    },
    "vault.mkdir": (params: MkdirParams): { path: string } => {
      const made = index.mkdir(params.folder ?? "", params.name);
      log(`vault: created folder ${made.path}`);
      return made;
    },
    "vault.delete": (params: OpenParams): { deleted: boolean } => {
      const note = index.note(params.id);
      const deleted = index.remove(params.id);
      if (deleted) {
        open.delete(params.id);
        titles.delete(params.id);
        log(`vault: moved ${note?.path ?? params.id} to .trash`);
      }
      return { deleted };
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
    "doc.line": (params: LineParams): LineResult => {
      const doc = load(params.id);
      const line = Math.max(0, Math.min(doc.lines.length - 1, params.line));
      return { line, text: doc.lines[line] ?? "", rev: doc.rev };
    },
    "doc.outline": (params: OpenParams): OutlineItem[] => outline(load(params.id)),
    "doc.links": (params: OpenParams): LinksResult => {
      const doc = load(params.id);
      return {
        out: docLinks(doc).map((link) => ({ title: link.target, id: index.resolve(link.target), line: link.line })),
        back: index.backlinks(params.id).map((note) => ({ title: note.title, id: note.id })),
      };
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
      retitle(doc);
      scheduleSave(doc);
      return patch;
    },
    "doc.task": (params: LineParams): Patch => {
      const doc = load(params.id);
      const patch = toggleTask(metrics, doc, params.line, title(doc));
      retitle(doc);
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
  log(
    `vault: ${index.count()} notes in ${options.vault} (${changed} read) in ` +
      `${(performance.now() - started).toFixed(0)} ms`,
  );
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
