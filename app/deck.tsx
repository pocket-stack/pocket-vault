// app/deck.tsx — the bottom screen: every control, none of the content.
//
// The top screen cannot be touched, so the deck lends it the iPod deck's
// trick — a trackpad that drives what is above it — and Pocket Shell's: a
// minimap of the whole note to jump by, and a segmented control that
// follows the state of the top screen. In edit mode the deck is a short
// keyboard over a trackpad: a pan on the pad moves the caret by character
// and row, a Select toggle beside it turns the same pan into a drag-select,
// and the d-pad does the same with buttons.
//
// Recognizers each have a rect that follows the mode so no two ever see the
// same contact: taps for the nav bar, the segments, the field and the keys;
// pans for the read-mode trackpad; pans for the minimap; pans for the caret
// pad. The file and outline lists are VirtualLists with their own
// recognizers inside their own rects. Colours and control shapes come from
// app/theme.ts.

import { createMemo, For, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { createScroller } from "@pocketjs/framework/kinetics";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { VirtualList } from "@pocketjs/framework/virtual-list";
import type { SurfaceId } from "@pocketjs/framework/display";
import { DECK_H, DECK_W, KIND_CHARS, MAP_BUCKETS, STAGE_H, type OutlineItem } from "./protocol.ts";
import { createKeyPress, KB_BOTTOM, Keyboard, keyboardHit, type KeyAction } from "./keyboard.tsx";
import type { Mode, VaultStore } from "./store.ts";
import * as T from "./theme.ts";

/** The deck lives on the auxiliary (touch) screen; the sim harness, which
 *  hosts one surface at a time, mounts it on the primary one instead. */
const SURFACE: SurfaceId = (globalThis as { __vaultDeckSurface?: SurfaceId }).__vaultDeckSurface ?? "auxiliary";

const CONTENT_H = DECK_H - T.CONTENT_Y; // 178
const SEARCH_Y = T.CONTENT_Y + 2;
const LIST_Y = T.CONTENT_Y + 30; // 92
const LIST_H = DECK_H - LIST_Y; // 148
const FILE_ROW_H = 28;
const OUTLINE_ROW_H = 22;
const WELL_Y = T.CONTENT_Y + 4;
const WELL_H = DECK_H - WELL_Y - 4;
const MAP_X = 4;
const MAP_W = 40;
const PAD_X = 50;
const PAD_W = DECK_W - PAD_X - 4;
/** Trackpad px → document px. A little over 1:1 so a full swipe of the pad
 *  moves more than one screen. */
const PAD_GAIN = 1.4;
/** Caret pad: px of travel per character column and per row. */
const CARET_COL_PX = 9;
const CARET_ROW_PX = 16;
const CPAD_Y = KB_BOTTOM + 2; // 172
const CPAD_H = DECK_H - CPAD_Y - 4; // 64
const CPAD_W = 240;
const SIDE_X = CPAD_W + 12; // 252
const SIDE_W = DECK_W - SIDE_X - 6;
const SIDE_BTN_H = 19;
const SEG_X = 6;
const SEG_W = DECK_W - 12;
const SHEET_W = 280;
const SHEET_H = 172;
const SHEET_X = (DECK_W - SHEET_W) / 2;
const SHEET_Y = (DECK_H - SHEET_H) / 2;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const TABS: Array<{ mode: Mode; label: string }> = [
  { mode: "files", label: "Files" },
  { mode: "read", label: "Read" },
  { mode: "outline", label: "Outline" },
  { mode: "edit", label: "Edit" },
];

export function Deck(props: { store: VaultStore }) {
  const store = props.store;
  const keys = createKeyPress();
  const mode = store.mode;
  const tabOn = (tab: Mode): boolean => mode() === tab || (tab === "files" && mode() === "search");

  // ── recognizer rects follow the mode ──
  const tapRect = (): Rect => {
    if (store.sheetOpen()) return { x: 0, y: 0, w: DECK_W, h: DECK_H };
    switch (mode()) {
      case "files":
        return { x: 0, y: 0, w: DECK_W, h: LIST_Y };
      case "search":
      case "edit":
        return { x: 0, y: 0, w: DECK_W, h: DECK_H };
      default:
        return { x: 0, y: 0, w: DECK_W, h: T.CONTENT_Y };
    }
  };
  const padRect = (): Rect | null =>
    !store.sheetOpen() && mode() === "read" ? { x: PAD_X, y: WELL_Y, w: PAD_W, h: WELL_H } : null;
  const mapRect = (): Rect | null =>
    !store.sheetOpen() && mode() === "read" ? { x: MAP_X, y: WELL_Y, w: MAP_W, h: WELL_H } : null;
  const caretPadRect = (): Rect | null =>
    !store.sheetOpen() && mode() === "edit" ? { x: 6, y: CPAD_Y, w: CPAD_W, h: CPAD_H } : null;

  const onKey = (act: KeyAction): void => {
    if ("layer" in act) {
      store.setKbLayer(act.layer);
      return;
    }
    const layer = store.kbLayer();
    const text = "ch" in act ? act.ch : act.key === "space" ? " " : act.key === "enter" ? "\n" : null;
    if (mode() === "search") {
      if ("key" in act && act.key === "backspace") store.setQuery(store.query().slice(0, -1));
      else if ("key" in act && act.key === "enter") store.setMode("files");
      else if (text !== null) store.setQuery(store.query() + text);
    } else {
      if ("key" in act && act.key === "backspace") store.backspace();
      else if (text !== null) store.insert(text);
    }
    if (layer === "upper") store.setKbLayer("lower");
  };

  const sideButtonAt = (y: number): 0 | 1 | 2 | null => {
    for (let i = 0; i < 3; i++) {
      const top = CPAD_Y + i * (SIDE_BTN_H + 3);
      if (y >= top && y < top + SIDE_BTN_H) return i as 0 | 1 | 2;
    }
    return null;
  };

  createGesture({
    surface: SURFACE,
    region: { rect: tapRect },
    tapSlop: 8,
    onTap: (c) => {
      if (store.sheetOpen()) {
        const inside = c.x >= SHEET_X && c.x < SHEET_X + SHEET_W && c.y >= SHEET_Y && c.y < SHEET_Y + SHEET_H;
        if (!inside || c.y >= SHEET_Y + SHEET_H - 30) {
          if (inside && c.x < SHEET_X + SHEET_W / 2) store.save();
          store.setSheetOpen(false);
        }
        return;
      }
      if (c.y < T.NAV_H) {
        if (c.x >= DECK_W - 60) store.setSheetOpen(true);
        return;
      }
      if (c.y >= T.SEG_Y && c.y < T.SEG_Y + T.SEG_H) {
        const tab = TABS[Math.min(3, Math.floor((c.x - SEG_X) / (SEG_W / 4)))]!;
        if (tab.mode === "edit") store.enterEdit();
        else if (tab.mode === "read" && !store.doc()) store.setMode("files");
        else store.setMode(tab.mode);
        return;
      }
      if (c.y < T.CONTENT_Y) return;
      if (mode() === "files") {
        if (c.y < LIST_Y) store.setMode("search");
        return;
      }
      if (mode() === "search" || mode() === "edit") {
        if (c.y < KB_BOTTOM) {
          const hit = keyboardHit(c.x, c.y, store.kbLayer());
          if (!hit) return;
          keys.press(hit);
          onKey(hit.act);
          return;
        }
        if (mode() === "search") {
          if (c.x >= DECK_W - 70) store.setMode("files");
          return;
        }
        if (c.x >= SIDE_X) {
          const button = sideButtonAt(c.y);
          if (button === 0) store.setSelecting(!store.selecting());
          else if (button === 1) store.save();
          else if (button === 2) store.leaveEdit();
        }
      }
    },
  });

  createGesture({
    surface: SURFACE,
    region: { rect: padRect },
    axis: "y",
    tapSlop: 6,
    panSlop: 4,
    longPressSeconds: 0.5,
    onDown: () => store.scroller.stop(),
    onPanStart: () => store.scroller.beginDrag(),
    onPanMove: (c) => store.scroller.drag(-c.fdy * PAD_GAIN),
    onPanEnd: (c) => store.scroller.endDrag(-c.vy * PAD_GAIN),
    onLongPress: () => store.enterEdit(),
    onCancel: () => store.scroller.endDrag(0),
  });

  const mapTo = (y: number): void => store.scrollToFraction((y - WELL_Y - 6) / (WELL_H - 12));
  createGesture({
    surface: SURFACE,
    region: { rect: mapRect },
    axis: "y",
    panSlop: 1,
    onDown: (c) => {
      store.scroller.stop();
      mapTo(c.y);
    },
    onPanMove: (c) => mapTo(c.y),
  });

  // The caret pad: travel accumulates and spends itself in whole columns
  // and rows, so a slow stylus moves one character at a time and a fast one
  // sweeps. With Select on, the anchor stays where it was.
  let padDx = 0;
  let padDy = 0;
  createGesture({
    surface: SURFACE,
    region: { rect: caretPadRect },
    panSlop: 2,
    onPanStart: () => {
      padDx = 0;
      padDy = 0;
    },
    onPanMove: (c) => {
      padDx += c.fdx;
      padDy += c.fdy;
      while (padDx >= CARET_COL_PX) {
        store.moveCaret(1, 0);
        padDx -= CARET_COL_PX;
      }
      while (padDx <= -CARET_COL_PX) {
        store.moveCaret(-1, 0);
        padDx += CARET_COL_PX;
      }
      while (padDy >= CARET_ROW_PX) {
        store.moveCaret(0, 1);
        padDy -= CARET_ROW_PX;
      }
      while (padDy <= -CARET_ROW_PX) {
        store.moveCaret(0, -1);
        padDy += CARET_ROW_PX;
      }
    },
  });

  // ── lists ──
  const listScroller = createScroller({
    max: () => Math.max(0, store.listTotal() * FILE_ROW_H - LIST_H),
    extent: () => LIST_H,
  });
  onFrame(() => {
    if (mode() === "files") store.setListViewport(Math.floor(listScroller.offset() / FILE_ROW_H));
  });
  const outlineItems = createMemo<OutlineItem[]>(() => store.outline() ?? []);
  const outlineScroller = createScroller({
    max: () => Math.max(0, outlineItems().length * OUTLINE_ROW_H - CONTENT_H),
    extent: () => CONTENT_H,
  });

  const title = (): string => store.doc()?.title ?? "Pocket Vault";
  const dotClass = (): string => {
    const s = store.mac.status();
    return s === "linked" ? T.DOT_LINKED : s === "searching" ? T.DOT_SEARCHING : T.DOT_ABSENT;
  };

  return (
    <View debugName="Deck" class={T.SCREEN}>
      {/* navigation bar */}
      <View class={T.NAV}>
        <View class={T.NAV_HI} />
        <View class={T.NAV_LO} />
        <View class={T.NAV_RULE_TOP} />
        <View class={T.NAV_RULE_BOTTOM} />
        <View class={dotClass()} style={{ insetL: 10, insetT: 12 }} />
        <View class="absolute left-[24] top-0 h-[32] w-[212] overflow-hidden">
          <Text class="absolute left-0 top-[6] text-base text-[#3c4d6480] font-bold">{title()}</Text>
          <Text class="absolute left-0 top-[7] text-base text-white font-bold">{title()}</Text>
        </View>
        <View class={T.NAV_BUTTON} style={{ insetL: DECK_W - 54, width: 48 }}>
          <View class={T.NAV_BUTTON_GLOSS} />
          <Text class={T.NAV_BUTTON_TEXT_SHADOW}>Info</Text>
          <Text class={T.NAV_BUTTON_TEXT}>Info</Text>
        </View>
      </View>

      {/* segmented control */}
      <View class={T.SEG} style={{ insetL: SEG_X, insetT: T.SEG_Y, width: SEG_W }}>
        <For each={TABS}>
          {(tab, i) => (
            <>
              <Show when={tabOn(tab.mode) && (i() === 0 || i() === TABS.length - 1)}>
                <View class={T.SEG_ITEM_ON_PATCH} style={{ insetL: i() === 0 ? SEG_W / 4 - 6 : i() * (SEG_W / 4) }} />
              </Show>
              <View
                class={tabOn(tab.mode) ? (i() === 0 || i() === TABS.length - 1 ? T.SEG_ITEM_ON_END : T.SEG_ITEM_ON) : T.SEG_ITEM}
                style={{ insetL: i() * (SEG_W / 4), width: SEG_W / 4 }}
              >
                <Text class={tabOn(tab.mode) ? T.SEG_TEXT_ON : T.SEG_TEXT}>{tab.label}</Text>
              </View>
              <Show when={i() > 0}>
                <View class={T.SEG_DIVIDER} style={{ insetL: i() * (SEG_W / 4) - 1 }} />
              </Show>
            </>
          )}
        </For>
      </View>

      {/* files */}
      <Show when={mode() === "files"}>
        <View class={T.FIELD} style={{ insetL: 6, insetT: SEARCH_Y, width: DECK_W - 12 }}>
          <Show when={store.query() === ""} fallback={<Text class={T.FIELD_TEXT}>{store.query()}</Text>}>
            <Text class={T.FIELD_PLACEHOLDER}>Search</Text>
          </Show>
        </View>
        <View class="absolute left-0 right-0 bottom-0 bg-white" style={{ insetT: LIST_Y }}>
          <VirtualList
            surface={SURFACE}
            controller={listScroller}
            count={store.listTotal()}
            rowHeight={FILE_ROW_H}
            height={LIST_H}
            overscan={FILE_ROW_H * 2}
            focusRows={false}
            renderRow={(index) => <FileRow store={store} index={index} />}
            onRowPress={(index) => store.select(index)}
          />
        </View>
      </Show>

      {/* read: minimap + trackpad */}
      <Show when={mode() === "read"}>
        <Minimap store={store} />
        <View class={T.WELL} style={{ insetL: PAD_X, insetT: WELL_Y, width: PAD_W, height: WELL_H }}>
          <Text class={T.WELL_HINT} style={{ insetT: 70 }}>drag to scroll · hold to edit</Text>
          <Text class={T.WELL_HINT} style={{ insetT: 86 }}>L/R page · B back · X edit · Y outline</Text>
        </View>
      </Show>

      {/* outline */}
      <Show when={mode() === "outline"}>
        <View class="absolute left-0 right-0 bottom-0 bg-white" style={{ insetT: T.CONTENT_Y }}>
          <VirtualList
            surface={SURFACE}
            controller={outlineScroller}
            count={outlineItems().length}
            rowHeight={OUTLINE_ROW_H}
            height={CONTENT_H}
            overscan={OUTLINE_ROW_H * 2}
            focusRows={false}
            renderRow={(index) => <OutlineRow item={outlineItems()[index]} />}
            onRowPress={(index) => {
              const item = outlineItems()[index];
              if (!item) return;
              store.jumpToRow(item.row);
              store.setMode("read");
            }}
          />
        </View>
      </Show>

      {/* keyboard, and what sits below it */}
      <Show when={mode() === "edit" || mode() === "search"}>
        <Keyboard store={store} pressed={keys.pressed} />
      </Show>
      <Show when={mode() === "search"}>
        <View class={T.FIELD} style={{ insetL: 6, insetT: CPAD_Y + 4, width: DECK_W - 84 }}>
          <Show when={store.query() === ""} fallback={<Text class={T.FIELD_TEXT}>{store.query()}</Text>}>
            <Text class={T.FIELD_PLACEHOLDER}>Search the vault</Text>
          </Show>
        </View>
        <View class={T.BUTTON} style={{ insetL: DECK_W - 70, insetT: CPAD_Y + 4, width: 64, height: 24 }}>
          <Text class={T.BUTTON_TEXT}>Cancel</Text>
        </View>
        <Text class={T.WELL_HINT} style={{ insetT: CPAD_Y + 38 }}>return searches · matches rank by relevance</Text>
      </Show>
      <Show when={mode() === "edit"}>
        <View class={T.WELL} style={{ insetL: 6, insetT: CPAD_Y, width: CPAD_W, height: CPAD_H }}>
          <Text class={T.WELL_HINT} style={{ insetT: 18 }}>{store.selecting() ? "drag to select" : "drag to move the caret"}</Text>
          <Text class={T.WELL_HINT} style={{ insetT: 34 }}>{store.unconfirmed() > 0 ? `${store.unconfirmed()} edit(s) on the way` : "B done · X select · START save"}</Text>
        </View>
        <View class={store.selecting() ? T.BUTTON_ON : T.BUTTON} style={{ insetL: SIDE_X, insetT: CPAD_Y, width: SIDE_W, height: SIDE_BTN_H }}>
          <Text class={store.selecting() ? T.BUTTON_TEXT_ON : T.BUTTON_TEXT}>Select</Text>
        </View>
        <View class={T.BUTTON} style={{ insetL: SIDE_X, insetT: CPAD_Y + SIDE_BTN_H + 3, width: SIDE_W, height: SIDE_BTN_H }}>
          <Text class={T.BUTTON_TEXT}>Save</Text>
        </View>
        <View class={T.BUTTON} style={{ insetL: SIDE_X, insetT: CPAD_Y + 2 * (SIDE_BTN_H + 3), width: SIDE_W, height: SIDE_BTN_H }}>
          <Text class={T.BUTTON_TEXT}>Done</Text>
        </View>
      </Show>

      {/* status & settings */}
      <Show when={store.sheetOpen()}>
        <View class={T.SHEET_DIM} />
        <Sheet store={store} />
      </Show>
    </View>
  );
}

function FileRow(props: { store: VaultStore; index: number }) {
  const item = () => props.store.listItem(props.index);
  const on = () => props.store.selected() === props.index;
  return (
    <View class={on() ? T.CELL_ON : T.CELL} style={{ height: 28 }}>
      <Text class={on() ? T.CELL_TEXT_ON : T.CELL_TEXT}>{item()?.title ?? ""}</Text>
      <Text class={on() ? T.CELL_META_ON : T.CELL_META}>{item() ? `${Math.round(item()!.size / 1024)} K` : "…"}</Text>
      <View class={on() ? T.CELL_RULE_ON : T.CELL_RULE} />
    </View>
  );
}

function OutlineRow(props: { item: OutlineItem | undefined }) {
  const level = () => props.item?.level ?? 1;
  return (
    <View class={T.CELL} style={{ height: 22 }}>
      <Text class={level() === 1 ? T.CELL_TEXT_BOLD : level() === 2 ? T.CELL_TEXT_SMALL : T.CELL_TEXT_DIM} style={{ insetL: 10 + (level() - 1) * 12 }}>
        {props.item?.text ?? ""}
      </Text>
      <View class={T.CELL_RULE} />
    </View>
  );
}

function Minimap(props: { store: VaultStore }) {
  const store = props.store;
  // 96 buckets on 170 px would be sub-pixel bars; pairs are averaged into
  // 48 bars of 2 px, which reads as the note's silhouette.
  const buckets = createMemo(() => {
    const map = store.doc()?.map ?? "";
    const out: number[] = [];
    for (let i = 0; i < MAP_BUCKETS; i += 2) {
      const a = KIND_CHARS.indexOf(map[i] ?? "0");
      const b = KIND_CHARS.indexOf(map[i + 1] ?? "0");
      out.push((a + b) / 2);
    }
    return out;
  });
  const pitch = (WELL_H - 12) / (MAP_BUCKETS / 2);
  const viewH = () => Math.max(8, Math.round((STAGE_H / Math.max(STAGE_H, store.docHeight())) * (WELL_H - 12)));
  const viewY = () => 6 + Math.round(store.scrollFraction() * (WELL_H - 12 - viewH()));
  return (
    <View class={T.WELL} style={{ insetL: MAP_X, insetT: WELL_Y, width: MAP_W, height: WELL_H }}>
      <For each={buckets()}>
        {(density, i) => (
          <View class={T.MINIMAP_BAR} style={{ insetL: 4, insetT: 6 + Math.round(i() * pitch), width: 3 + Math.round((density / 35) * 27) }} />
        )}
      </For>
      <View class={T.MINIMAP_VIEW} style={{ insetL: 1, insetT: viewY(), width: MAP_W - 4, height: viewH() }} />
    </View>
  );
}

function Sheet(props: { store: VaultStore }) {
  const store = props.store;
  const row = (label: string, value: () => string, i: number) => (
    <>
      <Text class={T.SHEET_LABEL} style={{ insetL: 14, insetT: 36 + i * 22 }}>{label}</Text>
      <View class="absolute overflow-hidden" style={{ insetL: 96, insetT: 36 + i * 22, width: SHEET_W - 108, height: 18 }}>
        <Text class={T.SHEET_VALUE}>{value()}</Text>
      </View>
      <View class={T.SHEET_RULE} style={{ insetT: 54 + i * 22 }} />
    </>
  );
  return (
    <View class={T.SHEET} style={{ insetL: SHEET_X, insetT: SHEET_Y, width: SHEET_W, height: SHEET_H }}>
      <Text class={T.SHEET_TITLE}>Pocket Vault</Text>
      {row("Companion", () => (store.mac.status() === "linked" ? store.mac.name() : "—"), 0)}
      {row("Link", () => store.mac.status(), 1)}
      {row("Notes", () => String(store.listTotal()), 2)}
      {row("Open note", () => (store.doc() ? `${store.doc()!.rows} rows · rev ${store.doc()!.rev}` : "none"), 3)}
      {row("Last error", () => store.lastError() ?? "none", 4)}
      <View class={T.BUTTON} style={{ insetL: 14, insetT: SHEET_H - 26, width: SHEET_W / 2 - 20, height: 20 }}>
        <Text class={T.BUTTON_TEXT}>Save now</Text>
      </View>
      <View class={T.BUTTON_ON} style={{ insetL: SHEET_W / 2 + 6, insetT: SHEET_H - 26, width: SHEET_W / 2 - 20, height: 20 }}>
        <Text class={T.BUTTON_TEXT_ON}>Close</Text>
      </View>
    </View>
  );
}
