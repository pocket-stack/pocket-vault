// app/deck.tsx — the bottom screen: every control, none of the content.
//
// The top screen cannot be touched, so the deck lends it the iPod deck's
// trick — a trackpad that scrolls what is above it — and Pocket Shell's:
// a minimap of the whole note to jump by, and a strip of tabs that changes
// with the state of the top screen. In edit mode the deck is the keyboard;
// the d-pad moves the caret, and the echo strip shows the raw line under it.
//
// Three recognizers, each with a rect that follows the mode so no two ever
// see the same contact: taps for the tabs, the search box and the keys;
// pans for the trackpad; pans for the minimap. The file and outline lists
// are VirtualLists with their own recognizers inside their own rects.

import { createMemo, createSignal, For, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { createScroller } from "@pocketjs/framework/kinetics";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { VirtualList } from "@pocketjs/framework/virtual-list";
import type { SurfaceId } from "@pocketjs/framework/display";
import { DECK_H, DECK_W, KIND_CHARS, MAP_BUCKETS, STAGE_H, type OutlineItem } from "./protocol.ts";
import { createKeyPress, Keyboard, keyboardHit, type KeyAction } from "./keyboard.tsx";
import type { Mode, VaultStore } from "./store.ts";

/** The deck lives on the auxiliary (touch) screen; the sim harness, which
 *  hosts one surface at a time, mounts it on the primary one instead. */
const SURFACE: SurfaceId = ((globalThis as { __vaultDeckSurface?: SurfaceId }).__vaultDeckSurface ?? "auxiliary");
const STATUS_H = 24;
const TABS_Y = 24;
const TABS_H = 24;
const CONTENT_Y = TABS_Y + TABS_H; // 48
const CONTENT_H = DECK_H - CONTENT_Y; // 192
const SEARCH_H = 26;
const LIST_Y = CONTENT_Y + SEARCH_H; // 74
const LIST_H = DECK_H - LIST_Y; // 166
const FILE_ROW_H = 28;
const OUTLINE_ROW_H = 22;
const MAP_W = 40;
const PAD_X = MAP_W;
const PAD_W = DECK_W - MAP_W;
/** Trackpad px → document px. A little over 1:1 so a full swipe of the pad
 *  moves more than one screen. */
const PAD_GAIN = 1.4;
const TAB_W = DECK_W / 4;

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

function tabClass(active: boolean): string {
  return active
    ? "absolute top-0 h-[24] items-center justify-center bg-[#26233a]"
    : "absolute top-0 h-[24] items-center justify-center";
}

function tabText(active: boolean): string {
  return active ? "text-xs text-[#e0def4] font-bold" : "text-xs text-[#908caa]";
}

export function Deck(props: { store: VaultStore }) {
  const store = props.store;
  const keys = createKeyPress();
  const mode = store.mode;

  // ── recognizer rects follow the mode ──
  const tapRect = (): Rect => {
    switch (mode()) {
      case "files":
        return { x: 0, y: 0, w: DECK_W, h: LIST_Y };
      case "search":
      case "edit":
        return { x: 0, y: 0, w: DECK_W, h: DECK_H };
      default:
        return { x: 0, y: 0, w: DECK_W, h: CONTENT_Y };
    }
  };
  const padRect = (): Rect | null =>
    mode() === "read" ? { x: PAD_X, y: CONTENT_Y, w: PAD_W, h: CONTENT_H } : null;
  const mapRect = (): Rect | null =>
    mode() === "read" ? { x: 0, y: CONTENT_Y, w: MAP_W, h: CONTENT_H } : null;

  const onKey = (act: KeyAction): void => {
    if ("done" in act) {
      store.setMode(mode() === "search" ? "files" : "read");
      return;
    }
    if ("layer" in act) {
      store.setKbLayer(act.layer);
      return;
    }
    const layer = store.kbLayer();
    const text = "ch" in act ? act.ch : act.key === "space" ? " " : act.key === "tab" ? "  " : act.key === "enter" ? "\n" : null;
    if (mode() === "search") {
      if ("key" in act && act.key === "backspace") store.setQuery(store.query().slice(0, -1));
      else if ("key" in act && act.key === "enter") store.setMode("files");
      else if (text !== null) store.setQuery(store.query() + text);
    } else {
      if ("key" in act && act.key === "backspace") store.backspace();
      else if (text !== null) store.type(text);
    }
    if (layer === "upper") store.setKbLayer("lower");
  };

  createGesture({
    surface: SURFACE,
    region: { rect: tapRect },
    tapSlop: 8,
    onTap: (c) => {
      if (c.y >= TABS_Y && c.y < CONTENT_Y) {
        const tab = TABS[Math.min(3, Math.floor(c.x / TAB_W))]!;
        if (tab.mode === "edit") store.enterEdit();
        else if (tab.mode === "read" && !store.doc()) store.setMode("files");
        else store.setMode(tab.mode);
        return;
      }
      if (c.y < TABS_Y) return;
      if (mode() === "files" && c.y < LIST_Y) {
        store.setMode("search");
        return;
      }
      if (mode() === "search" || mode() === "edit") {
        const hit = keyboardHit(c.x, c.y, store.kbLayer());
        if (!hit) return;
        keys.press(hit);
        onKey(hit.act);
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

  const mapTo = (y: number): void => {
    const f = (y - CONTENT_Y - 6) / (CONTENT_H - 12);
    store.scrollToFraction(f);
  };
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
  const echo = (): string => (mode() === "search" ? `search: ${store.query()}` : store.activeLineText());

  return (
    <View debugName="Deck" class="relative w-full h-full bg-[#191724] overflow-hidden">
      {/* status strip */}
      <View class="absolute left-0 right-0 top-0 h-[24] bg-[#1f1d2e] overflow-hidden">
        <View
          class={
            store.mac.status() === "linked"
              ? "absolute left-[8] top-[9] w-[6] h-[6] rounded-full bg-[#9ccfd8]"
              : "absolute left-[8] top-[9] w-[6] h-[6] rounded-full bg-[#eb6f92]"
          }
        />
        <View class="absolute left-[20] top-0 h-[24] w-[150] overflow-hidden">
          <Text class="absolute left-0 top-[4] text-sm text-[#e0def4]">{title()}</Text>
        </View>
        <View class="absolute right-[8] top-0 h-[24] w-[140] overflow-hidden flex-row justify-end">
          <Text class="absolute right-0 top-[6] text-xs text-[#6e6a86]">{store.status()}</Text>
        </View>
      </View>

      {/* tabs */}
      <View class="absolute left-0 right-0 top-[24] h-[24] bg-[#191724]">
        <For each={TABS}>
          {(tab, i) => (
            <View class={tabClass(mode() === tab.mode || (tab.mode === "files" && mode() === "search"))} style={{ insetL: i() * TAB_W, width: TAB_W }}>
              <Text class={tabText(mode() === tab.mode || (tab.mode === "files" && mode() === "search"))}>{tab.label}</Text>
            </View>
          )}
        </For>
        <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#26233a]" />
      </View>

      {/* files */}
      <Show when={mode() === "files"}>
        <View class="absolute left-[6] right-[6] h-[22] rounded-[4] bg-[#26233a] border border-[#393552]" style={{ insetT: CONTENT_Y + 2 }}>
          <Text class="absolute left-[8] top-[3] text-sm text-[#908caa]">{store.query() === "" ? "Search" : store.query()}</Text>
        </View>
        <View class="absolute left-0 right-0 bottom-0" style={{ insetT: LIST_Y }}>
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
        <View class="absolute right-0 bottom-0 bg-[#1f1d2e]" style={{ insetL: PAD_X, insetT: CONTENT_Y }}>
          <Text class="absolute left-0 right-0 top-[80] text-center text-xs text-[#403d52]">drag to scroll · hold to edit</Text>
          <Text class="absolute left-0 right-0 top-[96] text-center text-xs text-[#403d52]">L/R page · B back · X edit · Y outline</Text>
        </View>
      </Show>

      {/* outline */}
      <Show when={mode() === "outline"}>
        <View class="absolute left-0 right-0 bottom-0" style={{ insetT: CONTENT_Y }}>
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

      {/* keyboard */}
      <Show when={mode() === "edit" || mode() === "search"}>
        <Keyboard store={store} pressed={keys.pressed} echo={echo} doneLabel="done" />
        <Text class="absolute left-0 right-0 top-[212] text-center text-xs text-[#403d52]">
          {mode() === "edit" ? "d-pad moves the caret · B done · START saves" : "enter to search the vault"}
        </Text>
      </Show>
    </View>
  );
}

function FileRow(props: { store: VaultStore; index: number }) {
  const item = () => props.store.listItem(props.index);
  const selected = () => props.store.selected() === props.index;
  return (
    <View class={selected() ? "absolute left-0 right-0 top-0 h-[28] bg-[#26233a]" : "absolute left-0 right-0 top-0 h-[28]"}>
      <Text class="absolute left-[10] top-[6] text-sm text-[#e0def4]">{item()?.title ?? ""}</Text>
      <Text class="absolute right-[10] top-[8] text-xs text-[#6e6a86]">{item() ? `${Math.round(item()!.size / 1024)} K` : "…"}</Text>
      <View class="absolute left-[10] right-0 bottom-0 h-[1] bg-[#1f1d2e]" />
    </View>
  );
}

function OutlineRow(props: { item: OutlineItem | undefined }) {
  const level = () => props.item?.level ?? 1;
  return (
    <View class="absolute left-0 right-0 top-0 h-[22]">
      <Text
        class={level() === 1 ? "absolute top-[3] text-sm text-[#e0def4] font-bold" : level() === 2 ? "absolute top-[4] text-xs text-[#e0def4]" : "absolute top-[4] text-xs text-[#908caa]"}
        style={{ insetL: 10 + (level() - 1) * 12 }}
      >
        {props.item?.text ?? ""}
      </Text>
    </View>
  );
}

function Minimap(props: { store: VaultStore }) {
  const store = props.store;
  // 96 buckets on 180 px would be sub-pixel bars; pairs are averaged into
  // 48 bars of 2 px with a 1 px gap, which reads as the note's silhouette.
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
  const viewH = () => Math.max(8, Math.round((STAGE_H / Math.max(STAGE_H, store.docHeight())) * (CONTENT_H - 12)));
  const viewY = () => CONTENT_Y + 6 + Math.round(store.scrollFraction() * (CONTENT_H - 12 - viewH()));
  return (
    <View class="absolute left-0 bottom-0 bg-[#191724]" style={{ width: MAP_W, insetT: CONTENT_Y }}>
      <For each={buckets()}>
        {(density, i) => (
          <View
            class="absolute left-[4] h-[2] bg-[#6e6a86]"
            style={{ insetT: 6 + Math.round(i() * ((CONTENT_H - 12) / (MAP_BUCKETS / 2))), width: 3 + Math.round((density / 35) * 28) }}
          />
        )}
      </For>
      <View class="absolute left-[1] w-[38] rounded-[2] border border-[#c4a7e7] bg-[#c4a7e722]" style={{ insetT: viewY() - CONTENT_Y, height: viewH() }} />
    </View>
  );
}
