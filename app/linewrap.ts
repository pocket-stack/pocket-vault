// app/linewrap.ts — the one wrapping algorithm, shared by the companion and
// the guest. Given a line's segments and something that measures text, it
// produces the rows the console paints: greedy over whitespace-separated
// pieces, spaces hang at a break, a piece wider than the column splits at
// character level, and no substitution (a bullet, a checkbox, a hidden quote
// marker) is ever split.
//
// The measurer is the whole portability story. On the console it is
// `measureText` over the baked atlas; on the Mac it is the same integer
// advance formula over the same font files (host/layout.ts Metrics). Because
// both sides run THIS file over equal advances, a row the guest re-breaks
// after a keystroke is byte-identical to the row the companion would send,
// and the companion's patch confirms the screen instead of correcting it.

import { block, type Seg } from "./markdown.ts";
import {
  DOC_W,
  K_BLANK,
  ROW_PX,
  S_BOLD,
  S_CODE,
  S_MARK,
  kindIsMono,
  type Row,
  type Run,
} from "./protocol.ts";

export type Face = "regular" | "bold" | "mono";
export type Measurer = (text: string, face: Face, px: number) => number;

/** The face a segment paints in, under its block's defaults. */
export function faceFor(style: number, mono: boolean): Face {
  if (style & S_CODE || mono) return "mono";
  if (style & S_BOLD) return "bold";
  return "regular";
}

interface Piece {
  t: string;
  s: number;
  src: number;
  srcText?: string;
  w: number;
  space: boolean;
  atomic: boolean;
}

export interface WrapOptions {
  measure: Measurer;
  /** Column the content is broken to, from `indent` to the row's right edge. */
  width: number;
  /** x of the first character of every row. */
  indent: number;
  px: number;
  mono: boolean;
  charWrap: boolean;
  /** Keep trailing whitespace on a row (never — but the flag documents that
   *  the source's spaces are still addressable through their run's src). */
  keepTrailing?: boolean;
}

/** Break segments into rows of runs. Each row's runs start at `indent`. */
export function wrapSegments(segs: readonly Seg[], opts: WrapOptions): Array<{ runs: Run[]; s: number }> {
  const pieces: Piece[] = [];
  for (const seg of segs) {
    if (seg.w !== undefined || seg.srcText !== undefined) {
      pieces.push({
        t: seg.t,
        s: seg.s,
        src: seg.src,
        ...(seg.srcText === undefined ? {} : { srcText: seg.srcText }),
        w: seg.w ?? opts.measure(seg.t, faceFor(seg.s, opts.mono), opts.px),
        space: false,
        atomic: true,
      });
      continue;
    }
    const face = faceFor(seg.s, opts.mono);
    const tokens = opts.charWrap ? [...seg.t] : seg.t.split(/(\s+)/);
    let at = seg.src;
    for (const token of tokens) {
      if (token === "") continue;
      pieces.push({
        t: token,
        s: seg.s,
        src: at,
        w: opts.measure(token, face, opts.px),
        space: /^\s+$/.test(token),
        atomic: false,
      });
      at += token.length;
    }
  }

  const rows: Array<{ runs: Run[]; s: number }> = [];
  let runs: Run[] = [];
  let x = opts.indent;
  let rowSrc = segs.length > 0 ? segs[0]!.src : 0;
  let empty = true;
  const flush = (): void => {
    rows.push({ runs, s: rowSrc });
    runs = [];
    x = opts.indent;
    empty = true;
  };
  /** A zero-width run: the source characters are kept so the mapping stays
   *  total, but nothing paints and the row's width does not grow. This is
   *  where the whitespace that hangs at a break goes. */
  const appendZero = (piece: Piece): void => {
    if (empty) rowSrc = piece.src;
    runs.push([x, "", piece.s | S_MARK, piece.src, piece.t]);
  };
  const append = (piece: Piece): void => {
    if (empty) rowSrc = piece.src;
    const last = runs[runs.length - 1];
    // Two ordinary pieces of the same style merge into one run; a
    // substitution never merges, because its source text is its own.
    if (last && !piece.atomic && last[4] === undefined && last[2] === piece.s && !(piece.s & S_MARK)) {
      last[1] += piece.t;
    } else if (piece.srcText !== undefined) {
      runs.push([x, piece.t, piece.s, piece.src, piece.srcText]);
    } else {
      runs.push([x, piece.t, piece.s, piece.src]);
    }
    x += piece.w;
    empty = false;
  };
  const room = (): number => opts.indent + opts.width - x;

  for (const piece of pieces) {
    if (piece.space && !opts.charWrap) {
      // Whitespace at a break, or at the start of a continuation row, does
      // not paint — but its source columns are still addressable.
      if (empty || piece.w > room()) {
        appendZero(piece);
        if (!empty) flush();
        continue;
      }
      append(piece);
      continue;
    }
    if (piece.w <= room() || (empty && piece.atomic)) {
      append(piece);
      continue;
    }
    if (!empty) flush();
    if (piece.w <= room() || piece.atomic) {
      append(piece);
      continue;
    }
    // Wider than a whole row: split at character level.
    const face = faceFor(piece.s, opts.mono);
    let chunk = "";
    let chunkW = 0;
    let chunkSrc = piece.src;
    let at = piece.src;
    for (const ch of piece.t) {
      const w = opts.measure(ch, face, opts.px);
      if (chunk !== "" && chunkW + w > room()) {
        append({ t: chunk, s: piece.s, src: chunkSrc, w: chunkW, space: false, atomic: false });
        flush();
        chunk = "";
        chunkW = 0;
        chunkSrc = at;
      }
      chunk += ch;
      chunkW += w;
      at += ch.length;
    }
    if (chunk !== "") append({ t: chunk, s: piece.s, src: chunkSrc, w: chunkW, space: false, atomic: false });
  }
  if (!empty || rows.length === 0) flush();

  if (!opts.keepTrailing) {
    // Trailing whitespace becomes a zero-width run for the same reason: the
    // row must not measure wider than its column, and the columns must stay
    // reachable.
    for (const row of rows) {
      const last = row.runs[row.runs.length - 1];
      if (!last || last[4] !== undefined) continue;
      const trailing = /\s+$/.exec(last[1]);
      if (!trailing) continue;
      const visible = last[1].slice(0, last[1].length - trailing[0].length);
      const face = faceFor(last[2], opts.mono);
      const at = last[3] + visible.length;
      if (visible === "") {
        row.runs[row.runs.length - 1] = [last[0], "", last[2] | S_MARK, last[3], trailing[0]];
        continue;
      }
      last[1] = visible;
      row.runs.push([last[0] + opts.measure(visible, face, opts.px), "", last[2] | S_MARK, at, trailing[0]]);
    }
  }
  return rows;
}

/**
 * Lay out one source line as the rows the console paints, under the kind the
 * document assigned it. The guest calls this for the line it is editing; the
 * companion calls it for every line.
 */
export function layoutLine(
  source: string,
  line: number,
  kind: number,
  measure: Measurer,
  width = DOC_W,
): Row[] {
  if (kind === K_BLANK) return [{ k: kind, l: line, s: 0, r: [] }];
  const px = ROW_PX[kind] ?? 14;
  const b = block(source, kind, (text) => measure(text, faceFor(S_MARK, kindIsMono(kind)), px));
  const rows = wrapSegments(b.content, {
    measure,
    width: width - b.markerW,
    indent: b.markerW,
    px,
    mono: b.mono || kindIsMono(b.kind),
    charWrap: b.charWrap,
  }).map(({ runs, s }) => ({ k: b.kind, l: line, s, r: runs }));
  if (b.marker) {
    const marker: Run =
      b.marker.srcText === undefined
        ? [0, b.marker.t, b.marker.s, b.marker.src]
        : [0, b.marker.t, b.marker.s, b.marker.src, b.marker.srcText];
    rows[0]!.r.unshift(marker);
    rows[0]!.s = b.marker.src;
  }
  return rows;
}
