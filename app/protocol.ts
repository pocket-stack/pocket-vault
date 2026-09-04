// app/protocol.ts — what the guest and the companion agree on: the row model
// a laid-out note is delivered in, the method names and their parameter and
// result shapes, and the geometry both sides measure against. Imported by
// app/ (the 3DS guest) and host/ (the Mac companion); nothing else.
//
// The companion breaks a note into visual ROWS with the device's own glyph
// advances, so the guest never measures a document — it places rows by a
// prefix sum over per-kind heights and paints the runs it is given. A row
// remembers the source line it came from (`l`) and, for raw rows, the source
// column its first character sits at (`s`), which is how a caret on the
// screen becomes an edit in the file.

export const VAULT_APP = "vault";

export const STAGE_W = 400;
export const STAGE_H = 240;
export const DECK_W = 320;
export const DECK_H = 240;

/** Horizontal padding of the document on the top screen. */
export const DOC_PAD_X = 12;
/** The width rows are broken to. */
export const DOC_W = STAGE_W - DOC_PAD_X * 2;
/** Indent of list items and quotes, beyond the marker column. */
export const INDENT = 14;

// ── Row kinds ──────────────────────────────────────────────────────────────
// One base-36 digit per row in DocInfo.kinds; the guest's prefix sum runs
// over ROW_H by kind.

export const K_P = 0;
export const K_H1 = 1;
export const K_H2 = 2;
export const K_H3 = 3;
export const K_LI = 4;
export const K_CODE = 5;
export const K_QUOTE = 6;
export const K_BLANK = 7;
export const K_HR = 8;
export const K_META = 9;
/** The active source line in edit mode, shown as its raw markdown. */
export const K_RAW = 10;
export const KIND_COUNT = 11;

export const KIND_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Row height by kind, logical px. */
export const ROW_H: readonly number[] = [
  18, // P
  36, // H1: 20 px bold + space above
  30, // H2: 18 px bold
  26, // H3: 16 px bold
  18, // LI
  18, // CODE (mono 14)
  18, // QUOTE
  8, //  BLANK
  14, // HR
  16, // META (12 px)
  18, // RAW
];

/** Text top offset inside the row by kind. */
export const ROW_TEXT_TOP: readonly number[] = [1, 12, 8, 6, 1, 1, 1, 0, 0, 1, 1];

/** Font px by kind for measurement; inline runs may switch face, not size. */
export const ROW_PX: readonly number[] = [14, 20, 18, 16, 14, 14, 14, 0, 0, 12, 14];

// ── Run styles (bit flags) ─────────────────────────────────────────────────

export const S_BOLD = 1;
export const S_ITALIC = 2;
export const S_CODE = 4;
export const S_LINK = 8;
export const S_WIKI = 16;
/** A marker glyph: a list bullet, an ordinal, the quote bar column. */
export const S_MARK = 32;

/** x offset from the row's left edge (DOC_PAD_X already excluded), text,
 *  style flags. */
export type Run = [x: number, text: string, style: number];

export interface Row {
  /** Kind (K_*). */
  k: number;
  /** Source line index. */
  l: number;
  /** Source column of the first character (raw and code rows; 0 otherwise). */
  s: number;
  r: Run[];
}

// ── Methods ────────────────────────────────────────────────────────────────

export interface ListParams {
  q?: string;
  offset: number;
  limit: number;
}

export interface ListItem {
  id: number;
  title: string;
  /** Bytes. */
  size: number;
}

export interface ListResult {
  total: number;
  items: ListItem[];
  /** Index version; bumps when the vault changes on disk. */
  version: number;
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

export interface FocusParams {
  id: number;
  /** The line to show raw, or null to leave edit mode. */
  line: number | null;
}

/** A position in the source: line index and UTF-16 column. Columns are
 *  clamped to the line by the companion, so END_OF_LINE names a line's end
 *  without knowing its length. */
export type Pos = [line: number, col: number];
export const END_OF_LINE = 1 << 20;

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

/** What doc.focus and doc.edit return: the row ranges that changed, applied
 *  in order (each span's row0 is in the coordinates that hold after the
 *  spans before it), or a whole new layout when a fence or the front matter
 *  moved. */
export interface Patch {
  rev: number;
  spans: Span[];
  /** New total row count. */
  total: number;
  map: string;
  /** Caret after the edit: source line and column. */
  caret: [line: number, col: number];
  /** The active (raw) line's source text, when one is active. The guest owns
   *  this line while editing and checks its local copy against it. */
  text?: string;
  /** Echo of EditParams.seq for edit patches. */
  seq?: number;
  /** Set when the whole document was laid out again; the guest drops every
   *  cached row and re-reads DocInfo from here. */
  full?: DocInfo;
}

export type VaultMethods = {
  "vault.list": [ListParams, ListResult];
  "doc.open": [OpenParams, DocInfo];
  "doc.rows": [RowsParams, RowsResult];
  "doc.outline": [OpenParams, OutlineItem[]];
  "doc.focus": [FocusParams, Patch];
  "doc.edit": [EditParams, Patch];
  "doc.save": [OpenParams, { saved: boolean }];
};

/** Rows the guest asks for at once: a screen is ~13 body rows; this covers
 *  the screen plus the direction of travel, and stays one line on the wire. */
export const PAGE_ROWS = 32;
export const LIST_PAGE = 24;

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
