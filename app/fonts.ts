// app/fonts.ts — the guest's measurer: the baked atlas's own advances, which
// are the numbers the companion's Metrics sums (host/layout.ts). Slots are
// literals with the arithmetic quoted beside them, because compiler source
// must stay out of the guest's import graph — pass 1 would harvest its
// utility-name strings as class candidates. test/layout.test.ts asserts each
// literal equals fontSlotFor(px, bold, mono), so a re-pinned slot table fails
// the suite instead of silently mis-measuring.

import { getOps } from "@pocketjs/framework";
import type { Face, Measurer } from "./linewrap.ts";

/** framework/compiler/tailwind.ts: FONT_PX = [12,14,16,18,20,24,36] with
 *  bold at +7, and MONO_FONT_PX = [12,14,16] at 16..18. */
export const FONT_SLOTS: Readonly<Record<Face, Readonly<Record<number, number>>>> = {
  regular: { 12: 0, 14: 1, 16: 2, 18: 3, 20: 4, 24: 5, 36: 6 },
  bold: { 12: 7, 14: 8, 16: 9, 18: 10, 20: 11, 24: 12, 36: 13 },
  mono: { 12: 16, 14: 17, 16: 18 },
};

export function fontSlot(face: Face, px: number): number {
  const slot = FONT_SLOTS[face][px];
  if (slot !== undefined) return slot;
  // A size the atlas does not carry falls back to the nearest baked one in
  // the same face, which keeps a mis-set constant readable instead of blank.
  const sizes = Object.keys(FONT_SLOTS[face]).map(Number);
  let nearest = sizes[0]!;
  for (const size of sizes) if (Math.abs(size - px) < Math.abs(nearest - px)) nearest = size;
  return FONT_SLOTS[face][nearest]!;
}

const CACHE_MAX = 4096;
const widths = new Map<string, number>();
let host: Measurer | null = null;

/** Replace the host's measureText — a headless test hands in the
 *  companion's own Metrics so both wraps can be compared. */
export function setMeasurer(fn: Measurer | null): void {
  host = fn;
  widths.clear();
}

export const measure: Measurer = (text, face, px) => {
  if (text === "") return 0;
  const key = `${face}|${px}|${text}`;
  let w = widths.get(key);
  if (w === undefined) {
    w = host ? host(text, face, px) : getOps().measureText(text, fontSlot(face, px));
    if (widths.size >= CACHE_MAX) widths.clear();
    widths.set(key, w);
  }
  return w;
};
