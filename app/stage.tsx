// app/stage.tsx — the top screen: the note, on white paper.
//
// Rows are absolutely placed by the prefix sum the store computes from the
// companion's kinds string, inside one canvas that moves by -offset. Only the
// rows within OVERSCAN of the viewport are mounted, keyed by index, so a
// scroll adds and drops a row at each edge and never re-creates the middle.
// A row's text comes as runs of [x, text, style]; the guest paints each run
// as one Text at that x and never measures — except the caret and the
// selection on the raw line, which are measureText over a prefix of a short
// string: a native, synchronous op on bytes already here, not IO.

import { For, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import {
  DOC_PAD_X,
  DOC_W,
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
import {
  DOC_CARET,
  DOC_HR,
  DOC_QUOTE_BAR,
  DOC_ROW,
  DOC_ROW_ACTIVE,
  DOC_ROW_CODE,
  DOC_SCROLLBAR,
  DOC_SELECTION,
  PAPER,
  SPLASH_HINT,
  SPLASH_SUB,
  SPLASH_TITLE,
} from "./theme.ts";
import { rawWidth, rowText } from "./wrap.ts";

/** Whole literals, one per (kind, style) — the compiler collects class
 *  strings from source, so a string assembled at runtime would style
 *  nothing. */
function runClass(kind: number, style: number): string {
  if (style & S_MARK) return "absolute text-sm text-[#5b616b]";
  switch (kind) {
    case K_H1:
      return "absolute text-xl text-[#111111] font-bold";
    case K_H2:
      return "absolute text-lg text-[#111111] font-bold";
    case K_H3:
      return "absolute text-base text-[#111111] font-bold";
    case K_CODE:
      return "absolute text-sm font-mono text-[#333333]";
    case K_META:
      return "absolute text-xs text-[#8a8f98]";
    case K_RAW:
      return "absolute text-sm text-[#1c1c1e]";
    case K_QUOTE:
      if (style & S_BOLD) return "absolute text-sm text-[#5b616b] font-bold";
      return "absolute text-sm text-[#5b616b]";
    default:
      break;
  }
  if (style & S_CODE) return "absolute text-sm font-mono text-[#8a2b2b]";
  if (style & S_WIKI) return "absolute text-sm text-[#1b4fa8] font-bold";
  if (style & S_LINK) return "absolute text-sm text-[#1b4fa8]";
  if (style & S_BOLD) return "absolute text-sm text-[#1c1c1e] font-bold";
  if (style & S_ITALIC) return "absolute text-sm text-[#3a3f47]";
  return "absolute text-sm text-[#1c1c1e]";
}

function rowClass(kind: number, active: boolean): string {
  if (active) return DOC_ROW_ACTIVE;
  if (kind === K_CODE) return DOC_ROW_CODE;
  return DOC_ROW;
}

/** The selection's [x0, x1] on this row, or null. Precise on a raw row;
 *  a rendered row inside the selection is highlighted whole. */
function selectionSpan(store: VaultStore, row: Row): [number, number] | null {
  const sel = store.selection();
  if (!sel) return null;
  const a = sel.anchor;
  const h = sel.head;
  const [from, to] = a.line < h.line || (a.line === h.line && a.col <= h.col) ? [a, h] : [h, a];
  if (row.l < from.line || row.l > to.line) return null;
  if (row.k !== K_RAW) return [0, DOC_W];
  const text = rowText(row);
  const start = row.l === from.line ? from.col - row.s : 0;
  const end = row.l === to.line ? to.col - row.s : text.length;
  const c0 = Math.max(0, Math.min(text.length, start));
  const c1 = Math.max(0, Math.min(text.length, end));
  if (c1 <= c0) return null;
  return [rawWidth(text.slice(0, c0)), rawWidth(text.slice(0, c1))];
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
    const text = rowText(r);
    const inRow = c.col - r.s;
    if (inRow < 0 || inRow > text.length) return null;
    // The next raw row of the same line starts where this one's text ends;
    // a caret exactly there belongs to the next row unless this is the last.
    const next = store.rowAt(props.index + 1);
    if (inRow === text.length && next?.l === r.l && next.k === K_RAW) return null;
    return rawWidth(text.slice(0, inRow));
  };
  const sel = (): [number, number] | null => {
    const r = row();
    return r ? selectionSpan(store, r) : null;
  };
  return (
    <View class={rowClass(kind(), active())} style={{ insetT: top(), height: height() }}>
      <Show when={sel()}>
        {(span) => <View class={DOC_SELECTION} style={{ insetL: DOC_PAD_X + span()[0], width: Math.max(2, span()[1] - span()[0]) }} />}
      </Show>
      <Show when={row()}>
        {(r) => (
          <For each={r().r}>
            {(run) =>
              run[2] & S_MARK && run[1] === "" ? (
                <View class={DOC_QUOTE_BAR} />
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
        <View class={DOC_HR} />
      </Show>
      <Show when={caretX() !== null}>
        <View class={DOC_CARET} style={{ insetL: DOC_PAD_X + (caretX() ?? 0) }} />
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
    <View debugName="Stage" class={PAPER}>
      <Show when={store.doc()} fallback={<Splash store={store} />}>
        <View
          debugName="DocCanvas"
          class="absolute left-0 right-0 top-0"
          style={{ translateY: -store.scroller.offset(), height: store.docHeight() + STAGE_H }}
        >
          <For each={indices()}>{(index) => <RowView store={store} index={index} />}</For>
        </View>
      </Show>
      <Show when={store.doc() && store.scroller.state() !== "idle"}>
        <View
          class={DOC_SCROLLBAR}
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
    <View class="absolute left-0 right-0 top-0 bottom-0 flex-col items-center justify-center bg-[#e6e8ec]">
      <Text class={SPLASH_TITLE}>Pocket Vault</Text>
      <Text class={SPLASH_SUB}>{props.store.linkLabel()}</Text>
      <Text class={SPLASH_HINT}>tap a note below · A opens · L/R page · X edits</Text>
      <Text class={SPLASH_HINT}>•…›</Text>
    </View>
  );
}
