// host/layout.ts — a markdown note becomes visual rows here, on the Mac,
// with the device's own glyph advances.
//
// The 3DS paints text from atlases baked by framework/compiler/bake-font.ts:
// Inter at the app's sizes, JetBrains Mono for code, every advance an integer
// (`round(advanceWidth * px / unitsPerEm)`), no kerning. This module loads
// the same font files and uses the same formula, then hands the result to the
// SAME wrapper the guest runs (app/linewrap.ts). So a row this file produces
// is the row the console would have produced, which is what lets the guest
// re-break the line it is editing locally and treat the companion's patch as
// confirmation rather than correction.
//
// One source line is one block. Obsidian treats a single newline as a line
// break, and keeping the source line as the unit makes the editing model
// direct: a caret is (line, col) and an edit re-lays out the lines it
// touched. A line whose classification depends on the document — inside a
// fence, inside the front matter — can change kind because of an edit
// elsewhere; that forces a whole re-layout, which the guest is told about
// with `full`.

import { readFileSync } from "node:fs";
import { parse as parseFont, type Font } from "opentype.js";
import {
  DEFAULT_BOLD,
  DEFAULT_MONO,
  DEFAULT_REGULAR,
} from "../vendor/pocketjs/framework/compiler/bake-font.ts";
import { classify, headingText, inlineTags, wikiLinks } from "../app/markdown.ts";
import { layoutLine, type Face, type Measurer } from "../app/linewrap.ts";
import {
  K_BLANK,
  K_CODE,
  K_H1,
  K_H2,
  K_H3,
  K_META,
  KIND_CHARS,
  MAP_BUCKETS,
  type DocInfo,
  type OutlineItem,
  type Patch,
  type Pos,
  type Row,
  type Span,
} from "../app/protocol.ts";

// ── Metrics ────────────────────────────────────────────────────────────────

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

  /** The baked atlas's advance for one code point: integer px, and the "?"
   *  advance for a code point the face does not map (bake-font gives gid 0,
   *  the tofu box, a comparable width). */
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

  /** This machine's Metrics as the shared wrapper's measurer. */
  get measure(): Measurer {
    return (text, face, px) => this.width(text, face, px);
  }
}

// ── A laid-out document ────────────────────────────────────────────────────

export interface Laid {
  readonly id: number;
  /** Vault-relative path — what the guest is told. */
  readonly path: string;
  /** Absolute path — what a save writes to. */
  readonly file: string;
  lines: string[];
  /** Whether the file ended with a newline (kept on save). */
  eol: boolean;
  /** One kind per SOURCE line (classify's output). */
  lineKinds: number[];
  /** Every visual row of the document. */
  rows: Row[];
  /** First row of each line; length lines + 1. */
  lineRow0: number[];
  rev: number;
  dirty: boolean;
}

function rebuildIndex(doc: Laid, rowsPerLine: readonly number[]): void {
  const lineRow0 = new Array<number>(rowsPerLine.length + 1);
  let acc = 0;
  for (let i = 0; i < rowsPerLine.length; i++) {
    lineRow0[i] = acc;
    acc += rowsPerLine[i]!;
  }
  lineRow0[rowsPerLine.length] = acc;
  doc.lineRow0 = lineRow0;
}

function relayoutAll(metrics: Metrics, doc: Laid): void {
  doc.lineKinds = classify(doc.lines);
  const rows: Row[] = [];
  const perLine: number[] = [];
  for (let i = 0; i < doc.lines.length; i++) {
    const lineRows = layoutLine(doc.lines[i]!, i, doc.lineKinds[i]!, metrics.measure);
    perLine.push(lineRows.length);
    for (const row of lineRows) rows.push(row);
  }
  doc.rows = rows;
  rebuildIndex(doc, perLine);
}

export function layoutDoc(metrics: Metrics, id: number, path: string, text: string, file = path): Laid {
  const eol = text.endsWith("\n");
  const lines = (eol ? text.slice(0, -1) : text).split("\n");
  const doc: Laid = { id, path, file, lines, eol, lineKinds: [], rows: [], lineRow0: [], rev: 1, dirty: false };
  relayoutAll(metrics, doc);
  return doc;
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

/**
 * The four extractors below read (lines, kinds) rather than a laid-out
 * document, because the index runs them over a thousand notes and classify()
 * is O(lines) with no measurement — building a Laid would mean wrapping
 * every note.
 */
export function titleOf(lines: readonly string[], kinds: readonly number[], fallback: string): string {
  for (let i = 0; i < lines.length && i < 40; i++) {
    const kind = kinds[i];
    if (kind === K_META) {
      const m = /^title:\s*(.+)$/.exec(lines[i]!);
      if (m) return m[1]!.trim().replace(/^["']|["']$/g, "");
    }
    if (kind === K_H1) return headingText(lines[i]!);
  }
  return fallback;
}

export function docTitle(doc: Laid, fallback: string): string {
  return titleOf(doc.lines, doc.lineKinds, fallback);
}

/** The first prose line, for a note list's second row. */
export function snippetOf(lines: readonly string[], kinds: readonly number[]): string {
  for (let i = 0; i < lines.length && i < 60; i++) {
    const kind = kinds[i]!;
    if (kind === K_META || kind === K_BLANK || kind === K_H1 || kind === K_CODE) continue;
    const text = lines[i]!.trim();
    if (text !== "") return text.slice(0, 96);
  }
  return "";
}

export function docSnippet(doc: Laid): string {
  return snippetOf(doc.lines, doc.lineKinds);
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
  for (let line = 0; line < doc.lines.length; line++) {
    const kind = doc.lineKinds[line]!;
    if (kind !== K_H1 && kind !== K_H2 && kind !== K_H3) continue;
    out.push({ row: doc.lineRow0[line]!, level: kind, text: headingText(doc.lines[line]!) });
  }
  return out;
}

/** Outgoing wiki links, in source order, with the line each sits on. */
export function linksOf(lines: readonly string[], kinds: readonly number[]): Array<{ target: string; line: number }> {
  const out: Array<{ target: string; line: number }> = [];
  const seen = new Set<string>();
  for (let line = 0; line < lines.length; line++) {
    if (kinds[line] === K_CODE) continue;
    for (const link of wikiLinks(lines[line]!)) {
      const key = link.target.toLowerCase();
      if (link.target === "" || seen.has(key)) continue;
      seen.add(key);
      out.push({ target: link.target, line });
    }
  }
  return out;
}

export function docLinks(doc: Laid): Array<{ target: string; line: number }> {
  return linksOf(doc.lines, doc.lineKinds);
}

/** Front-matter tags plus every inline #tag. */
export function tagsOf(lines: readonly string[], kinds: readonly number[]): string[] {
  const out = new Set<string>();
  for (let line = 0; line < lines.length; line++) {
    const kind = kinds[line]!;
    const text = lines[line]!;
    if (kind === K_META) {
      const m = /^tags:\s*\[?([^\]]*)\]?\s*$/.exec(text);
      if (m) {
        for (const tag of m[1]!.split(",")) {
          const clean = tag.trim().replace(/^["']|["']$/g, "");
          if (clean !== "") out.add(clean);
        }
      }
      continue;
    }
    if (kind === K_CODE) continue;
    for (const tag of inlineTags(text)) out.add(tag);
  }
  return [...out];
}

export function docTags(doc: Laid): string[] {
  return tagsOf(doc.lines, doc.lineKinds);
}

export function rowsOf(doc: Laid, from: number, count: number): Row[] {
  return doc.rows.slice(Math.max(0, from), Math.max(0, from) + Math.max(0, count));
}

export function sourceText(doc: Laid): string {
  return doc.lines.join("\n") + (doc.eol ? "\n" : "");
}

// ── Edits ──────────────────────────────────────────────────────────────────

interface Range {
  /** First line in the NEW numbering, and how many new lines. */
  from: number;
  count: number;
  /** The old lines these replace. */
  oldFrom: number;
  oldCount: number;
}

/**
 * Re-lay out the given ranges of the (already edited) source. Ranges are
 * applied from the last one down so each earlier range's coordinates still
 * hold — and the guest applies the spans in the same order. Returns null when
 * a line outside every range changed kind (a fence opened, front matter
 * moved), in which case the caller lays the whole document out again.
 */
function relayoutRanges(metrics: Metrics, doc: Laid, ranges: readonly Range[]): Span[] | null {
  const kinds = classify(doc.lines);
  const delta = doc.lines.length - doc.lineKinds.length;
  const main = ranges[0]!;
  const edited = (i: number): boolean => ranges.some((r) => i >= r.from && i < r.from + r.count);
  for (let i = 0; i < kinds.length; i++) {
    if (edited(i)) continue;
    const old = doc.lineKinds[i < main.from ? i : i - delta];
    if (old === undefined || old !== kinds[i]) return null;
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
      const lineRows = layoutLine(doc.lines[line]!, line, kinds[line]!, metrics.measure);
      counts.push(lineRows.length);
      for (const row of lineRows) fresh.push(row);
    }
    doc.rows.splice(row0, removed, ...fresh);
    perLine.splice(range.oldFrom, range.oldCount, ...counts);
    spans.push({ row0, removed, kinds: kindsOf(fresh), rows: fresh });
  }
  doc.lineKinds = kinds;
  rebuildIndex(doc, perLine);
  // An insert or a delete moved the line indices the rows carry.
  for (let line = 0; line < doc.lines.length; line++) {
    for (let i = doc.lineRow0[line]!; i < doc.lineRow0[line + 1]!; i++) doc.rows[i]!.l = line;
  }
  return spans;
}

function finish(doc: Laid, spans: Span[] | null, caret: Pos, title: string): Patch {
  doc.rev += 1;
  const patch: Patch = {
    rev: doc.rev,
    spans: spans ?? [],
    total: doc.rows.length,
    map: densityMap(doc.rows),
    caret,
    text: doc.lines[Math.max(0, Math.min(doc.lines.length - 1, caret[0]))] ?? "",
  };
  if (spans === null) patch.full = docInfo(doc, title);
  return patch;
}

const clampPos = (doc: Laid, pos: Pos): Pos => {
  const line = Math.max(0, Math.min(doc.lines.length - 1, pos[0]));
  return [line, Math.max(0, Math.min(doc.lines[line]!.length, pos[1]))];
};

/**
 * Replace the source range [from, to) with `text` — an insert when the two
 * coincide, a delete when the text is empty, a split when it holds a
 * newline, a join when the range spans lines. The caret lands at the end of
 * the inserted text.
 */
export function replaceRange(metrics: Metrics, doc: Laid, from: Pos, to: Pos, text: string, title: string): Patch {
  let [l0, c0] = clampPos(doc, from);
  let [l1, c1] = clampPos(doc, to);
  if (l1 < l0 || (l1 === l0 && c1 < c0)) {
    [l0, c0, l1, c1] = [l1, c1, l0, c0];
  }
  const head = doc.lines[l0]!.slice(0, c0);
  const tail = doc.lines[l1]!.slice(c1);
  const parts = (head + text + tail).split("\n");
  const oldCount = l1 - l0 + 1;
  doc.lines.splice(l0, oldCount, ...parts);
  const caretLine = l0 + parts.length - 1;
  const caretCol = parts[parts.length - 1]!.length - tail.length;
  doc.dirty = true;
  const spans = relayoutRanges(metrics, doc, [{ from: l0, count: parts.length, oldFrom: l0, oldCount }]);
  if (spans === null) relayoutAll(metrics, doc);
  return finish(doc, spans, [caretLine, caretCol], title);
}

/** Flip the checkbox on a task line, add one to a bullet, or make a plain
 *  line a task — the Actions menu's "Toggle task". */
export function toggleTask(metrics: Metrics, doc: Laid, line: number, title: string): Patch {
  const index = Math.max(0, Math.min(doc.lines.length - 1, line));
  const text = doc.lines[index]!;
  const task = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)/.exec(text);
  if (task) {
    const at = task[1]!.length;
    return replaceRange(metrics, doc, [index, at], [index, at + 1], task[2] === " " ? "x" : " ", title);
  }
  const bullet = /^(\s*)([-*+])(\s+)/.exec(text);
  if (bullet) {
    const at = bullet[0]!.length;
    return replaceRange(metrics, doc, [index, at], [index, at], "[ ] ", title);
  }
  const indent = /^\s*/.exec(text)![0]!.length;
  return replaceRange(metrics, doc, [index, indent], [index, indent], "- [ ] ", title);
}
