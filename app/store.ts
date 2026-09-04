// app/store.ts — the guest's whole state, and every companion conversation.
//
// Nothing in here reads a file or measures a document. The companion holds
// the vault, its index and its layout; this store holds windows onto them: a
// folder's children, a page of note titles, a run of rows around the
// document's viewport (aimed a quarter second ahead of a fling so the rows
// are there when it lands), and the document's row-kind string, from which
// every row top is a prefix sum.
//
// Editing is local first, and with the WYSIWYG row model it is local for
// every ordinary keystroke:
//
//   - The guest holds the caret line's source text. A character, a delete, a
//     split and a join all apply to that text and re-break the affected
//     lines on the same frame with the shared wrapper (app/linewrap.ts) over
//     the same advances the companion sums, so the screen is right before
//     the request goes out.
//   - Joining needs the line above, which the guest reconstructs from that
//     line's rows: the row model's source mapping is total, so any cached
//     line reads back exactly (app/rowmap.ts).
//   - One edit is in flight at a time and queued keystrokes coalesce into
//     it. While the guest is ahead of the companion it keeps its own rows for
//     the lines it edited and takes only the revision, the map and the total
//     from a patch; when the queue drains the two agree, and a disagreeing
//     total drops the cache rather than lie.
//   - A per-session sequence number makes a re-sent edit idempotent, so a
//     dropped link costs nothing.

import { batch, createComputed, createMemo, createSignal, type Accessor } from "solid-js";
import { createCompanion, createQuery, type Companion, type CompanionOps } from "@pocketjs/framework/companion";
import { createScroller, type Scroller } from "@pocketjs/framework/kinetics";
import { BTN } from "@pocketjs/framework/input";
import { measure } from "./fonts.ts";
import { layoutLine } from "./linewrap.ts";
import { reKind } from "./markdown.ts";
import {
  DOC_VIEW_H,
  END_OF_LINE,
  KIND_CHARS,
  LIST_PAGE,
  PAGE_ROWS,
  TREE_LIMIT,
  rowAtY,
  rowTops,
  VAULT_APP,
  type DocInfo,
  type LineResult,
  type LinksResult,
  type ListItem,
  type ListResult,
  type OutlineItem,
  type Patch,
  type Pos,
  type Row,
  type RowsResult,
  type TagItem,
  type TreeEntry,
  type TreeResult,
} from "./protocol.ts";
import { caretX, colAtX, rowSourceText } from "./rowmap.ts";

export type Deck = "browse" | "edit" | "search";
export type Tab = "files" | "links" | "tags";
export type KbLayer = "lower" | "upper" | "sym";
export type MenuId = "vault" | "actions";

export interface Caret {
  line: number;
  col: number;
}

export interface MenuItem {
  label: string;
  hint?: string;
  run(): void;
}

/** One rendered line of the folder tree: an entry plus its depth. */
export interface TreeRow {
  entry: TreeEntry;
  depth: number;
}

/** Request counters, for the status sheet and the dev wire. */
export interface LinkStats {
  requests: Record<string, number>;
  replies: number;
  errors: number;
  maxPending: number;
}

/** Rows kept around the viewport before far ones are dropped. */
const ROW_CACHE_MAX = 1200;
/** Rows mounted beyond each screen edge. */
export const OVERSCAN = 40;
/** How far ahead of a fling the row window is aimed, in seconds. */
const LOOKAHEAD_S = 0.25;
const REPEAT_DELAY = 18;
const REPEAT_EVERY = 5;
/** A page turn moves one screen less a row of context. */
const PAGE_PX = DOC_VIEW_H - 18;
/** A page that was asked for and still has holes is asked again no sooner
 *  than this many frames later. */
const PAGE_RETRY_FRAMES = 30;
/** Hard bounds on the pager, whatever its logic decides. */
const PAGES_INFLIGHT_MAX = 8;
const PAGES_PER_FRAME_MAX = 3;
/** Frames a shoulder must be held before its menu opens; a shorter press is
 *  a page turn. */
const HOLD_FRAMES = 12;
/** How long a delete stays armed. */
const DELETE_ARMED_FRAMES = 150;

interface EditOp {
  from: Pos;
  to: Pos;
  text: string;
  /** The guest already applied this edit to its own rows. Its patch must
   *  NOT be applied again — the spans describe the same surgery, and
   *  replaying them over rows that already carry it would double-count. */
  local: boolean;
}

export interface VaultStore {
  mac: Companion;
  linkLabel: Accessor<string>;
  lastError: Accessor<string | null>;
  stats(): LinkStats;

  // ── the deck ──
  deck: Accessor<Deck>;
  setDeck(deck: Deck): void;
  tab: Accessor<Tab>;
  setTab(tab: Tab): void;

  // ── the folder tree ──
  treeRows: Accessor<readonly TreeRow[]>;
  expanded(folder: string): boolean;
  toggleFolder(folder: string): void;
  folder: Accessor<string>;
  setFolder(folder: string): void;

  // ── the note list ──
  query: Accessor<string>;
  setQuery(q: string): void;
  tag: Accessor<string>;
  setTag(tag: string): void;
  tags: Accessor<readonly TagItem[]>;
  listTotal: Accessor<number>;
  listItem(index: number): ListItem | undefined;
  setListViewport(first: number): void;
  selected: Accessor<number>;
  select(index: number): void;
  openNote(id: number): void;

  // ── the open document ──
  doc: Accessor<DocInfo | null>;
  tops: Accessor<Int32Array>;
  docHeight: Accessor<number>;
  rowAt(index: number): Row | undefined;
  rowsRev: Accessor<number>;
  scroller: Scroller;
  visibleRange: Accessor<readonly [first: number, last: number]>;
  outline: Accessor<readonly OutlineItem[]>;
  links: Accessor<LinksResult | undefined>;
  jumpToRow(row: number): void;
  jumpToLine(line: number): void;
  scrollFraction(): number;
  scrollToFraction(f: number): void;
  pageBy(direction: -1 | 1): void;
  page: Accessor<number>;
  pages: Accessor<number>;

  // ── editing ──
  caret: Accessor<Caret | null>;
  anchor: Accessor<Caret | null>;
  selecting: Accessor<boolean>;
  setSelecting(on: boolean): void;
  enterEdit(): void;
  leaveEdit(): void;
  insert(text: string): void;
  backspace(): void;
  moveCaret(dx: number, dy: number): void;
  /** Put the caret on a row at a screen x — a tap on the document's map. */
  caretToRow(row: number, x: number): void;
  toggleTask(): void;
  kbLayer: Accessor<KbLayer>;
  setKbLayer(layer: KbLayer): void;
  activeText(): string;
  unconfirmed: Accessor<number>;
  save(): void;

  // ── files ──
  newNote(): void;
  newFolder(): void;
  /** Delete asks first: one tap arms it, a second within DELETE_ARMED_FRAMES
   *  does it, and anything else disarms. A resistive panel reads a resting
   *  stylus as a tap, and a note is not something to lose that way. */
  deleteArmed: Accessor<boolean>;
  armDelete(): void;
  deleteNote(): void;

  // ── the held-shoulder menus ──
  menu: Accessor<MenuId | null>;
  menuIndex: Accessor<number>;
  menuItems: Accessor<readonly MenuItem[]>;
  openMenu(id: MenuId): void;
  closeMenu(): void;
  moveMenu(delta: number): void;
  runMenu(index?: number): void;

  /** Once per frame, before anything reads the scroller. */
  frame(buttons: number): void;
}

/** `ops` overrides the host's svc trio — the sim pair in tests. */
export function createVaultStore(ops?: CompanionOps | null): VaultStore {
  const mac = createCompanion(
    ops === undefined ? { app: VAULT_APP, device: "3ds-dev" } : { app: VAULT_APP, device: "3ds-dev", ops },
  );
  const [deck, setDeckSignal] = createSignal<Deck>("browse");
  const [tab, setTabSignal] = createSignal<Tab>("files");
  const [lastError, setError] = createSignal<string | null>(null);
  mac.onError((message) => setError(message));

  const stats: LinkStats = { requests: {}, replies: 0, errors: 0, maxPending: 0 };
  const count = (method: string): void => {
    stats.requests[method] = (stats.requests[method] ?? 0) + 1;
    stats.maxPending = Math.max(stats.maxPending, mac.core.pendingCount());
  };
  const fail = (error: unknown): void => {
    stats.errors += 1;
    setError(error instanceof Error ? error.message : String(error));
  };

  // ── the vault's version ───────────────────────────────────────────────────
  // Two things invalidate what the guest knows about the vault: the folder
  // changing on disk (the companion says so) and the LINK coming back. A
  // settled query is not pending, so the companion module cannot re-issue
  // it; the link generation goes into every vault query key instead, which
  // is what makes a companion restart show up on screen.
  const [version, setVersion] = createSignal(0);
  const [linkGeneration, setLinkGeneration] = createSignal(0);
  let wasLinked = false;
  createComputed(() => {
    const linked = mac.status() === "linked";
    if (linked && !wasLinked) {
      treeCache.clear();
      listCache.clear();
      batch(() => {
        setLinkGeneration((n) => n + 1);
        setTreeRev((n) => n + 1);
        setListRev((n) => n + 1);
      });
    }
    wasLinked = linked;
  });
  const treeCache = new Map<string, TreeEntry[]>();
  const listCache = new Map<number, ListItem>();
  const [treeRev, setTreeRev] = createSignal(0);
  const [listRev, setListRev] = createSignal(0);
  mac.on<{ version: number }>("vault.changed", (event) => {
    treeCache.clear();
    listCache.clear();
    batch(() => {
      setVersion(event.version);
      setTreeRev((n) => n + 1);
      setListRev((n) => n + 1);
    });
  });

  // ── the folder tree ───────────────────────────────────────────────────────
  const [expandedSet, setExpandedSet] = createSignal<readonly string[]>([""]);
  const [folder, setFolderSignal] = createSignal("");
  /** One folder at a time is fetched; the tree fills in as it opens. */
  const treeKey = (path: string): string => `${version()}:${linkGeneration()}:${path}`;
  const nextFolder = createMemo<string | null>(() => {
    void treeRev();
    for (const path of expandedSet()) if (!treeCache.has(treeKey(path))) return path;
    return null;
  });
  createComputed(() => {
    const path = nextFolder();
    if (path === null) return;
    const key = treeKey(path);
    treeCache.set(key, []); // claim it, so this does not re-fire every frame
    count("vault.tree");
    mac.core.request("vault.tree", { folder: path, limit: TREE_LIMIT }, (body) => {
      stats.replies += 1;
      if (!("ok" in body)) {
        treeCache.delete(key);
        fail(new Error(body.err));
        return;
      }
      const result = body.ok as TreeResult;
      const entries = [...result.entries];
      if (result.total > entries.length) {
        // The rest of this folder is browsed in the note list; the row says
        // so and selects the folder.
        entries.push({ path, name: `${result.total - entries.length} more in this folder`, folder: false });
      }
      treeCache.set(key, entries);
      setTreeRev((n) => n + 1);
    });
  });
  const expanded = (path: string): boolean => expandedSet().includes(path);
  /** The tree, flattened for a list: a folder's children follow it while it
   *  is open. */
  const treeRows = createMemo<readonly TreeRow[]>(() => {
    void treeRev();
    const open = expandedSet();
    const out: TreeRow[] = [];
    const walk = (path: string, depth: number): void => {
      for (const entry of treeCache.get(treeKey(path)) ?? []) {
        out.push({ entry, depth });
        if (entry.folder && open.includes(entry.path)) walk(entry.path, depth + 1);
      }
    };
    walk("", 0);
    return out;
  });

  // ── the note list ─────────────────────────────────────────────────────────
  const [query, setQuery] = createSignal("");
  const [tag, setTag] = createSignal("");
  const [listFirst, setListFirst] = createSignal(0);
  const [listTotal, setListTotal] = createSignal(0);
  const [selected, setSelected] = createSignal(-1);
  const listKey = createMemo(() => `${version()}|${linkGeneration()}|${query()}|${folder()}|${tag()}`);
  let lastListKey = "";
  createComputed(() => {
    const key = listKey();
    if (key === lastListKey) return;
    lastListKey = key;
    listCache.clear();
    batch(() => {
      setListFirst(0);
      setSelected(-1);
      setListRev((n) => n + 1);
    });
  });
  const listPage = createQuery<ListResult>(mac, () => {
    const from = Math.max(0, Math.floor(listFirst() / LIST_PAGE) * LIST_PAGE - LIST_PAGE);
    return [
      "vault.list",
      { q: query(), folder: folder(), tag: tag(), offset: from, limit: LIST_PAGE * 2, v: version(), g: linkGeneration() },
    ];
  });
  createComputed(() => {
    const page = listPage();
    if (!page) return;
    const from = Math.max(0, Math.floor(listFirst() / LIST_PAGE) * LIST_PAGE - LIST_PAGE);
    page.items.forEach((item, i) => listCache.set(from + i, item));
    batch(() => {
      setListTotal(page.total);
      setListRev((n) => n + 1);
    });
  });
  const tagsQuery = createQuery<TagItem[]>(mac, () =>
    tab() === "tags" ? ["vault.tags", { v: version(), g: linkGeneration() }] : null,
  );

  // ── the open document ─────────────────────────────────────────────────────
  const [doc, setDoc] = createSignal<DocInfo | null>(null);
  const [openId, setOpenId] = createSignal<number | null>(null);
  const [rowsRev, setRowsRev] = createSignal(0);
  const rowCache = new Map<number, Row>();
  const tops = createMemo(() => rowTops(doc()?.kinds ?? ""));
  const docHeight = () => {
    const t = tops();
    return t.length === 0 ? 0 : t[t.length - 1]!;
  };
  const scroller = createScroller({
    max: () => Math.max(0, docHeight() - DOC_VIEW_H),
    extent: () => DOC_VIEW_H,
    overscroll: 40,
  });

  const info = createQuery<DocInfo>(mac, () => (openId() === null ? null : ["doc.open", { id: openId() }]), {
    keep: false,
  });
  createComputed(() => {
    const next = info();
    if (!next) return;
    rowCache.clear();
    pageAsked.clear();
    batch(() => {
      setDoc(next);
      setRowsRev((n) => n + 1);
    });
  });

  const outlineQuery = createQuery<OutlineItem[]>(mac, () =>
    tab() === "links" && doc() ? ["doc.outline", { id: doc()!.id, rev: doc()!.rev }] : null,
  );
  const linksQuery = createQuery<LinksResult>(mac, () =>
    tab() === "links" && doc() ? ["doc.links", { id: doc()!.id, v: version() }] : null,
  );

  // ── editing state (the row pager consults it) ─────────────────────────────
  const [caret, setCaret] = createSignal<Caret | null>(null);
  const [anchor, setAnchor] = createSignal<Caret | null>(null);
  const [selecting, setSelectingSignal] = createSignal(false);
  const [kbLayer, setKbLayer] = createSignal<KbLayer>("lower");
  const [unconfirmed, setUnconfirmed] = createSignal(0);
  /** The caret's line, and the guest's copy of its source text. */
  let activeLine: number | null = null;
  let localText: string | null = null;
  let seq = 0;
  const queue: EditOp[] = [];
  let inflight: EditOp | null = null;
  let frameCount = 0;
  let lastResync = -1000;
  const ahead = (): boolean => queue.length > 0 || inflight !== null;

  // ── the row pager ─────────────────────────────────────────────────────────
  const inflightPages = new Map<number, number>();
  const pageAsked = new Map<number, number>();
  let inflightRev = -1;
  const pageMissing = (page: number, total: number): boolean => {
    const from = page * PAGE_ROWS;
    const to = Math.min(total, from + PAGE_ROWS);
    for (let i = from; i < to; i++) if (!rowCache.has(i)) return true;
    return false;
  };
  const requestPage = (d: DocInfo, page: number): void => {
    const from = page * PAGE_ROWS;
    const rev = d.rev;
    pageAsked.set(page, frameCount);
    count("doc.rows");
    let id: number;
    try {
      id = mac.core.request("doc.rows", { id: d.id, from, count: PAGE_ROWS, rev }, (body) => {
        inflightPages.delete(page);
        stats.replies += 1;
        if (!("ok" in body)) {
          stats.errors += 1;
          // The companion's revision moved on without us: read the summary
          // again, at most once a second.
          if (body.err.includes("stale revision") && frameCount - lastResync > 60) {
            lastResync = frameCount;
            info.refetch();
          }
          return;
        }
        const result = body.ok as RowsResult;
        const current = doc();
        if (!current || current.id !== d.id || result.rev !== current.rev) return;
        // A reply that crossed a local edit would land off by the rows that
        // edit gained or lost; the page is asked again once confirmed.
        if (ahead()) return;
        result.rows.forEach((row, i) => rowCache.set(result.from + i, row));
        if (rowCache.size > ROW_CACHE_MAX) {
          const centre = rowAtY(tops(), scroller.offset());
          for (const key of rowCache.keys()) {
            if (Math.abs(key - centre) > ROW_CACHE_MAX / 2) rowCache.delete(key);
          }
        }
        setRowsRev((n) => n + 1);
      });
    } catch (error) {
      // The link's pending table is full: leave the page for a later frame
      // rather than let a frame throw and take the guest down with it.
      fail(error);
      return;
    }
    inflightPages.set(page, id);
  };
  const aim = (): number => {
    if (scroller.state() === "fling") return scroller.offset() + scroller.velocity() * LOOKAHEAD_S;
    return scroller.intent();
  };
  createComputed(() => {
    const d = doc();
    void rowsRev();
    if (!d || d.rows === 0) {
      for (const id of inflightPages.values()) mac.core.cancel(id);
      inflightPages.clear();
      return;
    }
    if (inflightRev !== d.rev) {
      for (const id of inflightPages.values()) mac.core.cancel(id);
      inflightPages.clear();
      pageAsked.clear();
      inflightRev = d.rev;
    }
    const t = tops();
    const here = Math.max(0, scroller.offset());
    const at = Math.max(0, aim());
    const forward = scroller.velocity() >= 0 ? 1 : -1;
    const firstPage = Math.floor(rowAtY(t, Math.min(here, at) - OVERSCAN) / PAGE_ROWS);
    const lastPage = Math.floor(rowAtY(t, Math.max(here, at) + DOC_VIEW_H + OVERSCAN) / PAGE_ROWS);
    const lastAll = Math.floor((d.rows - 1) / PAGE_ROWS);
    const wanted = new Set<number>();
    for (let page = firstPage; page <= lastPage; page++) wanted.add(page);
    const extra = forward > 0 ? lastPage + 1 : firstPage - 1;
    if (extra >= 0 && extra <= lastAll) wanted.add(extra);
    for (const [page, id] of inflightPages) {
      if (!wanted.has(page)) {
        mac.core.cancel(id);
        inflightPages.delete(page);
      }
    }
    if (ahead()) return;
    let issued = 0;
    for (const page of wanted) {
      if (issued >= PAGES_PER_FRAME_MAX || inflightPages.size >= PAGES_INFLIGHT_MAX) break;
      if (page < 0 || page > lastAll || inflightPages.has(page) || !pageMissing(page, d.rows)) continue;
      const asked = pageAsked.get(page);
      if (asked !== undefined && frameCount - asked < PAGE_RETRY_FRAMES) continue;
      requestPage(d, page);
      issued += 1;
    }
  });

  const visibleRange = createMemo<readonly [number, number]>(() => {
    const d = doc();
    if (!d || d.rows === 0) return [0, -1];
    const t = tops();
    const off = scroller.offset();
    return [rowAtY(t, off - OVERSCAN), rowAtY(t, off + DOC_VIEW_H + OVERSCAN)];
  });

  // ── row surgery: the local half of editing ────────────────────────────────

  /** The cached row range of one source line, or null when it is not held. */
  const rowsOfLine = (line: number): [first: number, count: number] | null => {
    let first = -1;
    let last = -1;
    for (const [index, row] of rowCache) {
      if (row.l !== line) continue;
      if (first < 0 || index < first) first = index;
      if (index > last) last = index;
    }
    return first < 0 ? null : [first, last - first + 1];
  };

  /** The source text of a cached line, read back through the row mapping. */
  const textOfLine = (line: number): string | null => {
    const span = rowsOfLine(line);
    if (!span) return null;
    let text = "";
    for (let i = span[0]; i < span[0] + span[1]; i++) {
      const row = rowCache.get(i);
      if (!row) return null;
      text += rowSourceText(row);
    }
    return text;
  };

  const kindOfLine = (line: number): number => {
    const span = rowsOfLine(line);
    return span === null ? 0 : (rowCache.get(span[0])?.k ?? 0);
  };

  /** Replace `removed` rows at `row0` with the rows of `lines`, shifting
   *  every cached row after by the difference, and splice the kinds string
   *  the prefix sum runs over. `lineDelta` is the change in line count. */
  const spliceRowsWith = (row0: number, removed: number, fresh: readonly Row[], lineDelta: number): void => {
    const d = doc();
    if (!d) return;
    let digits = "";
    for (const row of fresh) digits += KIND_CHARS[row.k];
    const delta = fresh.length - removed;
    if (delta !== 0) {
      const shifted = new Map<number, Row>();
      for (const [index, row] of rowCache) {
        if (index < row0) shifted.set(index, row);
        else if (index >= row0 + removed) shifted.set(index + delta, row);
      }
      rowCache.clear();
      for (const [index, row] of shifted) rowCache.set(index, row);
    }
    fresh.forEach((row, i) => rowCache.set(row0 + i, row));
    if (lineDelta !== 0) {
      for (const [index, row] of rowCache) {
        if (index >= row0 + fresh.length) row.l += lineDelta;
      }
    }
    const kinds = d.kinds.slice(0, row0) + digits + d.kinds.slice(row0 + removed);
    batch(() => {
      setDoc({ ...d, kinds, rows: d.rows + delta, lines: d.lines + lineDelta });
      setRowsRev((n) => n + 1);
    });
  };

  /** Lay the given lines out locally and splice their rows in. */
  const spliceRows = (
    row0: number,
    removed: number,
    lines: ReadonlyArray<{ line: number; kind: number; text: string }>,
    lineDelta: number,
  ): void => {
    const fresh: Row[] = [];
    for (const line of lines) {
      for (const row of layoutLine(line.text, line.line, line.kind, measure)) fresh.push(row);
    }
    spliceRowsWith(row0, removed, fresh, lineDelta);
  };

  /**
   * Take the companion's rows for the lines its patch just laid out,
   * line by line, over the guest's own range for each. Replacing a line in
   * place is idempotent and self-correcting: whatever the guest guessed for
   * that line, the companion's version replaces it exactly, and the row
   * indices of every other line stay where they are.
   *
   * This is what keeps optimistic editing honest without a full resync — a
   * span's `removed` counts the companion's rows before ITS edit, which is
   * not the guest's count after the guest already applied the same edit.
   */
  const adoptLineRows = (patch: Patch): void => {
    const byLine = new Map<number, Row[]>();
    for (const span of patch.spans) {
      for (const row of span.rows) {
        const list = byLine.get(row.l);
        if (list) list.push(row);
        else byLine.set(row.l, [row]);
      }
    }
    for (const line of [...byLine.keys()].sort((a, b) => a - b)) {
      const span = rowsOfLine(line);
      if (!span) continue;
      spliceRowsWith(span[0], span[1], byLine.get(line)!, 0);
    }
  };

  // ── the caret ─────────────────────────────────────────────────────────────

  const caretRow = (): number => {
    const c = caret();
    if (!c) return -1;
    const span = rowsOfLine(c.line);
    if (!span) return -1;
    let best = span[0];
    for (let i = span[0]; i < span[0] + span[1]; i++) {
      const row = rowCache.get(i);
      if (row && row.s <= c.col) best = i;
    }
    return best;
  };

  const revealCaret = (): void => {
    const row = caretRow();
    if (row < 0) return;
    const t = tops();
    const top = t[row] ?? 0;
    const bottom = t[row + 1] ?? top + 18;
    const off = scroller.intent();
    if (top < off + 6) scroller.scrollTo(Math.max(0, top - 6));
    else if (bottom > off + DOC_VIEW_H - 6) scroller.scrollTo(bottom - DOC_VIEW_H + 6);
  };

  const clearSelection = (): void => {
    setAnchor(null);
  };

  // ── patches ───────────────────────────────────────────────────────────────

  /** Whether the guest's own rows are the newer ones. Local surgery keeps
   *  this true; a whole re-layout arriving mid-flight (a fence or the front
   *  matter changed classification) throws the guest's rows away, and from
   *  then on the companion's spans are the authority until the queue
   *  drains. */
  let localRowsValid = true;

  /** Drop the row cache, take the patch's caret and text, and read the
   *  note's summary again — the honest recovery when the guest's rows and
   *  the companion's layout have diverged. */
  const hardResync = (patch: Patch): void => {
    pageAsked.clear();
    // A resync should be rare; set __vaultTrace to see why one happened
    // (`probe --eval 'globalThis.__vaultTrace = true'` on the console).
    if ((globalThis as { __vaultTrace?: boolean }).__vaultTrace) {
      console.log(
        `vault: resync — rows ${doc()?.kinds.length} local vs ${patch.total} companion` +
          `${patch.text === localText ? "" : ", line text differs"}`,
      );
    }
    rowCache.clear();
    activeLine = patch.caret[0];
    localText = patch.text;
    localRowsValid = true;
    batch(() => {
      setCaret({ line: patch.caret[0], col: patch.caret[1] });
      setRowsRev((n) => n + 1);
    });
    info.refetch();
  };

  const applyPatch = (patch: Patch, local = false): void => {
    const d = doc();
    if (!d) return;
    const settled = !ahead();
    if (patch.full) {
      // The whole note was laid out again. Its rows replace the guest's,
      // including the lines the guest had edited locally.
      rowCache.clear();
      batch(() => {
        setDoc(patch.full!);
        setRowsRev((n) => n + 1);
      });
      if (settled) {
        activeLine = patch.caret[0];
        localText = patch.text;
        localRowsValid = true;
        setCaret({ line: patch.caret[0], col: patch.caret[1] });
      } else {
        // Edits are still queued: this layout is behind them, so the guest
        // keeps its caret and text and stops claiming its rows are newer.
        localRowsValid = false;
      }
      revealCaret();
      return;
    }
    if (localRowsValid && (local || !settled)) {
      if (!settled) {
        // More edits are queued: this patch is behind them, so only its
        // bookkeeping is useful.
        setDoc({ ...d, rows: patch.total, map: patch.map, rev: patch.rev });
        return;
      }
      // Settled: adopt the companion's rows for the lines it laid out, so
      // the guest's optimistic guess gives way to the authority, line by
      // line.
      adoptLineRows(patch);
      const now = doc()!;
      setDoc({ ...now, rows: patch.total, map: patch.map, rev: patch.rev });
      // The valve: the row count must now be the companion's.
      if (now.kinds.length !== patch.total || patch.text !== localText) hardResync(patch);
      return;
    }
    batch(() => {
      let kinds = d.kinds;
      for (const span of patch.spans) {
        kinds = kinds.slice(0, span.row0) + span.kinds + kinds.slice(span.row0 + span.removed);
        const delta = span.rows.length - span.removed;
        if (delta !== 0) {
          const shifted = new Map<number, Row>();
          for (const [index, row] of rowCache) {
            if (index < span.row0) shifted.set(index, row);
            else if (index >= span.row0 + span.removed) shifted.set(index + delta, row);
          }
          rowCache.clear();
          for (const [index, row] of shifted) rowCache.set(index, row);
        }
        span.rows.forEach((row, i) => rowCache.set(span.row0 + i, row));
      }
      setDoc({ ...d, kinds, rows: patch.total, map: patch.map, rev: patch.rev });
      if (settled) setCaret({ line: patch.caret[0], col: patch.caret[1] });
      setRowsRev((n) => n + 1);
    });
    if (settled) {
      activeLine = patch.caret[0];
      localText = patch.text;
      localRowsValid = true;
    }
    if ((doc()?.kinds.length ?? 0) !== patch.total) hardResync(patch);
    revealCaret();
  };

  const flush = (): void => {
    if (inflight !== null || queue.length === 0) return;
    const d = doc();
    if (!d) {
      queue.length = 0;
      setUnconfirmed(0);
      return;
    }
    const op = queue.shift()!;
    inflight = op;
    seq += 1;
    count("doc.edit");
    mac.call<Patch>("doc.edit", { id: d.id, seq, from: op.from, to: op.to, text: op.text }).then(
      (patch) => {
        stats.replies += 1;
        inflight = null;
        setUnconfirmed(queue.length);
        applyPatch(patch, op.local);
        flush();
      },
      (error) => {
        inflight = null;
        setUnconfirmed(queue.length);
        fail(error);
        flush();
      },
    );
  };

  /** Queue one range replacement, coalescing a run of typing or deleting at
   *  the same spot into the request already waiting. */
  const enqueue = (op: EditOp): void => {
    const last = queue[queue.length - 1];
    if (last && last.local === op.local && last.from[0] === op.from[0] && !op.text.includes("\n") && !last.text.includes("\n")) {
      const typing =
        last.text !== "" &&
        op.text !== "" &&
        last.from[1] === last.to[1] &&
        op.from[1] === op.to[1] &&
        op.from[1] === last.from[1] + last.text.length;
      const deleting = last.text === "" && op.text === "" && op.to[1] === last.from[1];
      if (typing) {
        last.text += op.text;
        return;
      }
      if (deleting) {
        last.from = op.from;
        return;
      }
    }
    queue.push(op);
    setUnconfirmed(queue.length + (inflight ? 1 : 0));
    flush();
  };

  const normalizedSelection = (): [Pos, Pos] | null => {
    const a = anchor();
    const c = caret();
    if (!a || !c || (a.line === c.line && a.col === c.col)) return null;
    const first: Pos = [a.line, a.col];
    const second: Pos = [c.line, c.col];
    return first[0] < second[0] || (first[0] === second[0] && first[1] <= second[1])
      ? [first, second]
      : [second, first];
  };

  /** A single-line replacement, applied locally and then queued. */
  const localReplace = (line: number, from: number, to: number, text: string): void => {
    if (localText === null) return;
    const span = rowsOfLine(line);
    if (!span) return;
    const next = localText.slice(0, from) + text + localText.slice(to);
    const kind = reKind(next, kindOfLine(line));
    localText = next;
    spliceRows(span[0], span[1], [{ line, kind, text: next }], 0);
    clearSelection();
    setCaret({ line, col: from + text.length });
    revealCaret();
    enqueue({ from: [line, from], to: [line, to], text, local: true });
  };

  /** Split the caret's line locally, then queue the newline. */
  const localSplit = (line: number, col: number): void => {
    if (localText === null) return;
    const span = rowsOfLine(line);
    if (!span) return;
    const head = localText.slice(0, col);
    const tail = localText.slice(col);
    const headKind = reKind(head, kindOfLine(line));
    const tailKind = reKind(tail, headKind);
    spliceRows(
      span[0],
      span[1],
      [
        { line, kind: headKind, text: head },
        { line: line + 1, kind: tailKind, text: tail },
      ],
      1,
    );
    activeLine = line + 1;
    localText = tail;
    clearSelection();
    setCaret({ line: line + 1, col: 0 });
    revealCaret();
    enqueue({ from: [line, col], to: [line, col], text: "\n", local: true });
  };

  /** Join the caret's line onto the one above locally, then queue it. */
  const localJoin = (line: number): void => {
    if (localText === null || line === 0) return;
    const above = rowsOfLine(line - 1);
    const here = rowsOfLine(line);
    const previous = textOfLine(line - 1);
    if (previous === null || !above || !here) {
      // Without the line above there is nothing to join locally; the
      // companion does it and its patch corrects the screen.
      enqueue({ from: [line - 1, END_OF_LINE], to: [line, 0], text: "", local: false });
      return;
    }
    const merged = previous + localText;
    const kind = reKind(merged, kindOfLine(line - 1));
    spliceRows(above[0], above[1] + here[1], [{ line: line - 1, kind, text: merged }], -1);
    activeLine = line - 1;
    localText = merged;
    clearSelection();
    setCaret({ line: line - 1, col: previous.length });
    revealCaret();
    enqueue({ from: [line - 1, previous.length], to: [line, 0], text: "", local: true });
  };

  const insert = (text: string): void => {
    const c = caret();
    if (!doc() || !c || activeLine !== c.line || localText === null) return;
    const selection = normalizedSelection();
    if (selection && selection[0][0] !== selection[1][0]) {
      // A selection across lines needs the lines between it; the companion
      // owns that case, and the selection stays visible until its patch.
      clearSelection();
      enqueue({ from: selection[0], to: selection[1], text, local: false });
      return;
    }
    if (text === "\n") {
      if (selection) localReplace(c.line, selection[0][1], selection[1][1], "");
      const at = caret();
      if (at) localSplit(at.line, at.col);
      return;
    }
    if (selection) localReplace(c.line, selection[0][1], selection[1][1], text);
    else localReplace(c.line, c.col, c.col, text);
  };

  const backspace = (): void => {
    const c = caret();
    if (!doc() || !c || activeLine !== c.line || localText === null) return;
    const selection = normalizedSelection();
    if (selection) {
      if (selection[0][0] !== selection[1][0]) {
        clearSelection();
        enqueue({ from: selection[0], to: selection[1], text: "", local: false });
        return;
      }
      localReplace(c.line, selection[0][1], selection[1][1], "");
      return;
    }
    if (c.col > 0) {
      localReplace(c.line, c.col - 1, c.col, "");
      return;
    }
    localJoin(c.line);
  };

  /** Adopt a line as the caret's: its text comes from the rows when they are
   *  cached, and from the companion when they are not. */
  const adopt = (line: number, col: number): void => {
    const text = textOfLine(line);
    activeLine = line;
    if (text !== null) {
      localText = text;
      setCaret({ line, col: col === END_OF_LINE ? text.length : Math.min(col, text.length) });
      return;
    }
    localText = null;
    setCaret({ line, col: col === END_OF_LINE ? 0 : col });
    const d = doc();
    if (!d) return;
    count("doc.line");
    mac.call<LineResult>("doc.line", { id: d.id, line }).then((result) => {
      stats.replies += 1;
      if (activeLine !== result.line) return;
      localText = result.text;
      if (col === END_OF_LINE) setCaret({ line: result.line, col: result.text.length });
    }, fail);
  };

  const moveCaret = (dx: number, dy: number): void => {
    const c = caret();
    const d = doc();
    if (!c || !d) return;
    if (selecting() && !anchor()) setAnchor({ ...c });
    if (!selecting()) clearSelection();
    if (dy !== 0) {
      const row = caretRow();
      if (row < 0) return;
      const target = row + dy;
      if (target < 0 || target >= d.rows) return;
      const targetRow = rowCache.get(target);
      const here = rowCache.get(row);
      if (!targetRow || !here) return;
      const x = caretX(here, c.col, measure) ?? 0;
      const col = colAtX(targetRow, x, measure);
      if (targetRow.l === c.line) setCaret({ line: c.line, col });
      else adopt(targetRow.l, col);
      revealCaret();
      return;
    }
    const length = localText?.length ?? 0;
    const col = c.col + dx;
    if (col >= 0 && col <= length) {
      setCaret({ line: c.line, col });
      revealCaret();
      return;
    }
    if (dx < 0 && c.line > 0) adopt(c.line - 1, END_OF_LINE);
    else if (dx > 0 && c.line + 1 < d.lines) adopt(c.line + 1, 0);
    revealCaret();
  };

  const caretToRow = (rowIndex: number, x: number): void => {
    const row = rowCache.get(rowIndex);
    if (!row) return;
    if (selecting() && !anchor()) {
      const c = caret();
      if (c) setAnchor({ ...c });
    } else if (!selecting()) clearSelection();
    const col = colAtX(row, x, measure);
    if (row.l === activeLine) setCaret({ line: row.l, col });
    else adopt(row.l, col);
    revealCaret();
  };

  // ── files ─────────────────────────────────────────────────────────────────
  const invalidateVault = (): void => {
    treeCache.clear();
    listCache.clear();
    batch(() => {
      setTreeRev((n) => n + 1);
      setListRev((n) => n + 1);
    });
  };

  const newNote = (): void => {
    const stamp = new Date().toISOString().slice(5, 16).replace("T", " ");
    count("vault.create");
    mac.call<{ id: number }>("vault.create", { folder: folder(), title: `Note ${stamp}` }).then((made) => {
      stats.replies += 1;
      invalidateVault();
      store.openNote(made.id);
      store.enterEdit();
    }, fail);
  };

  const newFolder = (): void => {
    const count0 = treeRows().filter((row) => row.entry.folder).length + 1;
    count("vault.mkdir");
    mac.call("vault.mkdir", { folder: folder(), name: `Folder ${count0}` }).then(() => {
      stats.replies += 1;
      invalidateVault();
    }, fail);
  };

  const [deleteArmed, setDeleteArmed] = createSignal(false);
  let deleteArmedAt = -1000;

  const deleteNote = (): void => {
    const d = doc();
    if (!d) return;
    setDeleteArmed(false);
    count("vault.delete");
    mac.call("vault.delete", { id: d.id }).then(() => {
      stats.replies += 1;
      rowCache.clear();
      batch(() => {
        setOpenId(null);
        setDoc(null);
        setCaret(null);
        setDeckSignal("browse");
        setRowsRev((n) => n + 1);
      });
      activeLine = null;
      localText = null;
      invalidateVault();
    }, fail);
  };

  // ── the held-shoulder menus ───────────────────────────────────────────────
  const [menu, setMenu] = createSignal<MenuId | null>(null);
  const [menuIndex, setMenuIndex] = createSignal(0);
  const VAULT_ITEMS: MenuItem[] = [
    { label: "New note", hint: "A", run: () => newNote() },
    { label: "New folder", run: () => newFolder() },
    { label: "Search vault", run: () => setDeckSignal("search") },
    { label: "Files", run: () => store.setTab("files") },
    { label: "Tags", run: () => store.setTab("tags") },
  ];
  const ACTION_ITEMS: MenuItem[] = [
    { label: "Edit note", hint: "X", run: () => store.enterEdit() },
    { label: "Toggle task", run: () => store.toggleTask() },
    { label: "Outline & links", hint: "Y", run: () => store.setTab("links") },
    { label: "Save now", hint: "START", run: () => store.save() },
    { label: "Delete note", run: () => store.armDelete() },
  ];
  const menuItems = createMemo<readonly MenuItem[]>(() => (menu() === "vault" ? VAULT_ITEMS : ACTION_ITEMS));

  // ── per-frame input ───────────────────────────────────────────────────────
  let prevButtons = 0;
  let heldFrames = 0;
  let shoulderFrames = 0;
  let shoulder: MenuId | null = null;
  const repeatable = BTN.UP | BTN.DOWN | BTN.LEFT | BTN.RIGHT;

  const frame = (buttons: number): void => {
    frameCount += 1;
    scroller.step();
    if (deleteArmed() && frameCount - deleteArmedAt > DELETE_ARMED_FRAMES) setDeleteArmed(false);
    const pressed = buttons & ~prevButtons;
    const released = prevButtons & ~buttons;
    prevButtons = buttons;

    // A shoulder tapped turns a page; held, it opens its menu.
    if (pressed & BTN.LTRIGGER) {
      shoulder = "vault";
      shoulderFrames = 0;
    } else if (pressed & BTN.RTRIGGER) {
      shoulder = "actions";
      shoulderFrames = 0;
    }
    if (shoulder !== null && buttons & (shoulder === "vault" ? BTN.LTRIGGER : BTN.RTRIGGER)) {
      shoulderFrames += 1;
      if (shoulderFrames === HOLD_FRAMES) store.openMenu(shoulder);
    }
    if (released & (BTN.LTRIGGER | BTN.RTRIGGER)) {
      const which: MenuId = released & BTN.LTRIGGER ? "vault" : "actions";
      if (menu() === which) store.closeMenu();
      else if (shoulder === which && shoulderFrames < HOLD_FRAMES) store.pageBy(which === "vault" ? -1 : 1);
      shoulder = null;
      shoulderFrames = 0;
    }

    if (menu() !== null) {
      if (pressed & BTN.UP) store.moveMenu(-1);
      if (pressed & BTN.DOWN) store.moveMenu(1);
      if (pressed & BTN.CIRCLE) store.runMenu();
      if (pressed & BTN.CROSS) store.closeMenu();
      return;
    }

    if (deck() === "edit") {
      const held = buttons & repeatable;
      let fire = pressed & repeatable;
      if (held && !(pressed & repeatable)) {
        heldFrames += 1;
        if (heldFrames >= REPEAT_DELAY && (heldFrames - REPEAT_DELAY) % REPEAT_EVERY === 0) fire = held;
      } else heldFrames = 0;
      if (fire & BTN.UP) moveCaret(0, -1);
      if (fire & BTN.DOWN) moveCaret(0, 1);
      if (fire & BTN.LEFT) moveCaret(-1, 0);
      if (fire & BTN.RIGHT) moveCaret(1, 0);
      if (pressed & BTN.CROSS) store.leaveEdit();
      if (pressed & BTN.TRIANGLE) store.setSelecting(!selecting());
      if (pressed & BTN.START) store.save();
      return;
    }

    if (buttons & BTN.UP) scroller.nudge(-6);
    if (buttons & BTN.DOWN) scroller.nudge(6);
    if (pressed & BTN.TRIANGLE) store.enterEdit();
    if (pressed & BTN.SQUARE) store.setTab(tab() === "links" ? "files" : "links");
    if (pressed & BTN.START) store.save();
    if (pressed & BTN.CROSS && deck() === "search") setDeckSignal("browse");
  };

  const linkLabel = createMemo(() => {
    const status = mac.status();
    if (status === "absent") return "no svc mailbox on this host";
    if (status === "searching") return "looking for the companion";
    return `linked to ${mac.name()}`;
  });

  const store: VaultStore = {
    mac,
    linkLabel,
    lastError,
    stats: () => stats,
    deck,
    setDeck: (next) => {
      if (next !== "edit" && deck() === "edit") store.leaveEdit();
      if (next === "edit") store.enterEdit();
      else setDeckSignal(next);
    },
    tab,
    setTab: (next) => {
      batch(() => {
        setTabSignal(next);
        if (deck() !== "browse") setDeckSignal("browse");
      });
    },
    treeRows,
    expanded,
    toggleFolder: (path) => {
      setExpandedSet((open) => (open.includes(path) ? open.filter((entry) => entry !== path) : [...open, path]));
      setTreeRev((n) => n + 1);
    },
    folder,
    setFolder: (path) => setFolderSignal(path),
    query,
    setQuery,
    tag,
    setTag,
    tags: () => tagsQuery() ?? [],
    listTotal,
    listItem: (index) => {
      void listRev();
      return listCache.get(index);
    },
    setListViewport: (first) => setListFirst(first),
    selected,
    select: (index) => {
      setSelected(index);
      const item = listCache.get(index);
      if (item) store.openNote(item.id);
    },
    openNote: (id) => {
      if (openId() === id) return;
      rowCache.clear();
      queue.length = 0;
      inflight = null;
      activeLine = null;
      localText = null;
      batch(() => {
        setCaret(null);
        setAnchor(null);
        setUnconfirmed(0);
        setOpenId(id);
        setDoc(null);
        setRowsRev((n) => n + 1);
      });
      scroller.scrollTo(0, { immediate: true });
    },
    doc,
    tops,
    docHeight,
    rowAt: (index) => {
      void rowsRev();
      return rowCache.get(index);
    },
    rowsRev,
    scroller,
    visibleRange,
    outline: () => outlineQuery() ?? [],
    links: linksQuery,
    jumpToRow: (row) => {
      const t = tops();
      if (row < 0 || row >= t.length - 1) return;
      scroller.scrollTo(Math.max(0, t[row]! - 6));
    },
    jumpToLine: (line) => {
      const span = rowsOfLine(line);
      if (span) store.jumpToRow(span[0]);
    },
    scrollFraction: () => {
      const max = Math.max(1, docHeight() - DOC_VIEW_H);
      return Math.max(0, Math.min(1, scroller.offset() / max));
    },
    scrollToFraction: (f) => {
      const max = Math.max(0, docHeight() - DOC_VIEW_H);
      scroller.scrollTo(Math.max(0, Math.min(1, f)) * max, { immediate: true });
    },
    pageBy: (direction) => scroller.scrollBy(direction * PAGE_PX),
    page: () => Math.min(store.pages(), Math.floor(scroller.offset() / Math.max(1, PAGE_PX)) + 1),
    pages: () => Math.max(1, Math.ceil(docHeight() / Math.max(1, PAGE_PX))),
    caret,
    anchor,
    selecting,
    setSelecting: (on) => {
      setSelectingSignal(on);
      const c = caret();
      if (on && c) setAnchor({ ...c });
      if (!on) clearSelection();
    },
    enterEdit: () => {
      const d = doc();
      if (!d || d.rows === 0) return;
      setDeckSignal("edit");
      const c = caret();
      if (c && activeLine === c.line && localText !== null) return;
      const row = rowCache.get(rowAtY(tops(), scroller.offset() + 6));
      if (row) adopt(row.l, row.s);
    },
    leaveEdit: () => {
      clearSelection();
      setSelectingSignal(false);
      setDeckSignal("browse");
      store.save();
    },
    insert,
    backspace,
    moveCaret,
    caretToRow,
    toggleTask: () => {
      const d = doc();
      if (!d) return;
      const c = caret();
      const line = c ? c.line : (rowCache.get(rowAtY(tops(), scroller.offset() + 6))?.l ?? 0);
      count("doc.task");
      mac.call<Patch>("doc.task", { id: d.id, line }).then((patch) => {
        stats.replies += 1;
        applyPatch(patch);
      }, fail);
    },
    kbLayer,
    setKbLayer,
    activeText: () => localText ?? "",
    unconfirmed,
    save: () => {
      const d = doc();
      if (d) mac.send("doc.save", { id: d.id });
    },
    newNote,
    newFolder,
    deleteArmed,
    armDelete: () => {
      if (!doc()) return;
      deleteArmedAt = frameCount;
      setDeleteArmed(true);
    },
    deleteNote,
    menu,
    menuIndex,
    menuItems,
    openMenu: (id) => {
      batch(() => {
        setMenu(id);
        setMenuIndex(0);
      });
    },
    closeMenu: () => setMenu(null),
    moveMenu: (delta) => {
      const items = menuItems();
      setMenuIndex((index) => (index + delta + items.length) % items.length);
    },
    runMenu: (index) => {
      const items = menuItems();
      const item = items[index ?? menuIndex()];
      setMenu(null);
      item?.run();
    },
    frame,
  };
  return store;
}
