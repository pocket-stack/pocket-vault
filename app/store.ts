// app/store.ts — the guest's whole state, and every companion conversation.
//
// Nothing in here reads a file or measures a document. The companion holds
// the vault and its layout; this store holds windows onto them: a page of
// titles around the list's viewport, a run of rows around the document's
// viewport (aimed a quarter second ahead of a fling so the rows are there
// when it lands), and the document's row-kind string from which every row
// top is a prefix sum. Patches from edits splice that string and the row
// cache in place. The per-frame cost is one companion pump plus the
// scroller's step — never a function of the note's size.

import { batch, createComputed, createMemo, createSignal, type Accessor } from "solid-js";
import { createCompanion, createQuery, type Companion, type CompanionOps } from "@pocketjs/framework/companion";
import { createScroller, type Scroller } from "@pocketjs/framework/kinetics";
import { BTN } from "@pocketjs/framework/input";
import {
  K_RAW,
  LIST_PAGE,
  PAGE_ROWS,
  ROW_H,
  STAGE_H,
  VAULT_APP,
  rowAtY,
  rowTops,
  type DocInfo,
  type ListItem,
  type ListResult,
  type OutlineItem,
  type Patch,
  type Row,
  type RowsResult,
} from "./protocol.ts";

export type Mode = "files" | "search" | "read" | "outline" | "edit";
export type KbLayer = "lower" | "upper" | "sym";

export interface Caret {
  line: number;
  col: number;
}

/** Rows kept around the viewport before far ones are dropped. */
const ROW_CACHE_MAX = 1200;
/** Rows mounted beyond each screen edge. */
export const OVERSCAN = 40;
/** How far ahead of a fling the row window is aimed, in seconds. */
const LOOKAHEAD_S = 0.25;
const REPEAT_DELAY = 18;
const REPEAT_EVERY = 5;
/** Rows a page-turn moves: one screen less a row of context. */
const PAGE_PX = STAGE_H - 36;

export interface VaultStore {
  mac: Companion;
  mode: Accessor<Mode>;
  setMode(mode: Mode): void;
  /** One line for the deck's status strip. */
  status: Accessor<string>;

  // ── the vault list ──
  query: Accessor<string>;
  setQuery(q: string): void;
  listTotal: Accessor<number>;
  listItem(index: number): ListItem | undefined;
  /** The list tells the store which indices it is showing. */
  setListViewport(first: number): void;
  selected: Accessor<number>;
  select(index: number): void;

  // ── the open document ──
  doc: Accessor<DocInfo | null>;
  tops: Accessor<Int32Array>;
  /** Total document height in px. */
  docHeight: Accessor<number>;
  rowAt(index: number): Row | undefined;
  /** Bumps whenever cached rows change; row views read it to refresh. */
  rowsRev: Accessor<number>;
  scroller: Scroller;
  visibleRange: Accessor<readonly [first: number, last: number]>;
  open(id: number): void;
  outline: Accessor<OutlineItem[] | undefined>;
  jumpToRow(row: number): void;
  /** Fraction of the document scrolled, 0..1, for the minimap. */
  scrollFraction(): number;
  scrollToFraction(f: number): void;
  pageBy(direction: -1 | 1): void;

  // ── editing ──
  caret: Accessor<Caret | null>;
  enterEdit(): void;
  leaveEdit(): void;
  type(text: string): void;
  backspace(): void;
  moveCaret(dx: number, dy: number): void;
  kbLayer: Accessor<KbLayer>;
  setKbLayer(layer: KbLayer): void;
  /** The active source line's raw text, for the keyboard's echo strip. */
  activeLineText(): string;
  save(): void;

  /** Once per frame, before anything reads the scroller. */
  frame(buttons: number): void;
}

/** `ops` overrides the host's svc trio — the sim pair in tests. */
export function createVaultStore(ops?: CompanionOps | null): VaultStore {
  const mac = createCompanion(ops === undefined ? { app: VAULT_APP, device: "3ds-dev" } : { app: VAULT_APP, device: "3ds-dev", ops });
  const [mode, setMode] = createSignal<Mode>("files");
  const [error, setError] = createSignal<string | null>(null);
  mac.onError((message) => setError(message));

  // ── list ──────────────────────────────────────────────────────────────────
  const [query, setQuery] = createSignal("");
  const [listFirst, setListFirst] = createSignal(0);
  const [listTotal, setListTotal] = createSignal(0);
  const [listVersion, setListVersion] = createSignal(0);
  const [listRev, setListRev] = createSignal(0);
  const listCache = new Map<number, ListItem>();
  const [selected, setSelected] = createSignal(-1);
  mac.on<{ version: number }>("vault.changed", (event) => {
    listCache.clear();
    setListVersion(event.version);
    setListRev((n) => n + 1);
  });
  const listPage = createQuery<ListResult>(mac, () => {
    const from = Math.max(0, Math.floor(listFirst() / LIST_PAGE) * LIST_PAGE - LIST_PAGE);
    return ["vault.list", { q: query(), offset: from, limit: LIST_PAGE * 3, v: listVersion() }];
  });
  let lastQuery = "";
  createComputed(() => {
    if (query() !== lastQuery) {
      lastQuery = query();
      listCache.clear();
      setListRev((n) => n + 1);
    }
  });
  createComputed(() => {
    const page = listPage();
    if (!page) return;
    const from = Math.max(0, Math.floor(listFirst() / LIST_PAGE) * LIST_PAGE - LIST_PAGE);
    page.items.forEach((item, i) => listCache.set(from + i, item));
    batch(() => {
      setListTotal(page.total);
      setListRev((n) => n + 1);
    });
  });

  // ── document ──────────────────────────────────────────────────────────────
  const [doc, setDoc] = createSignal<DocInfo | null>(null);
  const [openId, setOpenId] = createSignal<number | null>(null);
  const [rowsRev, setRowsRev] = createSignal(0);
  const rowCache = new Map<number, Row>();
  const tops = createMemo(() => rowTops(doc()?.kinds ?? ""));
  const docHeight = () => {
    const t = tops();
    return t.length === 0 ? 0 : t[t.length - 1]!;
  };
  const scroller = createScroller({
    max: () => Math.max(0, docHeight() - STAGE_H),
    extent: () => STAGE_H,
    overscroll: 40,
  });

  const info = createQuery<DocInfo>(mac, () => (openId() === null ? null : ["doc.open", { id: openId() }]), { keep: false });
  createComputed(() => {
    const next = info();
    if (!next) return;
    batch(() => {
      rowCache.clear();
      setDoc(next);
      setRowsRev((n) => n + 1);
    });
  });

  /** Where the row window is aimed: the current offset, or ahead of a
   *  fling, or a tween's target. */
  const aim = (): number => {
    const state = scroller.state();
    if (state === "fling") return scroller.offset() + scroller.velocity() * LOOKAHEAD_S;
    return scroller.intent();
  };

  // Rows are fetched a page at a time. Every frame the wanted pages are the
  // ones under the aimed viewport plus one in the direction of travel; a
  // page request stays in flight while its page is still wanted and is
  // cancelled the moment it is not, so a fast fling cancels what it passes
  // and keeps what it lands on. Requests carry the layout revision: a page
  // from a previous revision is answered with an error and ignored.
  const inflight = new Map<number, number>();
  let inflightRev = -1;
  const pageMissing = (page: number, total: number): boolean => {
    const from = page * PAGE_ROWS;
    const to = Math.min(total, from + PAGE_ROWS);
    for (let i = from; i < to; i++) if (!rowCache.has(i)) return true;
    return false;
  };
  const requestPage = (d: DocInfo, page: number): void => {
    const from = page * PAGE_ROWS;
    const rev = d.rev;
    const id = mac.core.request("doc.rows", { id: d.id, from, count: PAGE_ROWS, rev }, (body) => {
      inflight.delete(page);
      if (!("ok" in body)) return; // a stale revision, or a note that closed
      const result = body.ok as RowsResult;
      const current = doc();
      if (!current || current.id !== d.id || result.rev !== current.rev) return;
      result.rows.forEach((row, i) => rowCache.set(result.from + i, row));
      if (rowCache.size > ROW_CACHE_MAX) {
        const centre = rowAtY(tops(), scroller.offset());
        for (const key of rowCache.keys()) {
          if (Math.abs(key - centre) > ROW_CACHE_MAX / 2) rowCache.delete(key);
        }
      }
      setRowsRev((n) => n + 1);
    });
    inflight.set(page, id);
  };
  createComputed(() => {
    const d = doc();
    rowsRev();
    if (!d || d.rows === 0) {
      for (const id of inflight.values()) mac.core.cancel(id);
      inflight.clear();
      return;
    }
    if (inflightRev !== d.rev) {
      for (const id of inflight.values()) mac.core.cancel(id);
      inflight.clear();
      inflightRev = d.rev;
    }
    const t = tops();
    const here = Math.max(0, scroller.offset());
    const at = Math.max(0, aim());
    const ahead = scroller.velocity() >= 0 ? 1 : -1;
    // The union of the viewport now and the viewport aimed at.
    const firstPage = Math.floor(rowAtY(t, Math.min(here, at) - OVERSCAN) / PAGE_ROWS);
    const lastPage = Math.floor(rowAtY(t, Math.max(here, at) + STAGE_H + OVERSCAN) / PAGE_ROWS);
    const lastAll = Math.floor((d.rows - 1) / PAGE_ROWS);
    const wanted = new Set<number>();
    for (let page = firstPage; page <= lastPage; page++) wanted.add(page);
    const extra = ahead > 0 ? lastPage + 1 : firstPage - 1;
    if (extra >= 0 && extra <= lastAll) wanted.add(extra);
    for (const [page, id] of inflight) {
      if (!wanted.has(page)) {
        mac.core.cancel(id);
        inflight.delete(page);
      }
    }
    for (const page of wanted) {
      if (page < 0 || page > lastAll || inflight.has(page) || !pageMissing(page, d.rows)) continue;
      requestPage(d, page);
    }
  });

  const visibleRange = createMemo<readonly [number, number]>(() => {
    const d = doc();
    if (!d || d.rows === 0) return [0, -1];
    const t = tops();
    const off = scroller.offset();
    return [rowAtY(t, off - OVERSCAN), rowAtY(t, off + STAGE_H + OVERSCAN)];
  });

  const outlineQuery = createQuery<OutlineItem[]>(mac, () =>
    mode() === "outline" && doc() ? ["doc.outline", { id: doc()!.id }] : null,
  );

  // ── editing ───────────────────────────────────────────────────────────────
  const [caret, setCaret] = createSignal<Caret | null>(null);
  const [kbLayer, setKbLayer] = createSignal<KbLayer>("lower");
  let activeLine: number | null = null;

  const applyPatch = (patch: Patch): void => {
    const d = doc();
    if (!d) return;
    batch(() => {
      if (patch.full) {
        rowCache.clear();
        setDoc(patch.full);
      } else {
        let kinds = d.kinds;
        for (const span of patch.spans) {
          kinds = kinds.slice(0, span.row0) + span.kinds + kinds.slice(span.row0 + span.removed);
          const shifted = new Map<number, Row>();
          const delta = span.rows.length - span.removed;
          for (const [index, row] of rowCache) {
            if (index < span.row0) shifted.set(index, row);
            else if (index >= span.row0 + span.removed) shifted.set(index + delta, row);
          }
          span.rows.forEach((row, i) => shifted.set(span.row0 + i, row));
          rowCache.clear();
          for (const [index, row] of shifted) rowCache.set(index, row);
        }
        setDoc({ ...d, kinds, rows: patch.total, map: patch.map, rev: patch.rev });
      }
      setCaret({ line: patch.caret[0], col: patch.caret[1] });
      setRowsRev((n) => n + 1);
    });
    revealCaret();
  };

  const caretRow = (): number => {
    const c = caret();
    const d = doc();
    if (!c || !d) return -1;
    // The active line's rows are in the cache (the patch delivered them);
    // pick the raw row holding the column.
    let best = -1;
    for (const [index, row] of rowCache) {
      if (row.l !== c.line) continue;
      if (best < 0) best = index;
      if (row.k === K_RAW && row.s <= c.col) best = Math.max(best, index);
    }
    return best;
  };

  const revealCaret = (): void => {
    const row = caretRow();
    if (row < 0) return;
    const t = tops();
    const top = t[row]!;
    const bottom = t[row + 1]!;
    const off = scroller.intent();
    if (top < off + 8) scroller.scrollTo(Math.max(0, top - 8));
    else if (bottom > off + STAGE_H - 8) scroller.scrollTo(bottom - STAGE_H + 8);
  };

  const focus = (line: number | null): void => {
    const d = doc();
    if (!d) return;
    activeLine = line;
    mac.call<Patch>("doc.focus", { id: d.id, line }).then(applyPatch, (e: Error) => setError(e.message));
  };

  const edit = (params: { insert?: string; del?: number }): void => {
    const d = doc();
    const c = caret();
    if (!d || !c) return;
    // Optimistic caret so a quick second keystroke lands after the first;
    // the patch's caret confirms or corrects it.
    if (params.insert !== undefined) {
      if (params.insert === "\n") setCaret({ line: c.line + 1, col: 0 });
      else setCaret({ line: c.line, col: c.col + params.insert.length });
    } else if (params.del && c.col > 0) {
      setCaret({ line: c.line, col: Math.max(0, c.col - params.del) });
    }
    mac.call<Patch>("doc.edit", { id: d.id, line: c.line, col: c.col, ...params }).then(applyPatch, (e: Error) => setError(e.message));
  };

  const lineOfRow = (index: number): number | null => rowCache.get(index)?.l ?? null;

  // ── per-frame input ───────────────────────────────────────────────────────
  let prevButtons = 0;
  let heldFrames = 0;
  const repeatable = BTN.UP | BTN.DOWN | BTN.LEFT | BTN.RIGHT;

  const frame = (buttons: number): void => {
    scroller.step();
    const pressed = buttons & ~prevButtons;
    prevButtons = buttons;
    const m = mode();
    if (m === "edit") {
      const held = buttons & repeatable;
      let fire = pressed & repeatable;
      if (held && !(pressed & repeatable)) {
        heldFrames += 1;
        if (heldFrames >= REPEAT_DELAY && (heldFrames - REPEAT_DELAY) % REPEAT_EVERY === 0) fire = held;
      } else heldFrames = 0;
      if (fire & BTN.UP) store.moveCaret(0, -1);
      if (fire & BTN.DOWN) store.moveCaret(0, 1);
      if (fire & BTN.LEFT) store.moveCaret(-1, 0);
      if (fire & BTN.RIGHT) store.moveCaret(1, 0);
      if (pressed & BTN.CROSS) store.leaveEdit();
      if (pressed & BTN.START) store.save();
      return;
    }
    if (m === "read" || m === "outline") {
      if (buttons & BTN.UP) scroller.nudge(-6);
      if (buttons & BTN.DOWN) scroller.nudge(6);
      if (pressed & BTN.LTRIGGER) store.pageBy(-1);
      if (pressed & BTN.RTRIGGER) store.pageBy(1);
      if (pressed & BTN.CROSS) setMode(m === "outline" ? "read" : "files");
      if (pressed & BTN.TRIANGLE) store.enterEdit();
      if (pressed & BTN.SQUARE) setMode(m === "outline" ? "read" : "outline");
      if (pressed & BTN.START) store.save();
      return;
    }
    if (m === "files" || m === "search") {
      if (pressed & BTN.CIRCLE && doc()) setMode("read");
      if (pressed & BTN.CROSS && m === "search") setMode("files");
    }
  };

  const status = createMemo(() => {
    const err = error();
    if (err) return err.length > 44 ? err.slice(0, 44) : err;
    const s = mac.status();
    if (s === "absent") return "no svc mailbox on this host";
    if (s === "searching") return "looking for the vault companion…";
    return `${mac.name()} · ${listTotal()} notes`;
  });

  const store: VaultStore = {
    mac,
    mode,
    setMode: (next) => {
      if (next !== "edit" && mode() === "edit") store.leaveEdit();
      setMode(next);
    },
    status,
    query,
    setQuery,
    listTotal,
    listItem: (index) => {
      listRev();
      return listCache.get(index);
    },
    setListViewport: (first) => setListFirst(first),
    selected,
    select: (index) => {
      setSelected(index);
      const item = listCache.get(index);
      if (item) store.open(item.id);
    },
    doc,
    tops,
    docHeight,
    rowAt: (index) => {
      rowsRev();
      return rowCache.get(index);
    },
    rowsRev,
    scroller,
    visibleRange,
    open: (id) => {
      if (openId() === id) return;
      batch(() => {
        setCaret(null);
        activeLine = null;
        setOpenId(id);
        setDoc(null);
        rowCache.clear();
        setRowsRev((n) => n + 1);
      });
      scroller.scrollTo(0, { immediate: true });
    },
    outline: outlineQuery,
    jumpToRow: (row) => {
      const t = tops();
      if (row < 0 || row >= t.length - 1) return;
      scroller.scrollTo(Math.max(0, t[row]! - 8));
    },
    scrollFraction: () => {
      const max = Math.max(1, docHeight() - STAGE_H);
      return Math.max(0, Math.min(1, scroller.offset() / max));
    },
    scrollToFraction: (f) => {
      const max = Math.max(0, docHeight() - STAGE_H);
      scroller.scrollTo(Math.max(0, Math.min(1, f)) * max, { immediate: true });
    },
    pageBy: (direction) => scroller.scrollBy(direction * PAGE_PX),
    caret,
    enterEdit: () => {
      const d = doc();
      if (!d || d.rows === 0) return;
      setMode("edit");
      if (caret()) {
        if (activeLine !== caret()!.line) focus(caret()!.line);
        return;
      }
      const first = rowAtY(tops(), scroller.offset() + 8);
      const line = lineOfRow(first);
      if (line === null) return;
      setCaret({ line, col: 0 });
      focus(line);
    },
    leaveEdit: () => {
      if (activeLine !== null) focus(null);
      setMode("read");
    },
    type: (text) => edit({ insert: text }),
    backspace: () => edit({ del: 1 }),
    moveCaret: (dx, dy) => {
      const c = caret();
      const d = doc();
      if (!c || !d) return;
      if (dy !== 0) {
        const row = caretRow();
        if (row < 0) return;
        const target = row + dy;
        if (target < 0 || target >= d.rows) return;
        const targetRow = rowCache.get(target);
        if (!targetRow) return;
        const here = rowCache.get(row)!;
        const colInRow = c.col - (here.k === K_RAW ? here.s : 0);
        if (targetRow.l === c.line) {
          const len = targetRow.r.reduce((n, run) => n + run[1].length, 0);
          setCaret({ line: c.line, col: targetRow.s + Math.min(colInRow, len) });
        } else {
          setCaret({ line: targetRow.l, col: 0 });
          focus(targetRow.l);
        }
        revealCaret();
        return;
      }
      const raw = store.activeLineText();
      const col = Math.max(0, Math.min(raw.length, c.col + dx));
      if (col === c.col) {
        // Past either end: step to the neighbouring line.
        if (dx < 0 && c.line > 0) {
          setCaret({ line: c.line - 1, col: 1 << 20 });
          focus(c.line - 1);
        } else if (dx > 0 && c.line < d.lines - 1) {
          setCaret({ line: c.line + 1, col: 0 });
          focus(c.line + 1);
        }
        return;
      }
      setCaret({ line: c.line, col });
      revealCaret();
    },
    kbLayer,
    setKbLayer,
    activeLineText: () => {
      const c = caret();
      if (!c) return "";
      rowsRev();
      let text = "";
      let next = 0;
      const parts: Array<[number, string]> = [];
      for (const row of rowCache.values()) {
        if (row.l !== c.line || row.k !== K_RAW) continue;
        parts.push([row.s, row.r.map((run) => run[1]).join("")]);
      }
      parts.sort((a, b) => a[0] - b[0]);
      for (const [s, t] of parts) {
        while (text.length < s) text += " ";
        text += t;
        next = s + t.length;
      }
      void next;
      return text;
    },
    save: () => {
      const d = doc();
      if (d) mac.send("doc.save", { id: d.id });
    },
    frame,
  };
  return store;
}

/** Height of a row by kind digit — for callers with a kinds string. */
export function rowHeightOf(kinds: string, index: number): number {
  return ROW_H[parseInt(kinds[index] ?? "0", 36)] ?? 18;
}
