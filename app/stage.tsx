// app/stage.tsx — the top screen: the note.
//
// Rows are absolutely placed by the prefix sum the store computes from the
// companion's kinds string, inside one canvas that moves by -offset. Only the
// rows within OVERSCAN of the viewport are mounted, keyed by index, so a
// scroll adds and drops a row at each edge and never re-creates the middle.
// A row's text comes as runs of [x, text, style]; the guest paints each run
// as one Text at that x and never measures — except the caret, which is a
// measureText of the raw row's prefix (a native, synchronous, few-microsecond
// op on a short string, not IO).

import { For, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework";
import {
  DOC_PAD_X,
  K_BLANK,
  K_CODE,
  K_H1,
  K_H2,
  K_H3,
  K_HR,
  K_META,
  K_QUOTE,
  K_RAW,
  ROW_H,
  ROW_TEXT_TOP,
  S_BOLD,
  S_CODE,
  S_ITALIC,
  S_LINK,
  S_MARK,
  S_WIKI,
  STAGE_H,
  type Row,
} from "./protocol.ts";
import { OVERSCAN, type VaultStore } from "./store.ts";

/** framework/compiler/tailwind.ts fontSlotFor(14, false): text-sm regular,
 *  the raw row's face. A literal, because compiler source stays out of the
 *  guest's import graph. */
const FONT_RAW = 1;

/** Whole literals, one per (kind, style) — the compiler collects class
 *  strings from source, so a string assembled at runtime would style
 *  nothing. */
function runClass(kind: number, style: number): string {
  if (style & S_MARK) return "absolute text-sm text-[#908caa]";
  switch (kind) {
    case K_H1:
      return "absolute text-xl text-[#e0def4] font-bold";
    case K_H2:
      return "absolute text-lg text-[#e0def4] font-bold";
    case K_H3:
      return "absolute text-base text-[#e0def4] font-bold";
    case K_CODE:
      return "absolute text-sm font-mono text-[#f6c177]";
    case K_META:
      return "absolute text-xs text-[#6e6a86]";
    case K_RAW:
      return "absolute text-sm text-[#f6c177]";
    case K_QUOTE:
      if (style & S_BOLD) return "absolute text-sm text-[#908caa] font-bold";
      return "absolute text-sm text-[#908caa]";
    default:
      break;
  }
  if (style & S_CODE) return "absolute text-sm font-mono text-[#ebbcba]";
  if (style & S_WIKI) return "absolute text-sm text-[#c4a7e7] font-bold";
  if (style & S_LINK) return "absolute text-sm text-[#9ccfd8]";
  if (style & S_BOLD) return "absolute text-sm text-[#e0def4] font-bold";
  if (style & S_ITALIC) return "absolute text-sm text-[#c4a7e7]";
  return "absolute text-sm text-[#e0def4]";
}

function rowClass(kind: number, active: boolean): string {
  if (active) return "absolute left-0 right-0 bg-[#26233a]";
  if (kind === K_CODE) return "absolute left-[6] right-[6] bg-[#1f1d2e]";
  return "absolute left-0 right-0";
}

function RowView(props: { store: VaultStore; index: number }) {
  const store = props.store;
  const row = (): Row | undefined => store.rowAt(props.index);
  const top = (): number => store.tops()[props.index] ?? 0;
  const kind = (): number => row()?.k ?? K_BLANK;
  const height = (): number => ROW_H[kind()] ?? 18;
  const active = (): boolean => {
    const c = store.caret();
    const r = row();
    return c !== null && r !== undefined && r.k === K_RAW && r.l === c.line;
  };
  const caretX = (): number | null => {
    const c = store.caret();
    const r = row();
    if (!c || !r || r.k !== K_RAW || r.l !== c.line) return null;
    const text = r.r.map((run) => run[1]).join("");
    const inRow = c.col - r.s;
    if (inRow < 0 || inRow > text.length) return null;
    // The next raw row of the same line starts where this one's text ends;
    // a caret exactly there belongs to the next row unless this is the last.
    if (inRow === text.length && store.rowAt(props.index + 1)?.l === r.l && store.rowAt(props.index + 1)?.k === K_RAW) return null;
    return getOps().measureText(text.slice(0, inRow), FONT_RAW);
  };
  return (
    <View class={rowClass(kind(), active())} style={{ insetT: top(), height: height() }}>
      <Show when={row()}>
        {(r) => (
          <For each={r().r}>
            {(run) =>
              run[2] & S_MARK && run[1] === "" ? (
                <View class="absolute left-[12] top-[2] w-[3] h-[14] rounded-[1] bg-[#6e6a86]" />
              ) : (
                <Text class={runClass(r().k, run[2])} style={{ insetL: DOC_PAD_X + run[0], insetT: ROW_TEXT_TOP[r().k] ?? 1 }}>
                  {run[1]}
                </Text>
              )
            }
          </For>
        )}
      </Show>
      <Show when={kind() === K_HR}>
        <View class="absolute left-[12] right-[12] top-[6] h-[1] bg-[#403d52]" />
      </Show>
      <Show when={caretX() !== null}>
        <View class="absolute top-[1] w-[2] h-[16] bg-[#f6c177]" style={{ insetL: DOC_PAD_X + (caretX() ?? 0) }} />
      </Show>
    </View>
  );
}

function range(first: number, last: number): number[] {
  const out: number[] = [];
  for (let i = first; i <= last; i++) out.push(i);
  return out;
}

export function Stage(props: { store: VaultStore }) {
  const store = props.store;
  const indices = (): number[] => {
    const [first, last] = store.visibleRange();
    return last < first ? [] : range(first, last);
  };
  return (
    <View debugName="Stage" class="relative w-full h-full bg-[#191724] overflow-hidden">
      <Show when={store.doc()} fallback={<Splash store={store} />}>
        <View
          debugName="DocCanvas"
          class="absolute left-0 right-0 top-0"
          style={{ translateY: -store.scroller.offset(), height: store.docHeight() + STAGE_H }}
        >
          <For each={indices()}>{(index) => <RowView store={store} index={index} />}</For>
        </View>
        <View class="absolute left-0 right-0 top-0 h-[1] bg-[#26233a]" />
      </Show>
      <Show when={store.doc() && store.scroller.state() !== "idle"}>
        <View
          class="absolute right-[2] w-[3] rounded-[1] bg-[#6e6a8699]"
          style={{
            insetT: Math.round(store.scrollFraction() * (STAGE_H - 24 - OVERSCAN / 2)) + 4,
            height: 24,
          }}
        />
      </Show>
    </View>
  );
}

function Splash(props: { store: VaultStore }) {
  return (
    <View class="absolute left-0 right-0 top-0 bottom-0 flex-col items-center justify-center">
      <Text class="text-2xl text-[#e0def4] font-bold">Pocket Vault</Text>
      <Text class="text-sm text-[#908caa] mt-[6]">{props.store.status()}</Text>
      <Text class="text-xs text-[#6e6a86] mt-[18]">tap a note below · A opens · L/R page · X edits</Text>
      <Text class="text-xs text-[#6e6a86]">•…›</Text>
    </View>
  );
}
