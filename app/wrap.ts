// app/wrap.ts — the one line the guest lays out itself: the active line in
// edit mode. A keystroke must show on the same frame, offline or not, so the
// guest keeps the line's raw text and re-breaks it locally with the same
// rules the companion applies to a raw line (host/layout.ts `wrap`):
// greedy over whitespace-separated pieces, spaces hang at a break, a word
// wider than the column splits at character level, trailing spaces stay.
// Widths come from measureText — the baked atlas's own advances, which are
// exactly the numbers the companion sums — so the rows agree byte for byte
// and the companion's reply confirms rather than corrects.

import { getOps } from "@pocketjs/framework";
import { DOC_W, K_RAW, type Row, type Run } from "./protocol.ts";

/** framework/compiler/tailwind.ts fontSlotFor(14, false): text-sm regular. */
export const FONT_RAW = 1;

const widths = new Map<string, number>();
let measure: ((text: string) => number) | null = null;

/** Replace the host's measureText — a headless test hands in the
 *  companion's own Metrics so the two wraps can be compared. */
export function setRawMeasurer(fn: ((text: string) => number) | null): void {
  measure = fn;
  widths.clear();
}

export function rawWidth(text: string): number {
  if (text === "") return 0;
  let w = widths.get(text);
  if (w === undefined) {
    w = measure ? measure(text) : getOps().measureText(text, FONT_RAW);
    widths.set(text, w);
  }
  return w;
}

/** Break one raw source line into rows for `line`, width DOC_W. */
export function wrapRaw(text: string, line: number, width = DOC_W): Row[] {
  const pieces: Array<{ t: string; w: number; src: number; space: boolean }> = [];
  let src = 0;
  for (const token of text.split(/(\s+)/)) {
    if (token === "") continue;
    pieces.push({ t: token, w: rawWidth(token), src, space: /^\s+$/.test(token) });
    src += token.length;
  }
  const rows: Row[] = [];
  let runs: Run[] = [];
  let x = 0;
  let rowSrc = 0;
  let empty = true;
  const flush = (): void => {
    rows.push({ k: K_RAW, l: line, s: rowSrc, r: runs });
    runs = [];
    x = 0;
    empty = true;
  };
  const append = (t: string, w: number, at: number): void => {
    if (empty) rowSrc = at;
    const last = runs[runs.length - 1];
    if (last) last[1] += t;
    else runs.push([x, t, 0]);
    x += w;
    empty = false;
  };
  const room = (): number => width - x;
  for (const piece of pieces) {
    if (piece.space) {
      if (empty) {
        rowSrc = piece.src + piece.t.length;
        continue;
      }
      if (piece.w > room()) {
        flush();
        rowSrc = piece.src + piece.t.length;
        continue;
      }
      append(piece.t, piece.w, piece.src);
      continue;
    }
    if (piece.w <= room()) {
      append(piece.t, piece.w, piece.src);
      continue;
    }
    if (!empty) flush();
    if (piece.w <= room()) {
      append(piece.t, piece.w, piece.src);
      continue;
    }
    let chunk = "";
    let chunkW = 0;
    let chunkSrc = piece.src;
    let at = piece.src;
    for (const ch of piece.t) {
      const w = rawWidth(ch);
      if (chunk !== "" && chunkW + w > room()) {
        append(chunk, chunkW, chunkSrc);
        flush();
        chunk = "";
        chunkW = 0;
        chunkSrc = at;
      }
      chunk += ch;
      chunkW += w;
      at += ch.length;
    }
    if (chunk !== "") append(chunk, chunkW, chunkSrc);
  }
  if (!empty || rows.length === 0) flush();
  return rows;
}

/** The text of a raw row. */
export function rowText(row: Row): string {
  let out = "";
  for (const run of row.r) out += run[1];
  return out;
}
