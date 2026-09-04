// host/layout.ts — a markdown note becomes visual rows here, on the Mac,
// with the device's own glyph advances.
//
// The 3DS paints text from atlases baked by framework/compiler/bake-font.ts:
// Inter at the app's sizes, JetBrains Mono for code, every advance an integer
// (`round(advanceWidth * px / unitsPerEm)`), no kerning. This module loads
// the same font files and uses the same formula, so a row it says fits in
// 376 px is a row the console paints in 376 px. That is what lets the guest
// skip measuring altogether: it places rows by a prefix sum over per-kind
// heights and paints the runs it is handed.
//
// One source line is one block. Obsidian treats a single newline as a line
// break, and keeping the source line as the unit makes the editing model
// direct: a caret is (line, col), the active line is shown raw (its markup
// visible, as Obsidian's live preview does), and an edit re-lays out the
// lines it touched. A line whose classification changes because of an edit
// elsewhere (a fence opened or closed, front matter moved) forces a whole
// re-layout, which the guest is told about with `full`.

import { readFileSync } from "node:fs";
import { parse as parseFont, type Font } from "opentype.js";
import {
  DEFAULT_BOLD,
  DEFAULT_MONO,
  DEFAULT_REGULAR,
} from "../vendor/pocketjs/framework/compiler/bake-font.ts";
import {
  DOC_W,
  INDENT,
  K_BLANK,
  K_CODE,
  K_H1,
  K_H2,
  K_H3,
  K_HR,
  K_LI,
  K_META,
  K_P,
  K_QUOTE,
  K_RAW,
  KIND_CHARS,
  MAP_BUCKETS,
  ROW_PX,
  S_BOLD,
  S_CODE,
  S_ITALIC,
  S_LINK,
  S_MARK,
  S_WIKI,
  type DocInfo,
  type OutlineItem,
  type Patch,
  type Row,
  type Run,
  type Span,
} from "../app/protocol.ts";

// ── Metrics ────────────────────────────────────────────────────────────────

export type Face = "regular" | "bold" | "mono";

export class Metrics {
  private readonly fonts: Record<Face, Font>;
  private readonly cache = new Map<string, Map<number, number>>();

  constructor(paths: Partial<Record<Face, string>> = {}) {
    const load = (path: string): Font => {
      const bytes = readFileSync(path);
      return parseFont(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    };
    this.fonts = {
      regular: load(paths.regular ?? DEFAULT_REGULAR),
      bold: load(paths.bold ?? DEFAULT_BOLD),
      mono: load(paths.mono ?? DEFAULT_MONO),
    };
  }

  /** The baked atlas's advance for one code point: integer px, tofu for a
   *  code point the face does not map (bake-font gives gid 0 the "?"
   *  advance, near enough). */
  advance(cp: number, face: Face, px: number): number {
    const key = `${face}:${px}`;
    let table = this.cache.get(key);
    if (!table) {
      table = new Map();
      this.cache.set(key, table);
    }
    let w = table.get(cp);
    if (w === undefined) {
      const font = this.fonts[face];
      let gi = font.charToGlyphIndex(String.fromCodePoint(cp));
      if (gi <= 0) gi = font.charToGlyphIndex("?");
      const glyph = font.glyphs.get(gi);
      w = Math.max(0, Math.min(255, Math.round((glyph.advanceWidth ?? 0) * (px / font.unitsPerEm))));
      table.set(cp, w);
    }
    return w;
  }

  width(text: string, face: Face, px: number): number {
    let w = 0;
    for (const ch of text) w += this.advance(ch.codePointAt(0)!, face, px);
    return w;
  }
}

// ── Inline markup ──────────────────────────────────────────────────────────

interface Seg {
  t: string;
  s: number;
}

const URL_RE = /^https?:\/\/[^\s)]+/;

/** Inline markdown → styled segments. Bold, italic, code spans, wiki links,
 *  links and bare URLs; unmatched delimiters stay literal. */
export function inline(text: string, base = 0): Seg[] {
  const out: Seg[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain !== "") out.push({ t: plain, s: base });
    plain = "";
  };
  const push = (t: string, s: number): void => {
    if (t === "") return;
    flush();
    out.push({ t, s: base | s });
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        push(text.slice(i + 1, end), S_CODE);
        i = end + 1;
        continue;
      }
    }
    if (ch === "[" && text[i + 1] === "[") {
      const end = text.indexOf("]]", i + 2);
      if (end > i + 2) {
        const body = text.slice(i + 2, end);
        const bar = body.indexOf("|");
        push(bar >= 0 ? body.slice(bar + 1) : body, S_WIKI);
        i = end + 2;
        continue;
      }
    }
    if (ch === "[") {
      const close = text.indexOf("](", i + 1);
      const end = close > 0 ? text.indexOf(")", close + 2) : -1;
      if (close > i + 1 && end > close) {
        push(text.slice(i + 1, close), S_LINK);
        i = end + 1;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && text[i + 1] === ch) {
      const end = text.indexOf(ch + ch, i + 2);
      if (end > i + 2) {
        for (const seg of inline(text.slice(i + 2, end), base | S_BOLD)) push(seg.t, seg.s);
        i = end + 2;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && (i === 0 || /\s|[([]/.test(text[i - 1]!)) && text[i + 1] !== undefined && !/\s/.test(text[i + 1]!)) {
      const end = text.indexOf(ch, i + 1);
      if (end > i + 1 && !/\s/.test(text[end - 1]!)) {
        for (const seg of inline(text.slice(i + 1, end), base | S_ITALIC)) push(seg.t, seg.s);
        i = end + 1;
        continue;
      }
    }
    if (ch === "h") {
      const m = URL_RE.exec(text.slice(i));
      if (m) {
        push(m[0], S_LINK);
        i += m[0].length;
        continue;
      }
    }
    plain += ch;
    i += 1;
  }
  flush();
  return out;
}

// ── Lines → blocks ─────────────────────────────────────────────────────────

interface LineInfo {
  kind: number;
  /** Content after the block marker (heading text, list item text, …). */
  text: string;
  /** Marker run text for lists ("•", "3."); "" for the quote bar. */
  marker: string | null;
  /** Source column where `text` starts. */
  offset: number;
}

const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED_RE = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_RE = /^\s*\|.*\|\s*$/;

export function classify(lines: readonly string[]): LineInfo[] {
  const out: LineInfo[] = [];
  let fence: string | null = null;
  let front = lines[0] === "---" ? "open" : "none";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (front === "open") {
      out.push({ kind: K_META, text: line, marker: null, offset: 0 });
      if (i > 0 && line === "---") front = "closed";
      continue;
    }
    if (fence) {
      out.push({ kind: K_CODE, text: line, marker: null, offset: 0 });
      const m = FENCE_RE.exec(line);
      if (m && m[1] === fence) fence = null;
      continue;
    }
    const fenceOpen = FENCE_RE.exec(line);
    if (fenceOpen) {
      fence = fenceOpen[1]!;
      out.push({ kind: K_CODE, text: line, marker: null, offset: 0 });
      continue;
    }
    if (line.trim() === "") {
      out.push({ kind: K_BLANK, text: "", marker: null, offset: 0 });
      continue;
    }
    let m = HEADING_RE.exec(line);
    if (m) {
      const level = m[1]!.length;
      out.push({ kind: level === 1 ? K_H1 : level === 2 ? K_H2 : K_H3, text: m[2]!, marker: null, offset: level + 1 });
      continue;
    }
    if (HR_RE.test(line)) {
      out.push({ kind: K_HR, text: "", marker: null, offset: 0 });
      continue;
    }
    if (TABLE_RE.test(line)) {
      out.push({ kind: K_CODE, text: line, marker: null, offset: 0 });
      continue;
    }
    m = BULLET_RE.exec(line);
    if (m) {
      out.push({ kind: K_LI, text: m[2]!, marker: "•", offset: line.length - m[2]!.length });
      continue;
    }
    m = ORDERED_RE.exec(line);
    if (m) {
      out.push({ kind: K_LI, text: m[3]!, marker: `${m[2]!}.`, offset: line.length - m[3]!.length });
      continue;
    }
    m = QUOTE_RE.exec(line);
    if (m) {
      out.push({ kind: K_QUOTE, text: m[1]!, marker: "", offset: line.length - m[1]!.length });
      continue;
    }
    out.push({ kind: K_P, text: line, marker: null, offset: 0 });
  }
  return out;
}

// ── Wrapping ───────────────────────────────────────────────────────────────

interface Piece {
  t: string;
  s: number;
  w: number;
  /** Source column of the piece's first character (raw layouts). */
  src: number;
  space: boolean;
}

function faceFor(kind: number, style: number): Face {
  if (style & S_CODE || kind === K_CODE) return "mono";
  if (style & S_BOLD || kind === K_H1 || kind === K_H2 || kind === K_H3) return "bold";
  return "regular";
}

/** Break styled segments into rows of runs under `width`, starting each row
 *  at x = indent. Whitespace hangs at a break; a word wider than the row is
 *  split at character level. */
function wrap(
  metrics: Metrics,
  kind: number,
  segs: readonly Seg[],
  width: number,
  indent: number,
  srcBase: number,
  charWrap: boolean,
): Array<{ runs: Run[]; s: number }> {
  const px = ROW_PX[kind]!;
  const pieces: Piece[] = [];
  let src = srcBase;
  for (const seg of segs) {
    const face = faceFor(kind, seg.s);
    const tokens = charWrap ? [...seg.t] : seg.t.split(/(\s+)/);
    for (const token of tokens) {
      if (token === "") continue;
      pieces.push({ t: token, s: seg.s, w: metrics.width(token, face, px), src, space: /^\s+$/.test(token) });
      src += token.length;
    }
  }
  const rows: Array<{ runs: Run[]; s: number }> = [];
  let runs: Run[] = [];
  let x = indent;
  let rowSrc = srcBase;
  let empty = true;
  const flush = (): void => {
    rows.push({ runs, s: rowSrc });
    runs = [];
    x = indent;
    empty = true;
  };
  const append = (piece: Piece): void => {
    if (empty) rowSrc = piece.src;
    const last = runs[runs.length - 1];
    if (last && last[2] === piece.s) last[1] += piece.t;
    else runs.push([x, piece.t, piece.s]);
    x += piece.w;
    empty = false;
  };
  const room = (): number => indent + width - x;
  for (const piece of pieces) {
    if (piece.space && !charWrap) {
      if (empty) {
        rowSrc = piece.src + piece.t.length;
        continue;
      }
      if (piece.w > room()) {
        flush();
        rowSrc = piece.src + piece.t.length;
        continue;
      }
      append(piece);
      continue;
    }
    if (piece.w <= room()) {
      append(piece);
      continue;
    }
    if (!empty) flush();
    if (piece.w <= room()) {
      append(piece);
      continue;
    }
    // Wider than a whole row: split at character level.
    const face = faceFor(kind, piece.s);
    let chunk = "";
    let chunkW = 0;
    let chunkSrc = piece.src;
    let at = piece.src;
    for (const ch of piece.t) {
      const w = metrics.advance(ch.codePointAt(0)!, face, px);
      if (chunk !== "" && chunkW + w > room()) {
        append({ t: chunk, s: piece.s, w: chunkW, src: chunkSrc, space: false });
        flush();
        chunk = "";
        chunkW = 0;
        chunkSrc = at;
      }
      chunk += ch;
      chunkW += w;
      at += ch.length;
    }
    if (chunk !== "") append({ t: chunk, s: piece.s, w: chunkW, src: chunkSrc, space: false });
  }
  if (!empty || rows.length === 0) flush();
  // Trailing whitespace on a row does not paint — except on a raw row,
  // where every source character is a caret position.
  for (const row of kind === K_RAW ? [] : rows) {
    const last = row.runs[row.runs.length - 1];
    if (last && /\s+$/.test(last[1])) {
      last[1] = last[1].replace(/\s+$/, "");
      if (last[1] === "") row.runs.pop();
    }
  }
  return rows;
}

// ── A laid-out document ────────────────────────────────────────────────────

export interface Laid {
  readonly id: number;
  readonly path: string;
  lines: string[];
  /** Whether the file ended with a newline (kept on save). */
  eol: boolean;
  infos: LineInfo[];
  rows: Row[];
  /** First row of each line; length lines + 1. */
  lineRow0: number[];
  rev: number;
  /** The line shown raw, if any. */
  active: number | null;
  dirty: boolean;
}

function layoutLine(metrics: Metrics, info: LineInfo, line: number, raw: string, active: boolean): Row[] {
  if (active) {
    return wrap(metrics, K_RAW, [{ t: raw, s: 0 }], DOC_W, 0, 0, false).map(({ runs, s }) => ({ k: K_RAW, l: line, s, r: runs }));
  }
  switch (info.kind) {
    case K_BLANK:
    case K_HR:
      return [{ k: info.kind, l: line, s: 0, r: [] }];
    case K_CODE:
      return wrap(metrics, K_CODE, [{ t: raw, s: 0 }], DOC_W, 0, 0, true).map(({ runs, s }) => ({ k: K_CODE, l: line, s, r: runs }));
    case K_META:
      return wrap(metrics, K_META, [{ t: raw, s: 0 }], DOC_W, 0, 0, false).map(({ runs, s }) => ({ k: K_META, l: line, s, r: runs }));
    case K_H1:
    case K_H2:
    case K_H3:
      return wrap(metrics, info.kind, inline(info.text).map((seg) => ({ t: seg.t, s: seg.s & ~S_BOLD })), DOC_W, 0, info.offset, false)
        .map(({ runs }) => ({ k: info.kind, l: line, s: 0, r: runs }));
    case K_LI: {
      const marker = info.marker ?? "•";
      const markerW = Math.max(INDENT, metrics.width(marker, "regular", ROW_PX[K_LI]!) + 6);
      const rows = wrap(metrics, K_LI, inline(info.text), DOC_W - markerW, markerW, info.offset, false)
        .map(({ runs }) => ({ k: K_LI, l: line, s: 0, r: runs }));
      rows[0]!.r.unshift([0, marker, S_MARK]);
      return rows;
    }
    case K_QUOTE: {
      const rows = wrap(metrics, K_QUOTE, inline(info.text), DOC_W - INDENT, INDENT, info.offset, false)
        .map(({ runs }) => ({ k: K_QUOTE, l: line, s: 0, r: runs }));
      for (const row of rows) row.r.unshift([0, "", S_MARK]);
      return rows;
    }
    default:
      return wrap(metrics, K_P, inline(info.text), DOC_W, 0, 0, false).map(({ runs }) => ({ k: K_P, l: line, s: 0, r: runs }));
  }
}

function rebuildIndex(doc: Laid, rowsPerLine: number[]): void {
  const lineRow0 = new Array<number>(rowsPerLine.length + 1);
  let acc = 0;
  for (let i = 0; i < rowsPerLine.length; i++) {
    lineRow0[i] = acc;
    acc += rowsPerLine[i]!;
  }
  lineRow0[rowsPerLine.length] = acc;
  doc.lineRow0 = lineRow0;
}

export function layoutDoc(metrics: Metrics, id: number, path: string, text: string): Laid {
  const eol = text.endsWith("\n");
  const lines = (eol ? text.slice(0, -1) : text).split("\n");
  const doc: Laid = { id, path, lines, eol, infos: [], rows: [], lineRow0: [], rev: 1, active: null, dirty: false };
  relayoutAll(metrics, doc);
  return doc;
}

function relayoutAll(metrics: Metrics, doc: Laid): void {
  doc.infos = classify(doc.lines);
  const rows: Row[] = [];
  const perLine: number[] = [];
  for (let i = 0; i < doc.lines.length; i++) {
    const lineRows = layoutLine(metrics, doc.infos[i]!, i, doc.lines[i]!, doc.active === i);
    perLine.push(lineRows.length);
    for (const row of lineRows) rows.push(row);
  }
  doc.rows = rows;
  rebuildIndex(doc, perLine);
}

export function kindsOf(rows: readonly Row[]): string {
  let out = "";
  for (const row of rows) out += KIND_CHARS[row.k];
  return out;
}

const INK_FULL = 58;

export function densityMap(rows: readonly Row[]): string {
  let out = "";
  const n = rows.length;
  for (let b = 0; b < MAP_BUCKETS; b++) {
    const from = Math.floor((b * n) / MAP_BUCKETS);
    const to = Math.max(from + 1, Math.floor(((b + 1) * n) / MAP_BUCKETS));
    let ink = 0;
    let count = 0;
    for (let i = from; i < to && i < n; i++) {
      let chars = 0;
      for (const run of rows[i]!.r) chars += run[1].length;
      ink += Math.min(1, chars / INK_FULL);
      count += 1;
    }
    out += KIND_CHARS[count === 0 ? 0 : Math.min(35, Math.round((ink / count) * 35))];
  }
  return out;
}

export function docTitle(doc: Laid, fallback: string): string {
  for (let i = 0; i < doc.infos.length && i < 40; i++) {
    const info = doc.infos[i]!;
    if (info.kind === K_META) {
      const m = /^title:\s*(.+)$/.exec(doc.lines[i]!);
      if (m) return m[1]!.trim();
    }
    if (info.kind === K_H1) return info.text.trim();
  }
  return fallback;
}

export function docInfo(doc: Laid, title: string): DocInfo {
  return {
    id: doc.id,
    title,
    path: doc.path,
    rows: doc.rows.length,
    lines: doc.lines.length,
    kinds: kindsOf(doc.rows),
    map: densityMap(doc.rows),
    rev: doc.rev,
  };
}

export function outline(doc: Laid): OutlineItem[] {
  const out: OutlineItem[] = [];
  for (let line = 0; line < doc.infos.length; line++) {
    const info = doc.infos[line]!;
    if (info.kind !== K_H1 && info.kind !== K_H2 && info.kind !== K_H3) continue;
    out.push({ row: doc.lineRow0[line]!, level: info.kind, text: info.text.trim() });
  }
  return out;
}

export function rowsOf(doc: Laid, from: number, count: number): Row[] {
  return doc.rows.slice(Math.max(0, from), Math.max(0, from) + Math.max(0, count));
}

export function sourceText(doc: Laid): string {
  return doc.lines.join("\n") + (doc.eol ? "\n" : "");
}

// ── Edits ──────────────────────────────────────────────────────────────────

interface Range {
  /** First line in the NEW numbering and how many new lines. */
  from: number;
  count: number;
  /** The old lines these replace. */
  oldFrom: number;
  oldCount: number;
}

/**
 * Re-lay out the given ranges of the (already edited) source. Old
 * coordinates come from the document's current index; ranges are applied
 * from the last one down so each earlier range's coordinates still hold —
 * and the guest applies the spans in the same order. Returns null when a
 * line outside every range changed kind, in which case the caller lays the
 * whole document out again.
 */
function relayoutRanges(metrics: Metrics, doc: Laid, ranges: Range[]): Span[] | null {
  const infos = classify(doc.lines);
  const delta = doc.lines.length - doc.infos.length;
  const edited = (i: number): boolean => ranges.some((r) => i >= r.from && i < r.from + r.count);
  const main = ranges[0]!;
  for (let i = 0; i < infos.length; i++) {
    if (edited(i)) continue;
    const oldIndex = i < main.from ? i : i - delta;
    const old = doc.infos[oldIndex];
    if (!old || old.kind !== infos[i]!.kind) return null;
  }
  const ordered = [...ranges].sort((a, b) => b.from - a.from);
  const perLine: number[] = doc.lineRow0.slice(0, -1).map((start, i) => doc.lineRow0[i + 1]! - start);
  const spans: Span[] = [];
  for (const range of ordered) {
    const row0 = doc.lineRow0[range.oldFrom]!;
    const removed = doc.lineRow0[range.oldFrom + range.oldCount]! - row0;
    const fresh: Row[] = [];
    const counts: number[] = [];
    for (let line = range.from; line < range.from + range.count; line++) {
      const lineRows = layoutLine(metrics, infos[line]!, line, doc.lines[line]!, doc.active === line);
      counts.push(lineRows.length);
      for (const row of lineRows) fresh.push(row);
    }
    doc.rows.splice(row0, removed, ...fresh);
    perLine.splice(range.oldFrom, range.oldCount, ...counts);
    spans.push({ row0, removed, kinds: kindsOf(fresh), rows: fresh });
  }
  doc.infos = infos;
  rebuildIndex(doc, perLine);
  for (let line = 0; line < doc.lines.length; line++) {
    for (let j = doc.lineRow0[line]!; j < doc.lineRow0[line + 1]!; j++) doc.rows[j]!.l = line;
  }
  return spans;
}

function finish(doc: Laid, spans: Span[] | null, caret: [number, number], title: string): Patch {
  doc.rev += 1;
  const base = { rev: doc.rev, total: doc.rows.length, map: densityMap(doc.rows), caret };
  if (spans === null) return { ...base, spans: [], full: docInfo(doc, title) };
  return { ...base, spans };
}

/** Show `line` raw (or none). Two lines change at most: the one leaving
 *  raw and the one entering it. */
export function focusLine(metrics: Metrics, doc: Laid, line: number | null, title: string): Patch {
  const previous = doc.active;
  const next = line === null ? null : Math.max(0, Math.min(doc.lines.length - 1, line));
  doc.active = next;
  const lines = [...new Set([previous, next].filter((v): v is number => v !== null && v < doc.lines.length))];
  const ranges: Range[] = lines.map((l) => ({ from: l, count: 1, oldFrom: l, oldCount: 1 }));
  if (ranges.length === 0) return finish(doc, [], [next ?? 0, 0], title);
  const spans = relayoutRanges(metrics, doc, ranges);
  if (spans === null) relayoutAll(metrics, doc);
  return finish(doc, spans, [next ?? 0, 0], title);
}

/** Insert and/or delete at (line, col). The caret's line becomes the active
 *  (raw) line; a split makes the new line active. */
export function editAt(
  metrics: Metrics,
  doc: Laid,
  line: number,
  col: number,
  insert: string | undefined,
  del: number | undefined,
  title: string,
): Patch {
  line = Math.max(0, Math.min(doc.lines.length - 1, line));
  let text = doc.lines[line]!;
  col = Math.max(0, Math.min(text.length, col));
  let from = line;
  let oldCount = 1;
  if (del && del > 0) {
    if (col >= del) {
      text = text.slice(0, col - del) + text.slice(col);
      col -= del;
      doc.lines[line] = text;
    } else if (line > 0) {
      const previous = doc.lines[line - 1]!;
      doc.lines.splice(line - 1, 2, previous + text.slice(col));
      from = line - 1;
      oldCount = 2;
      line -= 1;
      col = previous.length;
      text = doc.lines[line]!;
    } else {
      text = text.slice(col);
      col = 0;
      doc.lines[line] = text;
    }
  }
  let newCount = 1;
  if (insert && insert.length > 0) {
    const joined = text.slice(0, col) + insert + text.slice(col);
    const parts = joined.split("\n");
    doc.lines.splice(line, 1, ...parts);
    newCount = parts.length;
    line += parts.length - 1;
    col = parts[parts.length - 1]!.length - (text.length - col);
  }
  const previousActive = doc.active;
  doc.active = line;
  doc.dirty = true;
  const ranges: Range[] = [{ from, count: newCount, oldFrom: from, oldCount }];
  if (previousActive !== null && (previousActive < from || previousActive >= from + oldCount)) {
    const shifted = previousActive >= from + oldCount ? previousActive + newCount - oldCount : previousActive;
    if (shifted < doc.lines.length) ranges.push({ from: shifted, count: 1, oldFrom: previousActive, oldCount: 1 });
  }
  const spans = relayoutRanges(metrics, doc, ranges);
  if (spans === null) relayoutAll(metrics, doc);
  return finish(doc, spans, [line, col], title);
}
