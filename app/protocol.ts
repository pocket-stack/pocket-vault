// app/protocol.ts — what the guest and the companion agree on: the row model
// a laid-out note is delivered in, the method names with their parameter and
// result shapes, and the geometry both sides measure against. Imported by
// app/ (the 3DS guest) and host/ (the Mac companion); nothing else.
//
// The document is WYSIWYG in the Bear/Typora sense: markdown renders styled
// and its syntax markers stay on screen, dimmed. That is a deliberate choice
// over hiding them, because it makes the source↔screen mapping TOTAL — every
// source character has a position on screen — and a total mapping is what
// lets the caret live on a styled row. There is no "show the raw line while
// editing" mode: a line looks the same whether or not the caret is in it, so
// rows never reflow under the caret.
//
// Two substitutions break the one-to-one rule, and both carry the source text
// they stand for so the mapping stays total: a list bullet ("- " → "•") and a
// task checkbox ("- [x] " → a drawn box). The caret snaps to either edge of a
// substitution and never inside it.
//
// The companion breaks a note into visual ROWS with the device's own glyph
// advances (app/linewrap.ts, shared by both sides), so the guest never
// measures a document — it places rows by a prefix sum over per-kind heights
// and paints the runs it is given. The guest re-lays out ONE line, the one it
// is editing, with the same shared code.

export const VAULT_APP = "vault";

export const STAGE_W = 400;
export const STAGE_H = 240;
export const DECK_W = 320;
export const DECK_H = 240;

/** Height of the top screen's navigation bar. */
export const NAV_H = 30;
/** The document's viewport on the top screen. */
export const DOC_TOP = NAV_H;
export const DOC_VIEW_H = STAGE_H - DOC_TOP;
/** Horizontal padding of the document. */
export const DOC_PAD_X = 12;
/** The width rows are broken to. */
export const DOC_W = STAGE_W - DOC_PAD_X * 2;
/** Indent of list content, quote content and continuation rows. */
export const INDENT = 14;
/** Screen width a task checkbox occupies, including its gap. */
export const TASK_W = 17;

// ── Row kinds ──────────────────────────────────────────────────────────────
// One base-36 digit per row in DocInfo.kinds; the guest's prefix sum runs
// over ROW_H by kind. Kinds are presentational: two source lines with the
// same kind lay out the same way.

export const K_P = 0;
export const K_H1 = 1;
export const K_H2 = 2;
export const K_H3 = 3;
export const K_LI = 4;
export const K_TASK = 5;
export const K_CODE = 6;
export const K_QUOTE = 7;
export const K_BLANK = 8;
export const K_HR = 9;
export const K_META = 10;
export const K_TABLE = 11;
export const KIND_COUNT = 12;

export const KIND_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Row height by kind, logical px. */
export const ROW_H: readonly number[] = [
  18, // P
  32, // H1: 20 px bold, with space above
  27, // H2: 18 px bold
  23, // H3: 16 px bold
  18, // LI
  20, // TASK: the checkbox needs the extra two
  18, // CODE (mono 14)
  18, // QUOTE
  8, //  BLANK
  12, // HR
  15, // META (12 px)
  18, // TABLE (mono 14)
];

/** Text top offset inside the row by kind. */
export const ROW_TEXT_TOP: readonly number[] = [1, 11, 8, 5, 1, 2, 1, 1, 0, 0, 1, 1];

/** Font px by kind. An inline run may change face, never size. */
export const ROW_PX: readonly number[] = [14, 20, 18, 16, 14, 14, 14, 14, 14, 14, 12, 14];

/** Kinds whose default face is monospace. */
export function kindIsMono(kind: number): boolean {
  return kind === K_CODE || kind === K_TABLE;
}

/** Kinds that draw as a bordered block, merged across adjacent rows of the
 *  same kind (a code block, a callout). */
export function kindIsBoxed(kind: number): boolean {
  return kind === K_CODE || kind === K_QUOTE || kind === K_TASK;
}

// ── Run styles (bit flags) ─────────────────────────────────────────────────

export const S_BOLD = 1;
export const S_ITALIC = 2;
export const S_CODE = 4;
export const S_LINK = 8;
export const S_WIKI = 16;
/** Syntax the source carries and the screen dims: #, **, [[, ]], >, `. */
export const S_MARK = 32;
export const S_STRIKE = 64;
export const S_TAG = 128;
/** A drawn checkbox, TASK_W wide, with no text of its own. */
export const S_TASK = 256;
export const S_TASK_DONE = 512;

/**
 * A styled run: screen x within the row, the screen text, style flags, the
 * source column its first character comes from, and — only when the screen
 * text stands in for different source text — that source text. A run with
 * S_TASK has empty text and occupies TASK_W.
 */
export type Run = [x: number, text: string, style: number, src: number, srcText?: string];

export interface Row {
  /** Kind (K_*). */
  k: number;
  /** Source line index. */
  l: number;
  /** Source column the row starts at (its first run's `src`). */
  s: number;
  r: Run[];
}

/** The source text a run stands for. */
export function runSource(run: Run): string {
  return run[4] ?? run[1];
}

/** Whether the caret may sit inside this run, or only at its edges. */
export function runIsAtomic(run: Run): boolean {
  return run[4] !== undefined || (run[2] & S_TASK) !== 0;
}

// ── The vault ──────────────────────────────────────────────────────────────

export interface TreeEntry {
  /** Vault-relative path: "01 Projects" or "01 Projects/roadmap.md". */
  path: string;
  /** Display name, without the .md. */
  name: string;
  folder: boolean;
  /** Notes inside, for a folder. */
  count?: number;
  /** Note id, for a note. */
  id?: number;
}

export interface TreeParams {
  /** "" for the vault root. */
  folder: string;
  /** Entries to return. Folders come first, so they are never cut. */
  limit?: number;
}

export interface TreeResult {
  folder: string;
  entries: TreeEntry[];
  /** Children the folder has; `entries` may be a prefix of them. A folder
   *  with hundreds of notes is browsed in the note list, not the tree — the
   *  tree is a navigator, and one reply must fit the wire. */
  total: number;
}

export interface ListParams {
  q?: string;
  /** Restrict to a folder and its subfolders. */
  folder?: string;
  /** Restrict to notes carrying this tag. */
  tag?: string;
  offset: number;
  limit: number;
}

export interface ListItem {
  id: number;
  title: string;
  /** First prose line, for the deck's second row. */
  snippet: string;
  /** Bytes. */
  size: number;
  /** Modification time, ms. */
  mtime: number;
}

export interface ListResult {
  total: number;
  items: ListItem[];
  /** Index version; bumps when the vault changes on disk. */
  version: number;
}

export interface TagItem {
  tag: string;
  count: number;
}

export interface LinkItem {
  /** The link's text as written. */
  title: string;
  /** Resolved note, or null for a link with no note behind it yet. */
  id: number | null;
  /** Source line the link sits on, for outgoing links. */
  line?: number;
}

export interface LinksResult {
  out: LinkItem[];
  back: LinkItem[];
}

export interface OpenParams {
  id: number;
}

/** The density map's bucket count; one base-36 digit per bucket. */
export const MAP_BUCKETS = 96;

export interface DocInfo {
  id: number;
  title: string;
  path: string;
  /** Visual row count. */
  rows: number;
  /** Source line count. */
  lines: number;
  /** One KIND_CHARS digit per row. */
  kinds: string;
  /** MAP_BUCKETS digits of ink density, 0..z. */
  map: string;
  /** Layout revision; rows fetched under another revision are stale. */
  rev: number;
}

export interface RowsParams {
  id: number;
  from: number;
  count: number;
  rev: number;
}

export interface RowsResult {
  from: number;
  rev: number;
  rows: Row[];
}

export interface OutlineItem {
  row: number;
  level: number;
  text: string;
}

/** A position in the source: line index and UTF-16 column. Columns are
 *  clamped to the line by the companion, so END_OF_LINE names a line's end
 *  without knowing its length. */
export type Pos = [line: number, col: number];
export const END_OF_LINE = 1 << 20;

export interface LineParams {
  id: number;
  line: number;
}

export interface LineResult {
  line: number;
  text: string;
  rev: number;
}

export interface EditParams {
  id: number;
  /** Per-guest-session edit counter. A re-sent edit (the link dropped after
   *  the companion applied it) is answered with the same patch again and not
   *  applied twice. */
  seq: number;
  /** Replace [from, to) with `text`. from === to inserts; text "" deletes;
   *  "\n" in text splits; a range across lines joins. */
  from: Pos;
  to: Pos;
  text: string;
}

/** One replaced range of visual rows. */
export interface Span {
  /** First visual row replaced. */
  row0: number;
  /** Visual rows removed at row0. */
  removed: number;
  /** Kinds of the rows inserted at row0. */
  kinds: string;
  rows: Row[];
}

/** What doc.edit returns: the row ranges that changed, applied in order
 *  (each span's row0 is in the coordinates that hold after the spans before
 *  it), or a whole new layout when a fence or the front matter moved. */
export interface Patch {
  rev: number;
  spans: Span[];
  /** New total row count. */
  total: number;
  map: string;
  /** Caret after the edit: source line and column. */
  caret: Pos;
  /** The caret line's source text after the edit. */
  text: string;
  /** Echo of EditParams.seq. */
  seq?: number;
  /** Set when the whole document was laid out again; the guest drops every
   *  cached row and re-reads DocInfo from here. */
  full?: DocInfo;
}

export interface CreateParams {
  folder: string;
  title: string;
  /** Initial body; an H1 for the title is added when absent. */
  body?: string;
}

export interface MkdirParams {
  folder: string;
  name: string;
}

export type VaultMethods = {
  "vault.tree": [TreeParams, TreeResult];
  "vault.list": [ListParams, ListResult];
  "vault.tags": [Record<string, never>, TagItem[]];
  "vault.create": [CreateParams, { id: number; path: string }];
  "vault.mkdir": [MkdirParams, { path: string }];
  "vault.delete": [OpenParams, { deleted: boolean }];
  "doc.open": [OpenParams, DocInfo];
  "doc.rows": [RowsParams, RowsResult];
  "doc.line": [LineParams, LineResult];
  "doc.outline": [OpenParams, OutlineItem[]];
  "doc.links": [OpenParams, LinksResult];
  "doc.edit": [EditParams, Patch];
  "doc.save": [OpenParams, { saved: boolean }];
};

/** Rows the guest asks for at once: a screen is ~13 body rows; this covers
 *  the screen plus the direction of travel, and stays one line on the wire. */
export const PAGE_ROWS = 32;
export const LIST_PAGE = 24;
/** Tree entries fetched per folder. */
export const TREE_LIMIT = 48;

/** Row heights → prefix sum of row tops (length rows + 1). */
export function rowTops(kinds: string): Int32Array {
  const tops = new Int32Array(kinds.length + 1);
  let y = 0;
  for (let i = 0; i < kinds.length; i++) {
    tops[i] = y;
    y += ROW_H[KIND_CHARS.indexOf(kinds[i]!)] ?? 18;
  }
  tops[kinds.length] = y;
  return tops;
}

/** Index of the row containing y (binary search over tops). */
export function rowAtY(tops: Int32Array, y: number): number {
  let lo = 0;
  let hi = tops.length - 2;
  if (hi < 0) return 0;
  if (y <= 0) return 0;
  if (y >= tops[hi + 1]!) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
