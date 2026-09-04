// app/store.ts — the guest's whole state, and every companion conversation.
//
// Nothing in here reads a file or measures a document. The companion holds
// the vault and its layout; this store holds windows onto them: a page of
// titles around the list's viewport, a run of rows around the document's
// viewport (aimed a quarter second ahead of a fling so the rows are there
// when it lands), and the document's row-kind string from which every row
// top is a prefix sum. Patches from edits splice that string and the row
// cache in place.
//
// Editing is local first. The guest owns the ACTIVE line: it holds the
// line's raw text, applies a keystroke to it and re-breaks it on the same
// frame (app/wrap.ts — the companion's own rules over the atlas's own
// advances), and only then queues the edit for the companion. One edit is
// in flight at a time; queued keystrokes coalesce into it. The companion's
// patch confirms the rows the guest already shows and moves everything
// else — totals, the map, other lines. An edit that changes the line
// structure (a newline, a join, a selection across lines) cannot be applied
// locally without the neighbouring lines, so it waits for its patch;
// keystrokes typed meanwhile are replayed after it. Offline, the local
// line keeps accepting keystrokes and the queue drains on reconnect; the
// per-session sequence number keeps a re-sent edit from applying twice.

import { batch, createComputed, createMemo, createSignal, type Accessor } from "solid-js";
import { createCompanion, createQuery, type Companion, type CompanionOps } from "@pocketjs/framework/companion";
import { createScroller, type Scroller } from "@pocketjs/framework/kinetics";
import { BTN } from "@pocketjs/framework/input";
import {
  END_OF_LINE,
  K_RAW,
  KIND_CHARS,
  LIST_PAGE,
  PAGE_ROWS,
  STAGE_H,
  VAULT_APP,
  rowAtY,
  rowTops,
  type DocInfo,
  type ListItem,
  type ListResult,
  type OutlineItem,
  type Patch,
  type Pos,
  type Row,
  type RowsResult,
} from "./protocol.ts";
import { rowText, wrapRaw } from "./wrap.ts";

export type Mode = "files" | "search" | "read" | "outline" | "edit";
export type KbLayer = "lower" | "upper" | "sym";

export interface Caret {
  line: number;
  col: number;
}

export interface Selection {
  anchor: Caret;
  head: Caret;
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
/** A page that was asked for and still has holes is asked again no sooner
 *  than this many frames later. */
const PAGE_RETRY_FRAMES = 30;

interface EditOp {
  from: Pos;
  to: Pos;
  text: string;
  /** Changes line structure: waits for its patch, blocks local edits. */
  structural: boolean;
}

export interface VaultStore {
  mac: Companion;
  mode: Accessor<Mode>;
  setMode(mode: Mode): void;
  /** One short line for the sheet: the link's state. */
  linkLabel: Accessor<string>;
  lastError: Accessor<string | null>;

  // ── the vault list ──
  query: Accessor<string>;
  setQuery(q: string): void;
  listTotal: Accessor<number>;
  listItem(index: number): ListItem | undefined;
  setListViewport(first: number): void;
  selected: Accessor<number>;
  select(index: number): void;

  // ── the open document ──
  doc: Accessor<DocInfo | null>;
  tops: Accessor<Int32Array>;
  docHeight: Accessor<number>;
  rowAt(index: number): Row | undefined;
  rowsRev: Accessor<number>;
  scroller: Scroller;
  visibleRange: Accessor<readonly [first: number, last: number]>;
  open(id: number): void;
  outline: Accessor<OutlineItem[] | undefined>;
  jumpToRow(row: number): void;
  scrollFraction(): number;
  scrollToFraction(f: number): void;
  pageBy(direction: -1 | 1): void;

  // ── editing ──
  caret: Accessor<Caret | null>;
  selection: Accessor<Selection | null>;
  selecting: Accessor<boolean>;
  setSelecting(on: boolean): void;
  enterEdit(): void;
  leaveEdit(): void;
  insert(text: string): void;
  backspace(): void;
  moveCaret(dx: number, dy: number): void;
  kbLayer: Accessor<KbLayer>;
  setKbLayer(layer: KbLayer): void;
  /** The active line's text as the guest holds it. */
  activeText(): string;
  /** Edits not yet confirmed by the companion (queued + in flight). */
  unconfirmed: Accessor<number>;
  save(): void;

  // ── the status & settings sheet ──
  sheetOpen: Accessor<boolean>;
  setSheetOpen(open: boolean): void;

  /** Once per frame, before anything reads the scroller. */
  frame(buttons: number): void;
}

/** `ops` overrides the host's svc trio — the sim pair in tests. */
export function createVaultStore(ops?: CompanionOps | null): VaultStore {
  const mac = createCompanion(ops === undefined ? { app: VAULT_APP, device: "3ds-dev" } : { app: VAULT_APP, device: "3ds-dev", ops });
  const [mode, setMode] = createSignal<Mode>("files");
  const [lastError, setError] = createSignal<string | null>(null);
  const [sheetOpen, setSheetOpen] = createSignal(false);
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

  const aim = (): number => {
    const state = scroller.state();
    if (state === "fling") return scroller.offset() + scroller.velocity() * LOOKAHEAD_S;
    return scroller.intent();
  };

  const fail = (error: unknown): void => {
    setError(error instanceof Error ? error.message : String(error));
  };

  // ── editing state (declared early: the row pump consults it) ─────────────
  const [caret, setCaret] = createSignal<Caret | null>(null);
  const [anchor, setAnchor] = createSignal<Caret | null>(null);
  const [selecting, setSelectingSignal] = createSignal(false);
  const [kbLayer, setKbLayer] = createSignal<KbLayer>("lower");
  const [unconfirmed, setUnconfirmed] = createSignal(0);
  /** The active (raw) line, as the guest believes the companion has it. */
  let active: number | null = null;
  /** The guest's copy of the active line's text; null = not editing. */
  let localText: string | null = null;
  let seq = 0;
  const queue: EditOp[] = [];
  let inflight: EditOp | null = null;
  /** A structural edit or a focus change is waiting for its patch. */
  let blocked = false;
  /** Keystrokes typed while blocked, replayed after the patch. */
  const deferred: Array<() => void> = [];
  /** A line to focus once the edit queue has drained. */
  let pendingFocus: number | null | undefined;

  // Rows are fetched a page at a time. Every frame the wanted pages are the
  // ones under the viewport now and under where a fling is heading; a page
  // request stays in flight while its page is wanted and is cancelled the
  // moment it is not. Requests carry the layout revision.
  const inflightPages = new Map<number, number>();
  let inflightRev = -1;
  /** Frame at which each page was last asked for. A page whose reply did
   *  not fill it (the note ended early, a revision raced) is asked again no
   *  sooner than PAGE_RETRY_FRAMES later — never once per frame, which on a
   *  slow link outruns the replies and hits the companion's pending cap. */
  const pageAsked = new Map<number, number>();
  let frameCount = 0;
  const pageMissing = (page: number, total: number): boolean => {
    const from = page * PAGE_ROWS;
    const to = Math.min(total, from + PAGE_ROWS);
    for (let i = from; i < to; i++) if (!rowCache.has(i)) return true;
    return false;
  };
  const requestPage = (d: DocInfo, page: number): void => {
    const from = page * PAGE_ROWS;
    const rev = d.rev;
    pageAsked.set(page, frameCount);
    let id: number;
    try {
      id = mac.core.request("doc.rows", { id: d.id, from, count: PAGE_ROWS, rev }, (body) => {
      inflightPages.delete(page);
      if (!("ok" in body)) return;
      const result = body.ok as RowsResult;
      const current = doc();
      if (!current || current.id !== d.id || result.rev !== current.rev) return;
      // A reply that crossed a local edit would land off by the rows that
      // edit gained or lost; the page is asked again once confirmed.
      if (unconfirmed() > 0) return;
      result.rows.forEach((row, i) => {
        // The active line is the guest's while it is editing it.
        if (active !== null && localText !== null && row.l === active && rowCache.has(result.from + i)) return;
        rowCache.set(result.from + i, row);
      });
      if (rowCache.size > ROW_CACHE_MAX) {
        const centre = rowAtY(tops(), scroller.offset());
        for (const key of rowCache.keys()) {
          if (Math.abs(key - centre) > ROW_CACHE_MAX / 2) rowCache.delete(key);
        }
      }
      setRowsRev((n) => n + 1);
      });
    } catch (error) {
      // The link's pending table is full: leave the page for a later frame
      // rather than let a frame throw and take the guest down with it.
      fail(error);
      return;
    }
    inflightPages.set(page, id);
  };
  createComputed(() => {
    const d = doc();
    rowsRev();
    if (!d || d.rows === 0) {
      for (const id of inflightPages.values()) mac.core.cancel(id);
      inflightPages.clear();
      return;
    }
    if (inflightRev !== d.rev) {
      for (const id of inflightPages.values()) mac.core.cancel(id);
      inflightPages.clear();
      pageAsked.clear();
      inflightRev = d.rev;
    }
    const t = tops();
    const here = Math.max(0, scroller.offset());
    const at = Math.max(0, aim());
    const ahead = scroller.velocity() >= 0 ? 1 : -1;
    const firstPage = Math.floor(rowAtY(t, Math.min(here, at) - OVERSCAN) / PAGE_ROWS);
    const lastPage = Math.floor(rowAtY(t, Math.max(here, at) + STAGE_H + OVERSCAN) / PAGE_ROWS);
    const lastAll = Math.floor((d.rows - 1) / PAGE_ROWS);
    const wanted = new Set<number>();
    for (let page = firstPage; page <= lastPage; page++) wanted.add(page);
    const extra = ahead > 0 ? lastPage + 1 : firstPage - 1;
    if (extra >= 0 && extra <= lastAll) wanted.add(extra);
    for (const [page, id] of inflightPages) {
      if (!wanted.has(page)) {
        mac.core.cancel(id);
        inflightPages.delete(page);
      }
    }
    // While edits are unconfirmed the guest's row indices run ahead of the
    // companion's; a page fetched now would land off by the rows the local
    // line gained or lost. Pages resume once the patches have caught up.
    if (unconfirmed() > 0) return;
    for (const page of wanted) {
      if (page < 0 || page > lastAll || inflightPages.has(page) || !pageMissing(page, d.rows)) continue;
      const asked = pageAsked.get(page);
      if (asked !== undefined && frameCount - asked < PAGE_RETRY_FRAMES) continue;
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
  const selection = createMemo<Selection | null>(() => {
    const a = anchor();
    const c = caret();
    if (!a || !c || (a.line === c.line && a.col === c.col)) return null;
    return { anchor: a, head: c };
  });

  const normalizedSelection = (): [Pos, Pos] | null => {
    const s = selection();
    if (!s) return null;
    const a: Pos = [s.anchor.line, s.anchor.col];
    const h: Pos = [s.head.line, s.head.col];
    return a[0] < h[0] || (a[0] === h[0] && a[1] <= h[1]) ? [a, h] : [h, a];
  };

  const rowsOfActive = (): [row0: number, count: number] | null => {
    if (active === null) return null;
    let first = -1;
    let count = 0;
    for (const [index, row] of rowCache) {
      if (row.l !== active) continue;
      count += 1;
      if (first < 0 || index < first) first = index;
    }
    return first < 0 ? null : [first, count];
  };

  /** Replace the active line's rows with rows broken from localText. */
  const relayoutLocal = (): void => {
    const d = doc();
    if (!d || active === null || localText === null) return;
    const span = rowsOfActive();
    if (!span) return;
    const [row0, removed] = span;
    const fresh = wrapRaw(localText, active);
    const delta = fresh.length - removed;
    const kinds = d.kinds.slice(0, row0) + KIND_CHARS[K_RAW]!.repeat(fresh.length) + d.kinds.slice(row0 + removed);
    if (delta !== 0) {
      const shifted = new Map<number, Row>();
      for (const [index, row] of rowCache) {
        if (index < row0) shifted.set(index, row);
        else if (index >= row0 + removed) shifted.set(index + delta, row);
      }
      rowCache.clear();
      for (const [index, row] of shifted) rowCache.set(index, row);
    }
    fresh.forEach((row, i) => rowCache.set(row0 + i, row));
    batch(() => {
      setDoc({ ...d, kinds, rows: d.rows + delta });
      setRowsRev((n) => n + 1);
    });
  };

  const caretRow = (): number => {
    const c = caret();
    if (!c || !doc()) return -1;
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

  const applyPatch = (patch: Patch, source: "focus" | "edit" | "structural"): void => {
    const d = doc();
    if (!d) return;
    const settled = queue.length === 0 && inflight === null;
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
      if (source !== "edit" || settled) {
        active = patch.text === undefined ? null : patch.caret[0];
        localText = patch.text ?? null;
        if (source !== "edit" || settled) setCaret({ line: patch.caret[0], col: patch.caret[1] });
      }
      setRowsRev((n) => n + 1);
    });
    // The guest's copy of the active line wins on screen; when in sync it
    // equals what the companion just sent.
    relayoutLocal();
    revealCaret();
  };

  const replayDeferred = (): void => {
    const work = deferred.splice(0);
    for (const step of work) step();
  };

  const sendFocus = (line: number | null): void => {
    const d = doc();
    if (!d) return;
    blocked = true;
    mac.call<Patch>("doc.focus", { id: d.id, line }).then(
      (patch) => {
        blocked = false;
        applyPatch(patch, "focus");
        replayDeferred();
        flush();
      },
      (error) => {
        blocked = false;
        fail(error);
        replayDeferred();
      },
    );
  };

  /** Focus `line` once the edit queue has drained: queued edits refer to the
   *  line that is active on the companion. */
  const focus = (line: number | null): void => {
    if (queue.length > 0 || inflight !== null || blocked) {
      pendingFocus = line;
      return;
    }
    sendFocus(line);
  };

  const flush = (): void => {
    if (inflight !== null || blocked) return;
    if (queue.length === 0) {
      if (pendingFocus !== undefined) {
        const line = pendingFocus;
        pendingFocus = undefined;
        sendFocus(line);
      }
      return;
    }
    const d = doc();
    if (!d) {
      queue.length = 0;
      setUnconfirmed(0);
      return;
    }
    const op = queue.shift()!;
    inflight = op;
    if (op.structural) blocked = true;
    seq += 1;
    const settle = (patch: Patch | null, error?: unknown): void => {
      inflight = null;
      if (op.structural) blocked = false;
      setUnconfirmed(queue.length);
      if (patch) applyPatch(patch, op.structural ? "structural" : "edit");
      else fail(error);
      if (op.structural) replayDeferred();
      flush();
    };
    mac.call<Patch>("doc.edit", { id: d.id, seq, from: op.from, to: op.to, text: op.text }).then(
      (patch) => settle(patch),
      (error) => settle(null, error),
    );
  };

  const enqueue = (op: EditOp): void => {
    const last = queue[queue.length - 1];
    if (last && !last.structural && !op.structural && last.from[0] === op.from[0]) {
      const insertRun =
        last.text !== "" && op.text !== "" &&
        last.from[1] === last.to[1] && op.from[1] === op.to[1] &&
        op.from[1] === last.from[1] + last.text.length;
      const deleteRun = last.text === "" && op.text === "" && op.to[1] === last.from[1];
      if (insertRun) {
        last.text += op.text;
        return;
      }
      if (deleteRun) {
        last.from = op.from;
        return;
      }
    }
    queue.push(op);
    setUnconfirmed(queue.length + (inflight ? 1 : 0));
    flush();
  };

  const clearSelection = (): void => {
    setAnchor(null);
  };

  const structural = (from: Pos, to: Pos, text: string): void => {
    clearSelection();
    enqueue({ from, to, text, structural: true });
  };

  const insert = (text: string): void => {
    const c = caret();
    if (!doc() || !c || active === null || localText === null) return;
    if (blocked) {
      deferred.push(() => insert(text));
      return;
    }
    const sel = normalizedSelection();
    if (text.includes("\n") || (sel && sel[0][0] !== sel[1][0])) {
      structural(sel ? sel[0] : [c.line, c.col], sel ? sel[1] : [c.line, c.col], text);
      return;
    }
    const from = sel ? sel[0][1] : c.col;
    const to = sel ? sel[1][1] : c.col;
    localText = localText.slice(0, from) + text + localText.slice(to);
    clearSelection();
    setCaret({ line: c.line, col: from + text.length });
    relayoutLocal();
    revealCaret();
    enqueue({ from: [c.line, from], to: [c.line, to], text, structural: false });
  };

  const backspace = (): void => {
    const c = caret();
    if (!doc() || !c || active === null || localText === null) return;
    if (blocked) {
      deferred.push(() => backspace());
      return;
    }
    const sel = normalizedSelection();
    if (sel) {
      if (sel[0][0] !== sel[1][0]) {
        structural(sel[0], sel[1], "");
        return;
      }
      localText = localText.slice(0, sel[0][1]) + localText.slice(sel[1][1]);
      clearSelection();
      setCaret({ line: c.line, col: sel[0][1] });
      relayoutLocal();
      enqueue({ from: sel[0], to: sel[1], text: "", structural: false });
      return;
    }
    if (c.col > 0) {
      localText = localText.slice(0, c.col - 1) + localText.slice(c.col);
      setCaret({ line: c.line, col: c.col - 1 });
      relayoutLocal();
      revealCaret();
      enqueue({ from: [c.line, c.col - 1], to: [c.line, c.col], text: "", structural: false });
      return;
    }
    if (c.line > 0) structural([c.line - 1, END_OF_LINE], [c.line, 0], "");
  };

  const lineOfRow = (index: number): number | null => rowCache.get(index)?.l ?? null;

  const moveCaret = (dx: number, dy: number): void => {
    const c = caret();
    const d = doc();
    if (!c || !d) return;
    if (selecting() && !anchor()) setAnchor({ ...c });
    if (!selecting()) clearSelection();
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
        setCaret({ line: c.line, col: targetRow.s + Math.min(colInRow, rowText(targetRow).length) });
      } else {
        setCaret({ line: targetRow.l, col: 0 });
        focus(targetRow.l);
      }
      revealCaret();
      return;
    }
    const raw = localText ?? "";
    const col = Math.max(0, Math.min(raw.length, c.col + dx));
    if (col === c.col) {
      if (dx < 0 && c.line > 0) {
        setCaret({ line: c.line - 1, col: END_OF_LINE });
        focus(c.line - 1);
      } else if (dx > 0 && c.line < d.lines - 1) {
        setCaret({ line: c.line + 1, col: 0 });
        focus(c.line + 1);
      }
      return;
    }
    setCaret({ line: c.line, col });
    revealCaret();
  };

  // ── per-frame input ───────────────────────────────────────────────────────
  let prevButtons = 0;
  let heldFrames = 0;
  const repeatable = BTN.UP | BTN.DOWN | BTN.LEFT | BTN.RIGHT;

  const frame = (buttons: number): void => {
    frameCount += 1;
    scroller.step();
    const pressed = buttons & ~prevButtons;
    prevButtons = buttons;
    if (sheetOpen()) {
      if (pressed & (BTN.CROSS | BTN.START)) setSheetOpen(false);
      return;
    }
    const m = mode();
    if (m === "edit") {
      const held = buttons & repeatable;
      let fire = pressed & repeatable;
      if (held && !(pressed & repeatable)) {
        heldFrames += 1;
        if (heldFrames >= REPEAT_DELAY && (heldFrames - REPEAT_DELAY) % REPEAT_EVERY === 0) fire = held;
      } else heldFrames = 0;
      if (fire & BTN.UP) moveCaret(0, -1);
      if (fire & BTN.DOWN) moveCaret(0, 1);
      if (fire & BTN.LEFT) moveCaret(-1, 0);
      if (fire & BTN.RIGHT) moveCaret(1, 0);
      if (pressed & BTN.CROSS) store.leaveEdit();
      if (pressed & BTN.TRIANGLE) store.setSelecting(!selecting());
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

  const linkLabel = createMemo(() => {
    const s = mac.status();
    if (s === "absent") return "no svc mailbox on this host";
    if (s === "searching") return "looking for the companion";
    return `linked to ${mac.name()}`;
  });

  const store: VaultStore = {
    mac,
    mode,
    setMode: (next) => {
      if (next !== "edit" && mode() === "edit") store.leaveEdit();
      setMode(next);
    },
    linkLabel,
    lastError,
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
        setAnchor(null);
        active = null;
        localText = null;
        queue.length = 0;
        inflight = null;
        blocked = false;
        deferred.length = 0;
        pendingFocus = undefined;
        setUnconfirmed(0);
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
    selection,
    selecting,
    setSelecting: (on) => {
      setSelectingSignal(on);
      const c = caret();
      if (on && c) setAnchor({ ...c });
      if (!on) clearSelection();
    },
    enterEdit: () => {
      const d = doc();
      if (!d || d.rows === 0) return;
      setMode("edit");
      const c = caret();
      if (c) {
        if (active !== c.line) focus(c.line);
        return;
      }
      const first = rowAtY(tops(), scroller.offset() + 8);
      const line = lineOfRow(first);
      if (line === null) return;
      setCaret({ line, col: 0 });
      focus(line);
    },
    leaveEdit: () => {
      clearSelection();
      setSelectingSignal(false);
      if (active !== null || pendingFocus !== undefined) focus(null);
      setMode("read");
    },
    insert,
    backspace,
    moveCaret,
    kbLayer,
    setKbLayer,
    activeText: () => localText ?? "",
    unconfirmed,
    save: () => {
      const d = doc();
      if (d) mac.send("doc.save", { id: d.id });
    },
    sheetOpen,
    setSheetOpen,
    frame,
  };
  return store;
}
