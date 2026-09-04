// app/stage.tsx — the top screen: a navigation bar and the note.
//
// The bar carries the two shoulder buttons the console actually has: `L
// Vault` on the left and `Actions R` on the right, each a plain pill with
// its letter — the left one is NOT an arrow, because it opens the vault's
// menu rather than going back a step. Tapping a shoulder turns a page;
// holding it drops that menu under its own corner (and mirrors it on the
// touch screen, deck.tsx).
//
// Rows are absolutely placed by the prefix sum the store computes from the
// companion's kinds string, inside one canvas that moves by -offset. Only the
// rows within OVERSCAN of the viewport are mounted, keyed by index, so a
// scroll adds and drops a row at each edge and never re-creates the middle.
// A row's text arrives as runs of [x, text, style, sourceColumn]; the guest
// paints each run at that x and measures only what the caret and the
// selection need — a prefix of one short string, natively, on bytes already
// in memory.
//
// Adjacent rows of the same boxed kind (code, a quote read as a callout, a
// run of tasks) draw as one block: the renderer looks at the neighbouring
// rows' kinds, which it has in the kinds string, and only paints the edges
// where the block starts and ends.

import { For, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { measure } from "./fonts.ts";
import {
  DOC_PAD_X,
  DOC_TOP,
  DOC_VIEW_H,
  K_BLANK,
  K_CODE,
  K_H1,
  K_H2,
  K_H3,
  K_HR,
  K_META,
  K_QUOTE,
  K_TASK,
  KIND_CHARS,
  ROW_H,
  ROW_TEXT_TOP,
  S_BOLD,
  S_CODE,
  S_ITALIC,
  S_LINK,
  S_MARK,
  S_STRIKE,
  S_TAG,
  S_TASK,
  S_TASK_DONE,
  S_WIKI,
  STAGE_W,
  kindIsBoxed,
  type Row,
} from "./protocol.ts";
import { caretX, rowSourceEnd } from "./rowmap.ts";
import { OVERSCAN, type VaultStore } from "./store.ts";
import * as T from "./theme.ts";

/** Whole literals, one per (kind, style) — the compiler collects class
 *  strings from source, so a string assembled at runtime styles nothing.
 *  A marker keeps its block's size and takes the dim ink: that is the
 *  Bear/Typora look, and it is why the caret can live anywhere. */
function runClass(kind: number, style: number): string {
  if (style & S_MARK) {
    switch (kind) {
      case K_H1:
        return "absolute text-xl text-[#a2a8b2] font-bold";
      case K_H2:
        return "absolute text-lg text-[#a2a8b2] font-bold";
      case K_H3:
        return "absolute text-base text-[#a2a8b2] font-bold";
      case K_CODE:
        return "absolute text-sm font-mono text-[#a2a8b2]";
      case K_META:
        return "absolute text-xs text-[#a2a8b2]";
      default:
        break;
    }
    if (style & S_TAG) return "absolute text-sm text-[#a08bc0]";
    if (style & S_WIKI) return "absolute text-sm text-[#93aad4]";
    if (style & S_LINK) return "absolute text-sm text-[#93aad4]";
    return "absolute text-sm text-[#a2a8b2]";
  }
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
    default:
      break;
  }
  if (style & S_CODE) return "absolute text-sm font-mono text-[#8a2b2b]";
  if (style & S_TAG) return "absolute text-sm text-[#7a5ea8] font-bold";
  if (style & S_WIKI) return "absolute text-sm text-[#2a63c8] font-bold";
  if (style & S_LINK) return "absolute text-sm text-[#1b4fa8]";
  if (style & S_STRIKE) return "absolute text-sm text-[#9aa1ad]";
  if (style & S_BOLD) return "absolute text-sm text-[#1c1c1e] font-bold";
  if (style & S_ITALIC) return "absolute text-sm text-[#3a3f47]";
  if (kind === K_QUOTE) return "absolute text-sm text-[#42506b]";
  return "absolute text-sm text-[#1c1c1e]";
}

/** The selection's [x0, x1] on a row, or null. Every row can carry it, since
 *  every row maps to source columns. */
function selectionSpan(store: VaultStore, row: Row): [number, number] | null {
  const anchor = store.anchor();
  const head = store.caret();
  if (!anchor || !head) return null;
  const [from, to] =
    anchor.line < head.line || (anchor.line === head.line && anchor.col <= head.col)
      ? [anchor, head]
      : [head, anchor];
  if (from.line === to.line && from.col === to.col) return null;
  if (row.l < from.line || row.l > to.line) return null;
  const start = row.l === from.line ? from.col : row.s;
  const end = row.l === to.line ? to.col : rowSourceEnd(row);
  const x0 = caretX(row, Math.max(row.s, start), measure);
  const x1 = caretX(row, Math.min(rowSourceEnd(row), end), measure);
  if (x0 === null || x1 === null || x1 <= x0) return null;
  return [x0, x1];
}

function Checkbox(props: { done: boolean; x: number; top: number }) {
  return (
    <View class={props.done ? T.CHECKBOX_ON : T.CHECKBOX} style={{ insetL: props.x, insetT: props.top }}>
      <Show when={props.done}>
        <View class={T.CHECKBOX_TICK_A} style={{ insetL: 2, insetT: 5, rotate: -45 }} />
        <View class={T.CHECKBOX_TICK_B} style={{ insetL: 7, insetT: 1, rotate: 40 }} />
      </Show>
    </View>
  );
}

function RowView(props: { store: VaultStore; index: number }) {
  const store = props.store;
  const row = (): Row | undefined => store.rowAt(props.index);
  const top = (): number => store.tops()[props.index] ?? 0;
  const kind = (): number => row()?.k ?? K_BLANK;
  const height = (): number => ROW_H[kind()] ?? 18;
  const kindAt = (index: number): number => {
    const kinds = store.doc()?.kinds ?? "";
    return index < 0 || index >= kinds.length ? -1 : KIND_CHARS.indexOf(kinds[index]!);
  };
  const boxed = (): boolean => kindIsBoxed(kind());
  const boxFirst = (): boolean => kindAt(props.index - 1) !== kind();
  const boxLast = (): boolean => kindAt(props.index + 1) !== kind();
  const callout = (): boolean => kind() === K_QUOTE || kind() === K_TASK;
  const onCaretLine = (): boolean => {
    const caret = store.caret();
    const r = row();
    return caret !== null && r !== undefined && r.l === caret.line && store.deck() === "edit";
  };
  const caretPos = (): number | null => {
    const caret = store.caret();
    const r = row();
    if (!caret || !r || r.l !== caret.line) return null;
    // A column exactly at a row's end belongs to the next row of the same
    // line, unless this is that line's last row.
    const next = store.rowAt(props.index + 1);
    if (caret.col === rowSourceEnd(r) && next?.l === r.l) return null;
    return caretX(r, caret.col, measure);
  };
  const selection = (): [number, number] | null => {
    const r = row();
    return r ? selectionSpan(store, r) : null;
  };
  return (
    <View class={onCaretLine() ? T.DOC_ROW_CARET : T.DOC_ROW} style={{ insetT: top(), height: height() }}>
      <Show when={boxed()}>
        <View class={callout() ? T.BOX_CALLOUT : T.BOX_CODE} style={{ insetT: 0, height: height() }} />
        <Show when={callout()}>
          <View class={T.BOX_CALLOUT_BAR} />
          <View class={T.BOX_CALLOUT_BAR_R} />
        </Show>
        <Show when={boxFirst()}>
          <View class={callout() ? T.BOX_CALLOUT_EDGE : T.BOX_CODE_EDGE} style={{ insetT: 0 }} />
        </Show>
        <Show when={boxLast()}>
          <View class={callout() ? T.BOX_CALLOUT_EDGE : T.BOX_CODE_EDGE} style={{ insetT: height() - 1 }} />
        </Show>
      </Show>
      <Show when={selection()}>
        {(span) => (
          <View
            class={T.DOC_SELECTION}
            style={{ insetL: DOC_PAD_X + span()[0], width: Math.max(2, span()[1] - span()[0]) }}
          />
        )}
      </Show>
      <Show when={row()}>
        {(r) => (
          <For each={r().r}>
            {(run) =>
              run[2] & S_TASK ? (
                <Checkbox done={(run[2] & S_TASK_DONE) !== 0} x={DOC_PAD_X + run[0]} top={3} />
              ) : run[1] === "" ? (
                <View />
              ) : (
                <Text
                  class={runClass(r().k, run[2])}
                  style={{ insetL: DOC_PAD_X + run[0], insetT: ROW_TEXT_TOP[r().k] ?? 1 }}
                >
                  {run[1]}
                </Text>
              )
            }
          </For>
        )}
      </Show>
      <Show when={kind() === K_HR}>
        <View class={T.DOC_HR} />
      </Show>
      <Show when={caretPos() !== null}>
        <View
          class={T.DOC_CARET}
          style={{ insetL: DOC_PAD_X + (caretPos() ?? 0), insetT: 1, height: height() - 3 }}
        />
      </Show>
    </View>
  );
}

/** The title's box, between the two shoulder buttons and the status dot. */
const TITLE_X = 4 + T.NAV_LEFT_W + 12;
const TITLE_W = STAGE_W - TITLE_X - T.NAV_RIGHT_W - 8;

function titleLeft(title: string): number {
  const width = measure(title, "bold", 16);
  return width >= TITLE_W ? 0 : Math.round((TITLE_W - width) / 2);
}

function range(first: number, last: number): number[] {
  const out: number[] = [];
  for (let i = first; i <= last; i++) out.push(i);
  return out;
}

/** One navigation-bar button: a shoulder pill and a label, in the order the
 *  console's own buttons sit — L on the left of its label, R on the right. */
function NavButton(props: {
  side: "left" | "right";
  letter: string;
  label: string;
  x: number;
  width: number;
  on: boolean;
}) {
  const pillX = () => (props.side === "left" ? 1 : props.width - T.PILL_W - 1);
  const labelLeft = () => (props.side === "left" ? T.PILL_W + 2 : 4);
  const labelWidth = () => props.width - T.PILL_W - 6;
  return (
    <View class={props.on ? T.NAV_BUTTON_ON : T.NAV_BUTTON} style={{ insetL: props.x, width: props.width }}>
      <View class={T.NAV_BUTTON_GLOSS} />
      <View class={T.PILL} style={{ insetL: pillX() }}>
        <Text class={T.PILL_TEXT}>{props.letter}</Text>
      </View>
      <Text class={T.NAV_BUTTON_LABEL_SHADOW} style={{ insetL: labelLeft(), width: labelWidth() }}>
        {props.label}
      </Text>
      <Text class={T.NAV_BUTTON_LABEL} style={{ insetL: labelLeft(), width: labelWidth() }}>
        {props.label}
      </Text>
    </View>
  );
}

function Menu(props: { store: VaultStore }) {
  const store = props.store;
  const left = () => (store.menu() === "vault" ? 4 : STAGE_W - T.MENU_W - 4);
  const height = () => store.menuItems().length * T.MENU_ROW_H + 2;
  return (
    <View class={T.MENU} style={{ insetL: left(), insetT: T.MENU_TOP, width: T.MENU_W, height: height() }}>
      <For each={store.menuItems()}>
        {(item, i) => (
          <View
            class={store.menuIndex() === i() ? T.MENU_ROW_ON : T.MENU_ROW}
            style={{ insetT: 1 + i() * T.MENU_ROW_H }}
          >
            <Text class={store.menuIndex() === i() ? T.MENU_TEXT_ON : T.MENU_TEXT}>{item.label}</Text>
            <Show when={item.hint}>
              <Text class={store.menuIndex() === i() ? T.MENU_HINT_ON : T.MENU_HINT}>{item.hint}</Text>
            </Show>
          </View>
        )}
      </For>
    </View>
  );
}

export function Stage(props: { store: VaultStore }) {
  const store = props.store;
  const indices = (): number[] => {
    const [first, last] = store.visibleRange();
    return last < first ? [] : range(first, last);
  };
  const title = (): string => store.doc()?.title ?? "Pocket Vault";
  const dot = (): string => {
    const status = store.mac.status();
    return status === "linked" ? T.DOT_LINKED : status === "searching" ? T.DOT_SEARCHING : T.DOT_ABSENT;
  };
  return (
    <View debugName="Stage" class={T.SCREEN}>
      {/* the document */}
      <View class="absolute left-0 right-0 bottom-0 bg-white overflow-hidden" style={{ insetT: DOC_TOP }}>
        <Show when={store.doc()} fallback={<Splash store={store} />}>
          <View
            debugName="DocCanvas"
            class="absolute left-0 right-0 top-0"
            style={{ translateY: -store.scroller.offset(), height: store.docHeight() + DOC_VIEW_H }}
          >
            <For each={indices()}>{(index) => <RowView store={store} index={index} />}</For>
          </View>
          <View class={T.PAGE_BADGE} style={{ width: 46 }}>
            <Text class={T.PAGE_TEXT}>
              {store.page()}/{store.pages()}
            </Text>
          </View>
        </Show>
      </View>

      {/* the navigation bar */}
      <View class={T.NAV}>
        <View class={T.NAV_HI} />
        <View class={T.NAV_LO} />
        <View class={T.NAV_RULE_TOP} />
        <View class={T.NAV_RULE_BOTTOM} />
        <NavButton
          side="left"
          letter="L"
          label="Vault"
          x={4}
          width={T.NAV_LEFT_W}
          on={store.menu() === "vault"}
        />
        {/* The title is centred when it fits and left-aligned when it does
            not, because a long note name clipped from both ends reads as
            neither its start nor its end. */}
        <View class={T.CLIP} style={{ insetL: TITLE_X, insetT: 0, width: TITLE_W, height: T.NAV_H }}>
          <Text class={T.NAV_TITLE_SHADOW} style={{ insetL: titleLeft(title()) }}>
            {title()}
          </Text>
          <Text class={T.NAV_TITLE} style={{ insetL: titleLeft(title()) }}>
            {title()}
          </Text>
        </View>
        <NavButton
          side="right"
          letter="R"
          label="Actions"
          x={STAGE_W - T.NAV_RIGHT_W - 4}
          width={T.NAV_RIGHT_W}
          on={store.menu() === "actions"}
        />
        <View class={dot()} style={{ insetL: TITLE_X - 10, insetT: 12 }} />
      </View>

      <Show when={store.menu() !== null}>
        <Menu store={store} />
      </Show>
    </View>
  );
}

function Splash(props: { store: VaultStore }) {
  return (
    <View class="absolute left-0 right-0 top-0 bottom-0 flex-col items-center justify-center bg-[#f2f3f6]">
      <Text class={T.SPLASH_TITLE}>Pocket Vault</Text>
      <Text class={T.SPLASH_SUB}>{props.store.linkLabel()}</Text>
      <Text class={T.SPLASH_HINT}>pick a note below · hold L or R for a menu</Text>
      <Text class={T.SPLASH_HINT}>tap L or R to turn a page</Text>
    </View>
  );
}
