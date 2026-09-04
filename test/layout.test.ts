// The companion's layout engine, on its own: block classification, inline
// markup, wrapping under the console's width with the console's advances,
// and the edit patches. The load-bearing invariant is the last one — the
// spans a patch carries, applied to a shadow copy of the kinds string, yield
// the same string a fresh layout of the edited source would.

import { describe, expect, test } from "bun:test";
import {
  DOC_W,
  K_BLANK,
  K_CODE,
  K_H1,
  K_H2,
  K_LI,
  K_META,
  K_P,
  K_QUOTE,
  K_RAW,
  KIND_CHARS,
  END_OF_LINE,
  ROW_PX,
  S_BOLD,
  S_CODE,
  S_LINK,
  S_MARK,
  S_WIKI,
  type Patch,
  type Row,
} from "../app/protocol.ts";
import { classify, focusLine, inline, kindsOf, layoutDoc, Metrics, outline, replaceRange, type Face } from "../host/layout.ts";

const metrics = new Metrics();

const SOURCE = [
  "---",
  "title: Wire notes",
  "---",
  "",
  "# Wire notes",
  "",
  "The **guest** keeps one thread; see [[companion-1]] and `svcPoll` or https://pocketjs.dev for more. " +
    "A very long paragraph so that it wraps onto several rows on a 376 pixel column of Inter at fourteen pixels.",
  "- first item",
  "- second item with **bold**",
  "> a quote",
  "```ts",
  "const x = 1;",
  "```",
  "## Second",
  "Supercalifragilisticexpialidocious-antidisestablishmentarianism-pneumonoultramicroscopicsilicovolcanoconiosis",
].join("\n") + "\n";

function faceFor(row: Row, style: number): Face {
  if (style & S_CODE || row.k === K_CODE) return "mono";
  if (style & S_BOLD || row.k === K_H1 || row.k === K_H2) return "bold";
  return "regular";
}

function rowEnd(row: Row): number {
  const last = row.r[row.r.length - 1];
  if (!last) return 0;
  return last[0] + metrics.width(last[1], faceFor(row, last[2]), ROW_PX[row.k]!);
}

function applySpans(kinds: string, patch: Patch): string {
  let out = kinds;
  for (const span of patch.spans) out = out.slice(0, span.row0) + span.kinds + out.slice(span.row0 + span.removed);
  return out;
}

describe("classify", () => {
  test("front matter, fences, lists, quotes, headings and blanks", () => {
    const kinds = classify(SOURCE.slice(0, -1).split("\n")).map((info) => info.kind);
    expect(kinds).toEqual([
      K_META, K_META, K_META, K_BLANK, K_H1, K_BLANK, K_P, K_LI, K_LI, K_QUOTE, K_CODE, K_CODE, K_CODE, K_H2, K_P,
    ]);
  });
});

describe("inline", () => {
  test("bold, code, wiki links, links and bare URLs become styled segments", () => {
    const segs = inline("The **guest** keeps [[companion-1|the link]] and `svcPoll` or https://pocketjs.dev.");
    expect(segs).toEqual([
      { t: "The ", s: 0 },
      { t: "guest", s: S_BOLD },
      { t: " keeps ", s: 0 },
      { t: "the link", s: S_WIKI },
      { t: " and ", s: 0 },
      { t: "svcPoll", s: S_CODE },
      { t: " or ", s: 0 },
      { t: "https://pocketjs.dev.", s: S_LINK },
    ]);
  });

  test("an unmatched delimiter stays literal", () => {
    expect(inline("a * b ** c")).toEqual([{ t: "a * b ** c", s: 0 }]);
  });
});

describe("layout", () => {
  const doc = layoutDoc(metrics, 1, "wire.md", SOURCE);

  test("every source line has at least one row and rows never exceed the column", () => {
    expect(doc.lineRow0.length).toBe(doc.lines.length + 1);
    for (let line = 0; line < doc.lines.length; line++) {
      expect(doc.lineRow0[line + 1]! - doc.lineRow0[line]!).toBeGreaterThanOrEqual(1);
      for (let i = doc.lineRow0[line]!; i < doc.lineRow0[line + 1]!; i++) expect(doc.rows[i]!.l).toBe(line);
    }
    for (const row of doc.rows) expect(rowEnd(row)).toBeLessThanOrEqual(DOC_W);
  });

  test("a long paragraph wraps, a list item carries its marker, a word wider than the column splits", () => {
    const paragraph = doc.rows.filter((row) => row.l === 6);
    expect(paragraph.length).toBeGreaterThan(2);
    expect(paragraph[0]!.r.some((run) => run[1] === "guest" && run[2] === S_BOLD)).toBe(true);
    const item = doc.rows.filter((row) => row.l === 7)[0]!;
    expect(item.r[0]).toEqual([0, "•", S_MARK]);
    const wide = doc.rows.filter((row) => row.l === 14);
    expect(wide.length).toBeGreaterThan(1);
    expect(wide.map((row) => row.r.map((run) => run[1]).join("")).join("")).toBe(doc.lines[14]);
  });

  test("the outline lists headings with the rows they start", () => {
    expect(outline(doc)).toEqual([
      { row: doc.lineRow0[4], level: K_H1, text: "Wire notes" },
      { row: doc.lineRow0[13], level: K_H2, text: "Second" },
    ]);
  });
});

describe("edits", () => {
  test("focusing a line shows it raw, and unfocusing restores the layout exactly", () => {
    const doc = layoutDoc(metrics, 1, "wire.md", SOURCE);
    const before = kindsOf(doc.rows);
    let shadow = before;
    const focused = focusLine(metrics, doc, 6, "t");
    shadow = applySpans(shadow, focused);
    expect(shadow).toBe(kindsOf(doc.rows));
    expect(doc.rows.filter((row) => row.l === 6).every((row) => row.k === K_RAW)).toBe(true);
    // A raw row keeps its trailing space: the joined rows are the source line.
    const raw = doc.rows.filter((row) => row.l === 6);
    let text = "";
    for (const row of raw) {
      while (text.length < row.s) text += " ";
      text += row.r.map((run) => run[1]).join("");
    }
    expect(text).toBe(doc.lines[6]);
    const unfocused = focusLine(metrics, doc, null, "t");
    shadow = applySpans(shadow, unfocused);
    expect(shadow).toBe(before);
    expect(kindsOf(doc.rows)).toBe(before);
  });

  test("insert, delete, split and join patch the row string the way a fresh layout would", () => {
    const doc = layoutDoc(metrics, 1, "wire.md", SOURCE);
    let shadow = kindsOf(doc.rows);
    const steps: Array<[from: [number, number], to: [number, number], text: string]> = [
      [[6, 4], [6, 4], "really "], // insert
      [[6, 0], [6, 0], "**"],
      [[7, 0], [7, 2], ""], // eats "- " → a paragraph, not a list item
      [[8, 14], [8, 14], "\n"], // splits the second item
      [[8, END_OF_LINE], [9, 0], ""], // joins it back (backspace at column 0)
      [[4, 12], [4, 12], " and more"],
      [[6, 2], [8, 3], "X"], // a selection across lines replaced by one letter
    ];
    let caret: [number, number] = [0, 0];
    for (const [from, to, text] of steps) {
      const patch = replaceRange(metrics, doc, from, to, text, "t");
      if (patch.full) shadow = patch.full.kinds;
      else shadow = applySpans(shadow, patch);
      caret = patch.caret;
      expect(shadow).toBe(kindsOf(doc.rows));
      expect(patch.text).toBe(doc.lines[caret[0]]);
      const fresh = layoutDoc(metrics, 1, "wire.md", doc.lines.join("\n") + "\n");
      focusLine(metrics, fresh, doc.active, "t");
      expect(kindsOf(fresh.rows)).toBe(kindsOf(doc.rows));
      expect(patch.total).toBe(doc.rows.length);
      expect(patch.map.length).toBe(96);
      for (const row of doc.rows) expect(rowEnd(row)).toBeLessThanOrEqual(DOC_W);
    }
    expect(caret).toEqual([6, 3]);
    expect(doc.lines[4]).toBe("# Wire notes and more");
    expect(doc.lines[6]!.startsWith("**Xecond item with")).toBe(true);
  });

  test("a fence typed mid-document forces a whole re-layout", () => {
    const doc = layoutDoc(metrics, 1, "wire.md", SOURCE);
    const patch = replaceRange(metrics, doc, [6, 0], [6, 0], "```\n", "t");
    expect(patch.full).toBeDefined();
    expect(patch.full!.kinds).toBe(kindsOf(doc.rows));
    expect(KIND_CHARS.indexOf(patch.full!.kinds[doc.lineRow0[8]!]!)).toBe(K_CODE);
  });
});
