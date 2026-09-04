// app/markdown.ts — markdown → styled segments, shared by the companion (a
// whole document) and the guest (the one line it is editing). Both sides
// import this file, so a line the guest re-breaks after a keystroke is the
// line the companion would have sent.
//
// Every segment carries the source column its first character comes from,
// and the segments of a line cover the line's source completely — syntax
// markers included, emitted with S_MARK so the screen can dim them. That
// totality is what lets the caret sit on a styled row (see protocol.ts).
// Three markers stand in for their source instead of showing it: a list
// bullet, a task checkbox, and a quote's "> "; each carries `srcText`, and
// the caret snaps across it rather than into it.

import {
  INDENT,
  K_BLANK,
  K_CODE,
  K_H1,
  K_H2,
  K_H3,
  K_HR,
  K_LI,
  K_META,
  K_P,
  K_QUOTE,
  K_TABLE,
  K_TASK,
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
  TASK_W,
} from "./protocol.ts";

export interface Seg {
  /** Screen text. Empty for a widget or a hidden marker. */
  t: string;
  /** Style flags. */
  s: number;
  /** Source column of the first character. */
  src: number;
  /** Source text this segment stands in for, when it differs from `t`. */
  srcText?: string;
  /** Fixed screen width, for a widget or a hidden marker. */
  w?: number;
}

// ── Inline ─────────────────────────────────────────────────────────────────

const URL_RE = /^https?:\/\/[^\s)]+/;
const TAG_RE = /^#[A-Za-z][\w/-]*/;

/**
 * Inline markdown → segments covering [offset, offset + text.length).
 * `base` is OR-ed into every segment's style (a nested emphasis run).
 */
export function inline(text: string, offset = 0, base = 0): Seg[] {
  const out: Seg[] = [];
  let plain = "";
  let plainAt = offset;
  const flush = (): void => {
    if (plain !== "") out.push({ t: plain, s: base, src: plainAt });
    plain = "";
  };
  const push = (t: string, style: number, at: number): void => {
    if (t === "") return;
    flush();
    out.push({ t, s: base | style, src: at });
  };
  /** A delimiter pair around `inner`, with the markers shown dim. */
  const wrapped = (open: string, inner: string, close: string, style: number, at: number, recurse: boolean): void => {
    flush();
    push(open, style | S_MARK, at);
    if (recurse) {
      for (const seg of inline(inner, at + open.length, base | style)) out.push(seg);
    } else {
      push(inner, style, at + open.length);
    }
    push(close, style | S_MARK, at + open.length + inner.length);
    plainAt = at + open.length + inner.length + close.length;
  };
  let i = 0;
  while (i < text.length) {
    const at = offset + i;
    if (plain === "") plainAt = at;
    const ch = text[i]!;
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        wrapped("`", text.slice(i + 1, end), "`", S_CODE, at, false);
        i = end + 1;
        continue;
      }
    }
    if (ch === "[" && text[i + 1] === "[") {
      const end = text.indexOf("]]", i + 2);
      if (end > i + 2) {
        const body = text.slice(i + 2, end);
        const bar = body.indexOf("|");
        flush();
        push("[[", S_WIKI | S_MARK, at);
        if (bar >= 0) {
          // The target is dim, the alias is the link.
          push(body.slice(0, bar + 1), S_WIKI | S_MARK, at + 2);
          push(body.slice(bar + 1), S_WIKI, at + 2 + bar + 1);
        } else {
          push(body, S_WIKI, at + 2);
        }
        push("]]", S_WIKI | S_MARK, at + 2 + body.length);
        plainAt = at + 4 + body.length;
        i = end + 2;
        continue;
      }
    }
    if (ch === "[") {
      const close = text.indexOf("](", i + 1);
      const end = close > 0 ? text.indexOf(")", close + 2) : -1;
      if (close > i + 1 && end > close) {
        flush();
        push("[", S_LINK | S_MARK, at);
        push(text.slice(i + 1, close), S_LINK, at + 1);
        push(text.slice(close, end + 1), S_LINK | S_MARK, at + close - i);
        plainAt = offset + end + 1;
        i = end + 1;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && text[i + 1] === ch) {
      const end = text.indexOf(ch + ch, i + 2);
      if (end > i + 2) {
        wrapped(ch + ch, text.slice(i + 2, end), ch + ch, S_BOLD, at, true);
        i = end + 2;
        continue;
      }
    }
    if (ch === "~" && text[i + 1] === "~") {
      const end = text.indexOf("~~", i + 2);
      if (end > i + 2) {
        wrapped("~~", text.slice(i + 2, end), "~~", S_STRIKE, at, true);
        i = end + 2;
        continue;
      }
    }
    if (
      (ch === "*" || ch === "_") &&
      (i === 0 || /[\s([]/.test(text[i - 1]!)) &&
      text[i + 1] !== undefined &&
      !/\s/.test(text[i + 1]!)
    ) {
      const end = text.indexOf(ch, i + 1);
      if (end > i + 1 && !/\s/.test(text[end - 1]!)) {
        wrapped(ch, text.slice(i + 1, end), ch, S_ITALIC, at, true);
        i = end + 1;
        continue;
      }
    }
    if (ch === "h") {
      const m = URL_RE.exec(text.slice(i));
      if (m) {
        push(m[0]!, S_LINK, at);
        plainAt = at + m[0]!.length;
        i += m[0]!.length;
        continue;
      }
    }
    if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]!))) {
      const m = TAG_RE.exec(text.slice(i));
      if (m) {
        flush();
        push("#", S_TAG | S_MARK, at);
        push(m[0]!.slice(1), S_TAG, at + 1);
        plainAt = at + m[0]!.length;
        i += m[0]!.length;
        continue;
      }
    }
    plain += ch;
    i += 1;
  }
  flush();
  return out;
}

/** Every `[[wikilink]]` target on a line, with the column it starts at. */
export function wikiLinks(text: string): Array<{ target: string; col: number }> {
  const out: Array<{ target: string; col: number }> = [];
  let i = 0;
  for (;;) {
    const open = text.indexOf("[[", i);
    if (open < 0) break;
    const close = text.indexOf("]]", open + 2);
    if (close < 0) break;
    const body = text.slice(open + 2, close);
    const bar = body.indexOf("|");
    out.push({ target: (bar >= 0 ? body.slice(0, bar) : body).trim(), col: open });
    i = close + 2;
  }
  return out;
}

/** Every `#tag` on a line. */
export function inlineTags(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "#" || (i > 0 && !/\s/.test(text[i - 1]!))) continue;
    const m = TAG_RE.exec(text.slice(i));
    if (m) {
      out.push(m[0]!.slice(1));
      i += m[0]!.length - 1;
    }
  }
  return out;
}

// ── Blocks ─────────────────────────────────────────────────────────────────

const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^(#{1,6})(\s+)(.*)$/;
const BULLET_RE = /^(\s*)([-*+])(\s+)(.*)$/;
const ORDERED_RE = /^(\s*)(\d{1,3}[.)])(\s+)(.*)$/;
const TASK_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
const QUOTE_RE = /^(>+)(\s?)(.*)$/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_RE = /^\s*\|.*\|\s*$/;

/**
 * The kind a line takes from its own text, or null when only the document
 * decides (inside a fence, inside front matter). The guest re-derives a kind
 * this way after a keystroke so typing "# " becomes a heading on the frame it
 * is typed; the companion's classify() is the authority.
 */
export function blockKind(line: string): number | null {
  if (FENCE_RE.test(line)) return K_CODE;
  if (line.trim() === "") return K_BLANK;
  if (HEADING_RE.test(line)) {
    const level = HEADING_RE.exec(line)![1]!.length;
    return level === 1 ? K_H1 : level === 2 ? K_H2 : K_H3;
  }
  if (HR_RE.test(line)) return K_HR;
  if (TABLE_RE.test(line)) return K_TABLE;
  if (TASK_RE.test(line)) return K_TASK;
  if (BULLET_RE.test(line) || ORDERED_RE.test(line)) return K_LI;
  if (QUOTE_RE.test(line)) return K_QUOTE;
  return K_P;
}

/** A line's kind after an edit, given the kind it had. Inside a fence or the
 *  front matter the context wins; everywhere else the text does. */
export function reKind(line: string, previous: number): number {
  if (previous === K_META) return K_META;
  if (previous === K_CODE && !FENCE_RE.test(line)) return K_CODE;
  return blockKind(line) ?? K_P;
}

/** Kinds for every line of a document: the one place fences and front
 *  matter are resolved. */
export function classify(lines: readonly string[]): number[] {
  const out: number[] = [];
  let fence: string | null = null;
  let front = lines[0] === "---" ? "open" : "none";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (front === "open") {
      out.push(K_META);
      if (i > 0 && line === "---") front = "closed";
      continue;
    }
    if (fence !== null) {
      out.push(K_CODE);
      const m = FENCE_RE.exec(line);
      if (m && m[1] === fence) fence = null;
      continue;
    }
    const open = FENCE_RE.exec(line);
    if (open) {
      fence = open[1]!;
      out.push(K_CODE);
      continue;
    }
    out.push(blockKind(line) ?? K_P);
  }
  return out;
}

export interface Block {
  kind: number;
  /** The block's leading marker, already substituted where it substitutes. */
  marker: Seg | null;
  /** Screen width the marker occupies, and the content's indent. */
  markerW: number;
  /** Content segments, or null when the whole line is the marker (a rule). */
  content: Seg[];
  /** Content runs as monospace. */
  mono: boolean;
  /** Break inside words. */
  charWrap: boolean;
}

/** The heading text of a line, for the outline. */
export function headingText(line: string): string {
  const m = HEADING_RE.exec(line);
  return m ? m[3]!.trim() : line.trim();
}

/**
 * Split one source line into its marker and its content segments, under the
 * kind the document assigned it. Marker widths are decided here so both
 * sides indent continuation rows identically; `measureMarker` supplies the
 * width of a marker that is ordinary text.
 */
export function block(line: string, kind: number, measureMarker: (text: string) => number): Block {
  switch (kind) {
    case K_BLANK:
      return { kind, marker: null, markerW: 0, content: [], mono: false, charWrap: false };
    case K_HR:
      // The rule is drawn; its source characters live in a zero-width
      // substitution so the caret can still reach both ends of the line.
      return {
        kind,
        marker: { t: "", s: S_MARK, src: 0, srcText: line, w: 0 },
        markerW: 0,
        content: [],
        mono: false,
        charWrap: false,
      };
    case K_META:
      return { kind, marker: null, markerW: 0, content: [{ t: line, s: S_MARK, src: 0 }], mono: false, charWrap: false };
    case K_CODE:
    case K_TABLE:
      return { kind, marker: null, markerW: 0, content: [{ t: line, s: 0, src: 0 }], mono: true, charWrap: true };
    case K_H1:
    case K_H2:
    case K_H3: {
      const m = HEADING_RE.exec(line);
      if (!m) break;
      const mark = m[1]! + m[2]!;
      return {
        kind,
        marker: { t: mark, s: S_MARK | S_BOLD, src: 0 },
        markerW: measureMarker(mark),
        content: inline(m[3]!, mark.length, S_BOLD),
        mono: false,
        charWrap: false,
      };
    }
    case K_TASK: {
      const m = TASK_RE.exec(line);
      if (!m) break;
      const done = m[2] !== " ";
      const markLength = line.length - m[3]!.length;
      return {
        kind,
        marker: {
          t: "",
          s: S_MARK | S_TASK | (done ? S_TASK_DONE : 0),
          src: 0,
          srcText: line.slice(0, markLength),
          w: TASK_W,
        },
        markerW: TASK_W,
        content: inline(m[3]!, markLength, done ? S_STRIKE : 0),
        mono: false,
        charWrap: false,
      };
    }
    case K_LI: {
      const bullet = BULLET_RE.exec(line);
      if (bullet && !TASK_RE.test(line)) {
        const mark = bullet[1]! + bullet[2]! + bullet[3]!;
        return {
          kind,
          marker: { t: "•", s: S_MARK, src: 0, srcText: mark, w: INDENT + bullet[1]!.length * 6 },
          markerW: INDENT + bullet[1]!.length * 6,
          content: inline(bullet[4]!, mark.length),
          mono: false,
          charWrap: false,
        };
      }
      const ordered = ORDERED_RE.exec(line);
      if (ordered) {
        const mark = ordered[1]! + ordered[2]! + ordered[3]!;
        const width = Math.max(INDENT, measureMarker(ordered[2]! + " ")) + ordered[1]!.length * 6;
        return {
          kind,
          marker: { t: ordered[2]!, s: S_MARK, src: 0, srcText: mark, w: width },
          markerW: width,
          content: inline(ordered[4]!, mark.length),
          mono: false,
          charWrap: false,
        };
      }
      break;
    }
    case K_QUOTE: {
      const m = QUOTE_RE.exec(line);
      if (!m) break;
      const mark = m[1]! + m[2]!;
      // The box's left border says "quote", so the marker is hidden — a
      // zero-width substitution, which keeps the caret mapping total.
      return {
        kind,
        marker: { t: "", s: S_MARK, src: 0, srcText: mark, w: 0 },
        markerW: INDENT,
        content: inline(m[3]!, mark.length),
        mono: false,
        charWrap: false,
      };
    }
    default:
      break;
  }
  return { kind: K_P, marker: null, markerW: 0, content: inline(line, 0), mono: false, charWrap: false };
}
