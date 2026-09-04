// app/deck.tsx — the bottom screen: every control, none of the content.
//
// Browsing is two panes under a segmented control, the shape a file browser
// has had since Aqua: the left pane is an index, the right pane is what that
// index points at.
//
//   Files   folder tree            | notes in the selected folder
//   Links   the note's outline     | its outgoing links, then its backlinks
//   Tags    every tag with a count | notes carrying the selected tag
//
// A strip down the right edge is the document's scrubber: the note's density
// map with the viewport drawn on it, so the untouchable top screen keeps a
// touch path. Under the panes sits the toolbar — settings, New Note, New
// Folder, delete.
//
// Editing replaces all of it with a four-row keyboard over a caret pad: a pan
// on the pad moves the caret by character and by row, and the Select toggle
// beside it turns the same pan (and the d-pad) into a drag-select. Searching
// replaces it with a field, the results, and the same keyboard.
//
// While a shoulder is held, the deck mirrors that menu as touch rows, so the
// stylus can pick what the d-pad picks.
//
// Every recognizer carries a rect that follows the mode, so no two ever see
// the same contact.

import { createMemo, For, Show, type JSX as SolidJSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { createScroller, type Scroller } from "@pocketjs/framework/kinetics";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { VirtualList } from "@pocketjs/framework/virtual-list";
import type { SurfaceId } from "@pocketjs/framework/display";
import { createKeyPress, KB_H, Keyboard, keyboardHit, type KeyAction } from "./keyboard.tsx";
import { DECK_H, DECK_W, KIND_CHARS, MAP_BUCKETS, type LinkItem, type OutlineItem } from "./protocol.ts";
import type { Tab, TreeRow, VaultStore } from "./store.ts";
import * as T from "./theme.ts";

/** The deck lives on the auxiliary (touch) screen; the sim harness, which
 *  hosts one surface at a time, mounts it on the primary one instead. */
const SURFACE: SurfaceId = (globalThis as { __vaultDeckSurface?: SurfaceId }).__vaultDeckSurface ?? "auxiliary";

const TAB_W = T.TABS_W / 3;
const TREE_LIST_H = T.PANE_H - T.TREE_HEADER_H - T.TREE_FOOTER_H;
const LIST_H = T.PANE_H - T.TREE_HEADER_H;
/** Edit mode. */
const KB_TOP = 6;
const CPAD_Y = KB_TOP + KB_H + 4;
const CPAD_H = DECK_H - CPAD_Y - 6;
const CPAD_W = 248;
const SIDE_X = 258;
const SIDE_W = DECK_W - SIDE_X - 6;
const SIDE_BTN_H = 28;
/** Search mode. */
const RESULTS_Y = T.PANE_Y;
const RESULTS_H = 100;
const SEARCH_KB_TOP = RESULTS_Y + RESULTS_H + T.TREE_HEADER_H + 4;
/** Caret pad: px of travel per character column and per row. */
const CARET_COL_PX = 9;
const CARET_ROW_PX = 16;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const TABS: Array<{ tab: Tab; label: string }> = [
  { tab: "files", label: "Files" },
  { tab: "links", label: "Links" },
  { tab: "tags", label: "Tags" },
];

export function Deck(props: { store: VaultStore }) {
  const store = props.store;
  const keys = createKeyPress();
  const deck = store.deck;

  const tapRect = (): Rect => ({ x: 0, y: 0, w: DECK_W, h: DECK_H });
  const stripRect = (): Rect | null =>
    store.menu() === null && deck() === "browse" && store.doc()
      ? { x: T.STRIP_X, y: T.PANE_Y, w: T.STRIP_W, h: T.PANE_H }
      : null;
  const caretPadRect = (): Rect | null =>
    store.menu() === null && deck() === "edit" ? { x: 6, y: CPAD_Y, w: CPAD_W, h: CPAD_H } : null;

  const onKey = (act: KeyAction): void => {
    if ("layer" in act) {
      store.setKbLayer(act.layer);
      return;
    }
    const layer = store.kbLayer();
    const text = "ch" in act ? act.ch : act.key === "space" ? " " : act.key === "enter" ? "\n" : null;
    if (deck() === "search") {
      if ("key" in act && act.key === "backspace") store.setQuery(store.query().slice(0, -1));
      else if ("key" in act && act.key === "enter") store.setDeck("browse");
      else if (text !== null && text !== "\n") store.setQuery(store.query() + text);
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

  const toolAt = (x: number): 0 | 1 | 2 | 3 | null => {
    if (x >= 6 && x < 36) return 0;
    if (x >= 40 && x < 158) return 1;
    if (x >= 162 && x < 280) return 2;
    if (x >= 284 && x < 314) return 3;
    return null;
  };

  const searchFirst = (): number => Math.floor(searchScroller.offset() / T.LIST_ROW_H);

  createGesture({
    surface: SURFACE,
    region: { rect: tapRect },
    tapSlop: 8,
    onTap: (contact) => {
      // The mirrored menu owns every contact while a shoulder is held.
      if (store.menu() !== null) {
        const index = Math.floor((contact.y - T.DECK_MENU_TOP) / (T.DECK_MENU_ROW_H + 4));
        if (index >= 0 && index < store.menuItems().length) store.runMenu(index);
        else store.closeMenu();
        return;
      }
      if (deck() === "edit") {
        if (contact.y < KB_TOP + KB_H) {
          const hit = keyboardHit(contact.x, contact.y, store.kbLayer(), KB_TOP);
          if (!hit) return;
          keys.press(hit);
          onKey(hit.act);
          return;
        }
        if (contact.x >= SIDE_X) {
          const button = sideButtonAt(contact.y);
          if (button === 0) store.setSelecting(!store.selecting());
          else if (button === 1) store.save();
          else if (button === 2) store.leaveEdit();
        }
        return;
      }
      if (deck() === "search") {
        if (contact.y < T.TABS_Y + T.TABS_H && contact.x >= DECK_W - 70) {
          store.setDeck("browse");
          return;
        }
        if (contact.y >= SEARCH_KB_TOP) {
          const hit = keyboardHit(contact.x, contact.y, store.kbLayer(), SEARCH_KB_TOP);
          if (!hit) return;
          keys.press(hit);
          onKey(hit.act);
        }
        return;
      }
      if (contact.y < T.TABS_Y + T.TABS_H) {
        if (contact.x >= T.SEARCH_X) {
          store.setDeck("search");
          return;
        }
        if (contact.x >= T.TABS_X && contact.x < T.TABS_X + T.TABS_W) {
          store.setTab(TABS[Math.min(2, Math.floor((contact.x - T.TABS_X) / TAB_W))]!.tab);
        }
        return;
      }
      if (contact.y >= T.TOOLBAR_Y) {
        const tool = toolAt(contact.x);
        if (tool === 3) {
          // Armed by the first tap, done by the second.
          if (store.deleteArmed()) store.deleteNote();
          else store.armDelete();
          return;
        }
        if (tool === 0) store.openMenu("vault");
        else if (tool === 1) store.newNote();
        else if (tool === 2) store.newFolder();
      }
    },
  });

  // The scrub strip: a drag anywhere on it puts the document there.
  const scrubTo = (y: number): void => store.scrollToFraction((y - T.PANE_Y - 6) / (T.PANE_H - 12));
  createGesture({
    surface: SURFACE,
    region: { rect: stripRect },
    axis: "y",
    panSlop: 1,
    onDown: (contact) => {
      store.scroller.stop();
      scrubTo(contact.y);
    },
    onPanMove: (contact) => scrubTo(contact.y),
  });

  // The caret pad: travel accumulates and spends itself in whole columns and
  // rows, so a slow stylus moves one character at a time and a fast one
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
    onPanMove: (contact) => {
      padDx += contact.fdx;
      padDy += contact.fdy;
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

  const treeScroller = createScroller({
    max: () => Math.max(0, treeCount() * T.TREE_ROW_H - TREE_LIST_H),
    extent: () => TREE_LIST_H,
  });
  const listScroller = createScroller({
    max: () => Math.max(0, rightCount() * T.LIST_ROW_H - LIST_H),
    extent: () => LIST_H,
  });
  const searchScroller = createScroller({
    max: () => Math.max(0, store.listTotal() * T.LIST_ROW_H - RESULTS_H),
    extent: () => RESULTS_H,
  });

  /** The Links tab's right pane: outgoing links, then backlinks. */
  const linkRows = createMemo<Array<{ header?: string; link?: LinkItem }>>(() => {
    const links = store.links();
    const out: Array<{ header?: string; link?: LinkItem }> = [];
    if (!links) return out;
    out.push({ header: `Links out · ${links.out.length}` });
    for (const link of links.out) out.push({ link });
    out.push({ header: `Backlinks · ${links.back.length}` });
    for (const link of links.back) out.push({ link });
    return out;
  });

  const treeCount = (): number => {
    switch (store.tab()) {
      case "files":
        return store.treeRows().length;
      case "links":
        return store.outline().length;
      default:
        return store.tags().length;
    }
  };
  const rightCount = (): number => (store.tab() === "links" ? linkRows().length : store.listTotal());

  onFrame(() => {
    if (deck() === "browse" && store.tab() !== "links") {
      store.setListViewport(Math.floor(listScroller.offset() / T.LIST_ROW_H));
    }
    if (deck() === "search") store.setListViewport(searchFirst());
  });

  return (
    <View debugName="Deck" class={T.SCREEN}>
      <Show when={deck() === "browse"}>
        <Tabs store={store} />

        <Show when={store.tab() === "files"}>
          <Pane x={T.TREE_X} width={T.TREE_W} header="Vault" footer={`${store.treeRows().length} shown`}>
            <PaneList
              controller={treeScroller}
              count={store.treeRows().length}
              rowHeight={T.TREE_ROW_H}
              height={TREE_LIST_H}
              renderRow={(index) => <TreeRowView store={store} index={index} />}
              onRowPress={(index) => {
                const row = store.treeRows()[index];
                if (!row) return;
                if (row.entry.folder) {
                  store.setFolder(row.entry.path);
                  store.toggleFolder(row.entry.path);
                } else if (row.entry.id !== undefined) store.openNote(row.entry.id);
                else store.setFolder(row.entry.path); // the "N more" row
              }}
            />
          </Pane>
          <NotesPane store={store} scroller={listScroller} />
        </Show>

        <Show when={store.tab() === "links"}>
          <Pane x={T.TREE_X} width={T.TREE_W} header="Outline" footer={`${store.outline().length} headings`}>
            <PaneList
              controller={treeScroller}
              count={store.outline().length}
              rowHeight={T.TREE_ROW_H}
              height={TREE_LIST_H}
              renderRow={(index) => <OutlineRowView item={store.outline()[index]} />}
              onRowPress={(index) => {
                const item = store.outline()[index];
                if (item) store.jumpToRow(item.row);
              }}
            />
          </Pane>
          <Pane x={T.LIST_X} width={T.LIST_W} header="Links">
            <PaneList
              controller={listScroller}
              count={linkRows().length}
              rowHeight={T.TREE_ROW_H}
              height={LIST_H}
              renderRow={(index) => <LinkRowView row={linkRows()[index]} />}
              onRowPress={(index) => {
                const row = linkRows()[index];
                if (!row?.link) return;
                if (row.link.id !== null) store.openNote(row.link.id);
                else if (row.link.line !== undefined) store.jumpToLine(row.link.line);
              }}
            />
          </Pane>
        </Show>

        <Show when={store.tab() === "tags"}>
          <Pane x={T.TREE_X} width={T.TREE_W} header="Tags" footer={`${store.tags().length} tags`}>
            <PaneList
              controller={treeScroller}
              count={store.tags().length}
              rowHeight={T.TREE_ROW_H}
              height={TREE_LIST_H}
              renderRow={(index) => <TagRowView store={store} index={index} />}
              onRowPress={(index) => {
                const item = store.tags()[index];
                if (item) store.setTag(store.tag() === item.tag ? "" : item.tag);
              }}
            />
          </Pane>
          <NotesPane store={store} scroller={listScroller} />
        </Show>

        <Strip store={store} />
        <Toolbar store={store} />
      </Show>

      <Show when={deck() === "edit"}>
        <Keyboard layer={store.kbLayer()} pressed={keys.pressed} top={KB_TOP} />
        <View class={T.WELL} style={{ insetL: 6, insetT: CPAD_Y, width: CPAD_W, height: CPAD_H }}>
          <Text class={T.WELL_HINT} style={{ insetT: 12 }}>
            {store.selecting() ? "drag to select" : "drag to move the caret"}
          </Text>
          <Text class={T.WELL_HINT} style={{ insetT: 28 }}>
            {store.unconfirmed() > 0 ? `${store.unconfirmed()} edit(s) on the way` : "B done · X select · START save"}
          </Text>
          <Text class={T.WELL_HINT} style={{ insetT: 44 }}>{caretLabel(store)}</Text>
        </View>
        <SideButton label="Select" on={store.selecting()} index={0} />
        <SideButton label="Save" on={false} index={1} />
        <SideButton label="Done" on={false} index={2} />
      </Show>

      <Show when={deck() === "search"}>
        <View class={T.FIELD} style={{ insetL: 6, insetT: T.TABS_Y, width: DECK_W - 82 }}>
          <Show when={store.query() === ""} fallback={<Text class={T.FIELD_TEXT}>{store.query()}</Text>}>
            <Text class={T.FIELD_PLACEHOLDER}>Search the vault</Text>
          </Show>
        </View>
        <View class={T.TOOL_BUTTON} style={{ insetL: DECK_W - 70, insetT: T.TABS_Y + 1, width: 64 }}>
          <Text class={T.TOOL_TEXT}>Cancel</Text>
        </View>
        <Pane
          x={T.TREE_X}
          width={DECK_W - 8}
          header={`${store.listTotal()} matches`}
          top={RESULTS_Y}
          height={RESULTS_H + T.TREE_HEADER_H}
        >
          <PaneList
            controller={searchScroller}
            count={store.listTotal()}
            rowHeight={T.LIST_ROW_H}
            height={RESULTS_H}
            renderRow={(index) => <NoteRowView store={store} index={index} width={DECK_W - 10} />}
            onRowPress={(index) => store.select(index)}
          />
        </Pane>
        <Keyboard layer={store.kbLayer()} pressed={keys.pressed} top={SEARCH_KB_TOP} />
      </Show>

      <Show when={store.menu() !== null}>
        <View class={T.MENU_DIM} />
        <Text class={T.DECK_MENU_TITLE}>{store.menu() === "vault" ? "Vault" : "Actions"}</Text>
        <For each={store.menuItems()}>
          {(item, i) => (
            <View
              class={store.menuIndex() === i() ? T.DECK_MENU_ROW_ON : T.DECK_MENU_ROW}
              style={{ insetT: T.DECK_MENU_TOP + i() * (T.DECK_MENU_ROW_H + 4) }}
            >
              <Text class={store.menuIndex() === i() ? T.DECK_MENU_TEXT_ON : T.DECK_MENU_TEXT}>{item.label}</Text>
            </View>
          )}
        </For>
      </Show>
    </View>
  );
}

function caretLabel(store: VaultStore): string {
  const caret = store.caret();
  return caret ? `line ${caret.line + 1} · col ${caret.col + 1}` : "no caret";
}

function SideButton(props: { label: string; on: boolean; index: number }) {
  return (
    <View
      class={props.on ? T.TOOL_BUTTON_ON : T.TOOL_BUTTON}
      style={{ insetL: SIDE_X, insetT: CPAD_Y + props.index * (SIDE_BTN_H + 3), width: SIDE_W, height: SIDE_BTN_H }}
    >
      <Text class={props.on ? T.TOOL_TEXT_ON : T.TOOL_TEXT} style={{ insetT: 8 }}>
        {props.label}
      </Text>
    </View>
  );
}

function Tabs(props: { store: VaultStore }) {
  const store = props.store;
  const on = (tab: Tab): boolean => store.tab() === tab;
  return (
    <>
      <View class={T.SEG} style={{ insetL: T.TABS_X, insetT: T.TABS_Y, width: T.TABS_W }}>
        <For each={TABS}>
          {(entry, i) => (
            <>
              <Show when={on(entry.tab) && (i() === 0 || i() === TABS.length - 1)}>
                <View class={T.SEG_ITEM_ON_PATCH} style={{ insetL: i() === 0 ? TAB_W - 6 : i() * TAB_W }} />
              </Show>
              <View
                class={
                  on(entry.tab)
                    ? i() === 0 || i() === TABS.length - 1
                      ? T.SEG_ITEM_ON_END
                      : T.SEG_ITEM_ON
                    : T.SEG_ITEM
                }
                style={{ insetL: i() * TAB_W, width: TAB_W }}
              >
                <Text class={on(entry.tab) ? T.SEG_TEXT_ON : T.SEG_TEXT}>{entry.label}</Text>
              </View>
              <Show when={i() > 0}>
                <View class={T.SEG_DIVIDER} style={{ insetL: i() * TAB_W - 1 }} />
              </Show>
            </>
          )}
        </For>
      </View>
      {/* a magnifier: a ring and a handle */}
      <View class={T.TOOL_BUTTON} style={{ insetL: T.SEARCH_X, insetT: T.TABS_Y + 1, width: T.SEARCH_W }}>
        <View class="absolute left-[13] top-[4] w-[9] h-[9] rounded-full border border-[#3c4552]" />
        <View class="absolute left-[21] top-[13] w-[5] h-[2] bg-[#3c4552]" style={{ rotate: 45 }} />
      </View>
    </>
  );
}

function Pane(props: {
  x: number;
  width: number;
  header: string;
  footer?: string;
  top?: number;
  height?: number;
  children?: SolidJSX.Element;
}) {
  return (
    <View
      class={T.PANE}
      style={{ insetL: props.x, insetT: props.top ?? T.PANE_Y, width: props.width, height: props.height ?? T.PANE_H }}
    >
      <View class={T.PANE_HEADER}>
        <Text class={T.PANE_HEADER_TEXT}>{props.header}</Text>
      </View>
      <View class={T.PANE_RULE} style={{ insetT: T.TREE_HEADER_H }} />
      {props.children}
      <Show when={props.footer !== undefined}>
        <View class={T.PANE_FOOTER}>
          <Text class={T.PANE_FOOTER_TEXT}>{props.footer}</Text>
        </View>
      </Show>
    </View>
  );
}

/** A pane's scrolling body, inset under its header. */
function PaneList(props: {
  controller: Scroller;
  count: number;
  rowHeight: number;
  height: number;
  renderRow: (index: number) => SolidJSX.Element;
  onRowPress: (index: number) => void;
}) {
  return (
    <View class="absolute left-0 right-0" style={{ insetT: T.TREE_HEADER_H, height: props.height }}>
      <VirtualList
        surface={SURFACE}
        controller={props.controller}
        count={props.count}
        rowHeight={props.rowHeight}
        height={props.height}
        overscan={props.rowHeight * 2}
        focusRows={false}
        renderRow={props.renderRow}
        onRowPress={props.onRowPress}
      />
    </View>
  );
}

function NotesPane(props: { store: VaultStore; scroller: Scroller }) {
  const store = props.store;
  const header = (): string => {
    if (store.tag() !== "") return `#${store.tag()} · ${store.listTotal()}`;
    const folder = store.folder();
    return folder === "" ? `All notes · ${store.listTotal()}` : `${folder} · ${store.listTotal()}`;
  };
  return (
    <Pane x={T.LIST_X} width={T.LIST_W} header={header()}>
      <PaneList
        controller={props.scroller}
        count={store.listTotal()}
        rowHeight={T.LIST_ROW_H}
        height={LIST_H}
        renderRow={(index) => <NoteRowView store={store} index={index} width={T.LIST_W - 2} />}
        onRowPress={(index) => store.select(index)}
      />
    </Pane>
  );
}

function NoteIcon(props: { x: number; y: number; on: boolean }) {
  return (
    <View class={props.on ? T.ICON_NOTE_ON : T.ICON_NOTE} style={{ insetL: props.x, insetT: props.y }}>
      <View class={T.ICON_NOTE_LINE} style={{ insetT: 2 }} />
      <View class={T.ICON_NOTE_LINE} style={{ insetT: 5 }} />
      <View class={T.ICON_NOTE_LINE} style={{ insetT: 8 }} />
    </View>
  );
}

function TreeRowView(props: { store: VaultStore; index: number }) {
  const store = props.store;
  const row = (): TreeRow | undefined => store.treeRows()[props.index];
  const on = (): boolean => {
    const entry = row()?.entry;
    if (!entry) return false;
    return entry.folder ? store.folder() === entry.path : store.doc()?.id === entry.id;
  };
  const indent = (): number => 4 + (row()?.depth ?? 0) * 9;
  const open = (): boolean => {
    const entry = row()?.entry;
    return entry !== undefined && entry.folder && store.expanded(entry.path);
  };
  return (
    <View class={on() ? T.CELL_ON : T.CELL} style={{ height: T.TREE_ROW_H }}>
      <Show when={row()?.entry.folder} fallback={<NoteIcon x={indent() + 8} y={4} on={on()} />}>
        <View
          class={open() ? T.TREE_TRI_OPEN : T.TREE_TRI_CLOSED}
          style={{ insetL: indent(), insetT: open() ? 7 : 6 }}
        />
        <View class={T.ICON_FOLDER} style={{ insetL: indent() + 8, insetT: 5 }} />
        <View class={T.ICON_FOLDER_TAB} style={{ insetL: indent() + 9, insetT: 3 }} />
      </Show>
      <View class={T.CLIP} style={{ insetL: indent() + 22, insetT: 0, width: Math.max(20, T.TREE_W - indent() - 46), height: T.TREE_ROW_H }}>
        <Text class={on() ? T.TREE_TEXT_ON : T.TREE_TEXT} style={{ insetL: 0 }}>
          {row()?.entry.name ?? ""}
        </Text>
      </View>
      <Show when={row()?.entry.count !== undefined}>
        <Text class={on() ? T.TREE_COUNT_ON : T.TREE_COUNT}>{String(row()?.entry.count ?? "")}</Text>
      </Show>
      <View class={on() ? T.CELL_RULE_ON : T.CELL_RULE} />
    </View>
  );
}

function NoteRowView(props: { store: VaultStore; index: number; width: number }) {
  const store = props.store;
  const item = () => store.listItem(props.index);
  const on = (): boolean => store.doc()?.id === item()?.id;
  const date = (): string => {
    const at = item()?.mtime;
    if (at === undefined) return "";
    const when = new Date(at);
    return `${when.getMonth() + 1}/${when.getDate()}`;
  };
  return (
    <View class={on() ? T.CELL_ON : T.CELL} style={{ height: T.LIST_ROW_H }}>
      <NoteIcon x={5} y={5} on={on()} />
      <View class={T.CLIP} style={{ insetL: 18, insetT: 0, width: props.width - 54, height: 14 }}>
        <Text class={on() ? T.CELL_TITLE_ON : T.CELL_TITLE} style={{ insetL: 0 }}>
          {item()?.title ?? ""}
        </Text>
      </View>
      <View class={T.CLIP} style={{ insetL: 18, insetT: 0, width: props.width - 24, height: T.LIST_ROW_H }}>
        <Text class={on() ? T.CELL_SUB_ON : T.CELL_SUB} style={{ insetL: 0 }}>
          {item()?.snippet ?? "…"}
        </Text>
      </View>
      <Text class={on() ? T.CELL_META_ON : T.CELL_META} style={{ insetL: props.width - 28, width: 26 }}>
        {date()}
      </Text>
      <View class={on() ? T.CELL_RULE_ON : T.CELL_RULE} />
    </View>
  );
}

function OutlineRowView(props: { item: OutlineItem | undefined }) {
  const level = () => props.item?.level ?? 1;
  return (
    <View class={T.CELL} style={{ height: T.TREE_ROW_H }}>
      <View class={T.CLIP} style={{ insetL: 6 + (level() - 1) * 9, insetT: 0, width: T.TREE_W - 18, height: T.TREE_ROW_H }}>
        <Text class={level() === 1 ? T.CELL_TITLE : T.TREE_TEXT} style={{ insetL: 0 }}>
          {props.item?.text ?? ""}
        </Text>
      </View>
      <View class={T.CELL_RULE} />
    </View>
  );
}

function LinkRowView(props: { row: { header?: string; link?: LinkItem } | undefined }) {
  return (
    <View class={T.CELL} style={{ height: T.TREE_ROW_H }}>
      <Show
        when={props.row?.header === undefined}
        fallback={
          <>
            <View class={T.PANE_HEADER} style={{ height: T.TREE_ROW_H }} />
            <Text class={T.PANE_HEADER_TEXT}>{props.row?.header ?? ""}</Text>
          </>
        }
      >
        <View class={T.CLIP} style={{ insetL: 8, insetT: 0, width: T.LIST_W - 40, height: T.TREE_ROW_H }}>
          <Text class={T.TREE_TEXT} style={{ insetL: 0 }}>{props.row?.link?.title ?? ""}</Text>
        </View>
        <Show when={props.row?.link?.id === null}>
          <Text class={T.TREE_COUNT}>new</Text>
        </Show>
      </Show>
      <View class={T.CELL_RULE} />
    </View>
  );
}

function TagRowView(props: { store: VaultStore; index: number }) {
  const store = props.store;
  const item = () => store.tags()[props.index];
  const on = (): boolean => store.tag() === item()?.tag;
  return (
    <View class={on() ? T.CELL_ON : T.CELL} style={{ height: T.TREE_ROW_H }}>
      <View class={T.CLIP} style={{ insetL: 8, insetT: 0, width: T.TREE_W - 40, height: T.TREE_ROW_H }}>
        <Text class={on() ? T.TREE_TEXT_ON : T.TREE_TEXT} style={{ insetL: 0 }}>
          {item() === undefined ? "" : `#${item()!.tag}`}
        </Text>
      </View>
      <Show when={item() !== undefined}>
        <Text class={on() ? T.TREE_COUNT_ON : T.TREE_COUNT}>{String(item()?.count ?? "")}</Text>
      </Show>
      <View class={on() ? T.CELL_RULE_ON : T.CELL_RULE} />
    </View>
  );
}

function Strip(props: { store: VaultStore }) {
  const store = props.store;
  /** 96 buckets over 168 px would be sub-pixel bars; pairs average into 48
   *  bars of 2 px, which reads as the note's silhouette. */
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
  const pitch = (T.PANE_H - 12) / (MAP_BUCKETS / 2);
  const thumbH = () => Math.max(10, Math.round((210 / Math.max(210, store.docHeight())) * (T.PANE_H - 12)));
  const thumbY = () => 6 + Math.round(store.scrollFraction() * (T.PANE_H - 12 - thumbH()));
  return (
    <View class={T.STRIP} style={{ insetL: T.STRIP_X, insetT: T.PANE_Y, width: T.STRIP_W, height: T.PANE_H }}>
      <For each={buckets()}>
        {(density, i) => (
          <View
            class={T.STRIP_BAR}
            style={{ insetL: 2, insetT: 6 + Math.round(i() * pitch), width: 2 + Math.round((density / 35) * 8) }}
          />
        )}
      </For>
      <View class={T.STRIP_THUMB} style={{ insetT: thumbY(), height: thumbH() }} />
    </View>
  );
}

function Toolbar(props: { store: VaultStore }) {
  const store = props.store;
  return (
    <View class={T.TOOLBAR}>
      <View class={T.TOOLBAR_RULE} />
      {/* settings: a ring with four teeth */}
      <View class={T.TOOL_BUTTON} style={{ insetL: 6, insetT: 3, width: 30 }}>
        <View class="absolute left-[10] top-[5] w-[10] h-[10] rounded-full border border-[#3c4552]" />
        <View class="absolute left-[14] top-[2] w-[2] h-[3] bg-[#3c4552]" />
        <View class="absolute left-[14] top-[15] w-[2] h-[3] bg-[#3c4552]" />
        <View class="absolute left-[7] top-[9] w-[3] h-[2] bg-[#3c4552]" />
        <View class="absolute left-[20] top-[9] w-[3] h-[2] bg-[#3c4552]" />
      </View>
      <View class={T.TOOL_BUTTON} style={{ insetL: 40, insetT: 3, width: 118 }}>
        <Text class={T.TOOL_TEXT}>New Note</Text>
      </View>
      <View class={T.TOOL_BUTTON} style={{ insetL: 162, insetT: 3, width: 118 }}>
        <Text class={T.TOOL_TEXT}>New Folder</Text>
      </View>
      {/* delete: a lid and a can, red once armed */}
      <View class={store.deleteArmed() ? T.TOOL_BUTTON_DANGER : T.TOOL_BUTTON} style={{ insetL: 284, insetT: 3, width: 30 }}>
        <View class={store.deleteArmed() ? T.TRASH_LID_ON : T.TRASH_LID} />
        <View class={store.deleteArmed() ? T.TRASH_CAN_ON : T.TRASH_CAN} />
      </View>
      <Show when={store.deleteArmed()}>
        <Text class={T.TOOL_TEXT_DANGER} style={{ insetL: 162, insetT: 6, width: 118 }}>
          tap again to delete
        </Text>
      </Show>
      <Show when={store.lastError() !== null}>
        <Text class={T.WELL_HINT} style={{ insetT: -13 }}>{store.lastError() ?? ""}</Text>
      </Show>
    </View>
  );
}
