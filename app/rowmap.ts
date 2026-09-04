// app/rowmap.ts — the source↔screen mapping, which is the whole reason the
// row model carries source columns. With it the caret lives on a styled row:
// no raw mode, no reflow when the caret arrives, and a tap on the document
// resolves to a source position.
//
// Every source character of a line is on screen (protocol.ts), so the
// mapping is total in both directions. The exceptions are the three
// substitutions — a bullet, a checkbox, a hidden quote marker — whose runs
// are atomic: the caret snaps to an edge and never lands inside.

import { faceFor, type Measurer } from "./linewrap.ts";
import {
  ROW_PX,
  S_TASK,
  TASK_W,
  kindIsMono,
  runIsAtomic,
  runSource,
  type Row,
  type Run,
} from "./protocol.ts";

/** The source text a row's runs stand for. */
export function rowSourceText(row: Row): string {
  let out = "";
  for (const run of row.r) out += runSource(run);
  return out;
}

/** One past the last source column this row covers. */
export function rowSourceEnd(row: Row): number {
  const last = row.r[row.r.length - 1];
  return last === undefined ? row.s : last[3] + runSource(last).length;
}

/** A run's screen width. A checkbox is a drawn widget of a fixed width; every
 *  other run — substitution or not — is as wide as the text it shows. */
function runWidth(row: Row, run: Run, measure: Measurer): number {
  if (run[2] & S_TASK) return TASK_W;
  if (run[1] === "") return 0;
  return measure(run[1], faceFor(run[2], kindIsMono(row.k)), ROW_PX[row.k] ?? 14);
}

/** x of the source column `col` on this row, or null when the column is not
 *  on it. */
export function caretX(row: Row, col: number, measure: Measurer): number | null {
  if (row.r.length === 0) return col === row.s ? 0 : null;
  // A column outside this row's own source range is not on this row — the
  // caret belongs to another row of the same line.
  if (col < row.s || col > rowSourceEnd(row)) return null;
  const px = ROW_PX[row.k] ?? 14;
  const mono = kindIsMono(row.k);
  for (let i = 0; i < row.r.length; i++) {
    const run = row.r[i]!;
    const source = runSource(run);
    const start = run[3];
    const end = start + source.length;
    if (col < start) return run[0];
    if (col >= end) continue;
    if (runIsAtomic(run)) return col === start ? run[0] : nextX(row, i, measure);
    return run[0] + measure(run[1].slice(0, col - start), faceFor(run[2], mono), px);
  }
  const last = row.r[row.r.length - 1]!;
  const end = last[3] + runSource(last).length;
  if (col !== end) return null;
  return nextX(row, row.r.length - 1, measure);
}

/** The x just past run `i`: the following run's x, or the row's own end. */
function nextX(row: Row, i: number, measure: Measurer): number {
  const next = row.r[i + 1];
  if (next) return next[0];
  const run = row.r[i]!;
  return run[0] + runWidth(row, run, measure);
}

/** The source column nearest x on this row — what a tap resolves to. */
export function colAtX(row: Row, x: number, measure: Measurer): number {
  if (row.r.length === 0) return row.s;
  const px = ROW_PX[row.k] ?? 14;
  const mono = kindIsMono(row.k);
  for (let i = 0; i < row.r.length; i++) {
    const run = row.r[i]!;
    const source = runSource(run);
    const right = nextX(row, i, measure);
    if (x >= right && i + 1 < row.r.length) continue;
    if (runIsAtomic(run)) {
      // Snap to whichever edge is nearer; a zero-width substitution (a
      // hidden quote marker, the whitespace at a break) reads as its left.
      return x - run[0] <= right - x ? run[3] : run[3] + source.length;
    }
    const face = faceFor(run[2], mono);
    let best = run[3];
    let bestDistance = Math.abs(x - run[0]);
    let width = 0;
    for (let c = 0; c < run[1].length; c++) {
      width += measure(run[1][c]!, face, px);
      const distance = Math.abs(x - (run[0] + width));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = run[3] + c + 1;
      }
    }
    return best;
  }
  return rowSourceEnd(row);
}

/** The rows of one source line, in order, from a cache lookup. */
export function lineRows(
  line: number,
  first: number,
  last: number,
  rowAt: (index: number) => Row | undefined,
): Array<{ index: number; row: Row }> {
  const out: Array<{ index: number; row: Row }> = [];
  for (let i = first; i <= last; i++) {
    const row = rowAt(i);
    if (row && row.l === line) out.push({ index: i, row });
  }
  return out;
}
