// The layout kernel, on its own: block classification, inline markup with
// source positions, the shared wrapper, the caret mapping, and the edit
// patches.
//
// Three invariants carry the WYSIWYG editor, and each has a test here:
//
//   1. The mapping is TOTAL. A line's rows, read back through their runs'
//      source text, are the source line — markers, bullets and checkboxes
//      included. Without that the guest could not reconstruct a line, and
//      the caret could not sit on a styled row.
//   2. The caret mapping round-trips. Every source column has an x, and the
//      column nearest that x is the column again.
//   3. The guest and the companion wrap identically. Both run the same file
//      over equal advances, so a patch confirms the screen instead of
//      correcting it — and the spans a patch carries, applied to a shadow
//      copy of the kinds string, yield the string a fresh layout would.

import { describe, expect, test } from "bun:test";
import { fontSlot } from "../app/fonts.ts";
import { faceFor, layoutLine, wrapSegments, type Face } from "../app/linewrap.ts";
import { blockKind, classify, inline, inlineTags, reKind, wikiLinks } from "../app/markdown.ts";
import {
  DOC_W,
  K_BLANK,
  K_CODE,
  K_H1,
  K_H2,
  K_HR,
  K_LI,
  K_META,
  K_P,
  K_QUOTE,
  K_TASK,
  KIND_CHARS,
  ROW_PX,
  S_BOLD,
  S_CODE,
  S_LINK,
  S_MARK,
  S_TAG,
  S_TASK,
  S_TASK_DONE,
  TASK_W,
  kindIsMono,
  runSource,
  type Patch,
  type Row,
} from "../app/protocol.ts";
import { caretX, colAtX, rowSourceEnd, rowSourceText } from "../app/rowmap.ts";
import {
  docLinks,
  docTags,
  kindsOf,
  layoutDoc,
  Metrics,
  outline,
  replaceRange,
  toggleTask,
} from "../host/layout.ts";
import { fontSlotFor } from "../vendor/pocketjs/framework/compiler/tailwind.ts";

const metrics = new Metrics();
const measure = metrics.measure;

const SOURCE =
  [
    "---",
    "title: Wire notes",
    "tags: [wire, layout]",
    "---",
    "",
    "# Wire notes",
    "",
    "The **guest** keeps one thread; see [[3DS UI]] and `svcPoll` or https://pocketjs.dev for more. " +
      "A very long paragraph so that it wraps onto several rows of a 376 pixel column of Inter at fourteen pixels.",
    "",
    "- first item",
    "- second item with **bold** and a #tag",
    "- [x] a finished task",
    "- [ ] an unfinished task with enough words in it that the text has to wrap onto a second row",
    "",
    "> Focus: fast note capture",
    "> Works offline. Sync later.",
    "",
    "```ts",
    "const x = 1;",
    "```",
    "",
    "## Second",
    "---",
    "Supercalifragilisticexpialidocious-antidisestablishmentarianism-pneumonoultramicroscopicsilicovolcanoconiosis",
  ].join("\n") + "\n";

function rowEnd(row: Row): number {
  const last = row.r[row.r.length - 1];
  if (!last) return 0;
  if (last[2] & S_TASK) return last[0] + TASK_W;
  return last[0] + measure(last[1], faceFor(last[2], kindIsMono(row.k)), ROW_PX[row.k]!);
}

function applySpans(kinds: string, patch: Patch): string {
  let out = kinds;
  for (const span of patch.spans) out = out.slice(0, span.row0) + span.kinds + out.slice(span.row0 + span.removed);
  return out;
}

describe("font slots", () => {
  test("the guest's literals are the compiler's slot table", () => {
    const faces: Array<[Face, number[]]> = [
      ["regular", [12, 14, 16, 18, 20, 24, 36]],
      ["bold", [12, 14, 16, 18, 20, 24, 36]],
      ["mono", [12, 14, 16]],
    ];
    for (const [face, sizes] of faces) {
      for (const px of sizes) {
        expect(fontSlot(face, px)).toBe(fontSlotFor(px, face === "bold", face === "mono"));
      }
    }
  });
});

describe("blocks", () => {
  test("front matter, fences, lists, tasks, quotes, rules and headings", () => {
    expect(classify(SOURCE.slice(0, -1).split("\n"))).toEqual([
      K_META, K_META, K_META, K_META, K_BLANK, K_H1, K_BLANK, K_P, K_BLANK,
      K_LI, K_LI, K_TASK, K_TASK, K_BLANK, K_QUOTE, K_QUOTE, K_BLANK,
      K_CODE, K_CODE, K_CODE, K_BLANK, K_H2, K_HR, K_P,
    ]);
  });

  test("a line's own kind is what an edit re-derives, except inside a fence", () => {
    expect(blockKind("# Title")).toBe(K_H1);
    expect(blockKind("- [ ] task")).toBe(K_TASK);
    expect(blockKind("plain")).toBe(K_P);
    // Typing "# " makes a heading on the frame it is typed.
    expect(reKind("# Title", K_P)).toBe(K_H1);
    // A line inside a fence stays code whatever it says.
    expect(reKind("# Title", K_CODE)).toBe(K_CODE);
    // Front matter is the document's business, never the line's.
    expect(reKind("anything", K_META)).toBe(K_META);
  });
});

describe("inline", () => {
  test("markers are emitted, dimmed, and cover their own source columns", () => {
    expect(inline("a **b** c")).toEqual([
      { t: "a ", s: 0, src: 0 },
      { t: "**", s: S_BOLD | S_MARK, src: 2 },
      { t: "b", s: S_BOLD, src: 4 },
      { t: "**", s: S_BOLD | S_MARK, src: 5 },
      { t: " c", s: 0, src: 7 },
    ]);
  });

  test("wiki links, links, code, tags and bare URLs", () => {
    expect(inline("see [[Page|Alias]] now").map((seg) => [seg.t, seg.src])).toEqual([
      ["see ", 0],
      ["[[", 4],
      ["Page|", 6],
      ["Alias", 11],
      ["]]", 16],
      [" now", 18],
    ]);
    expect(inline("`x`")[1]!.s & S_CODE).toBeTruthy();
    expect(inline("a #tag")[1]!.s & S_TAG).toBeTruthy();
    expect(inline("go https://x.dev")[1]!.s & S_LINK).toBeTruthy();
    expect(inline("[t](u)")[1]!.s & S_LINK).toBeTruthy();
  });

  test("segments cover every source column of every line", () => {
    for (const line of SOURCE.split("\n")) {
      let at = 0;
      for (const seg of inline(line)) {
        expect(seg.src).toBe(at);
        at += seg.t.length;
      }
      expect(at).toBe(line.length);
    }
  });

  test("wiki links and tags are extracted for the index", () => {
    expect(wikiLinks("a [[One]] b [[Two|2]]")).toEqual([
      { target: "One", col: 2 },
      { target: "Two", col: 12 },
    ]);
    expect(inlineTags("a #one and #two/deep")).toEqual(["one", "two/deep"]);
  });
});

describe("the mapping is total", () => {
  const doc = layoutDoc(metrics, 1, "wire.md", SOURCE);

  test("a line's rows read back as that line's source", () => {
    for (let line = 0; line < doc.lines.length; line++) {
      let text = "";
      for (let i = doc.lineRow0[line]!; i < doc.lineRow0[line + 1]!; i++) {
        text += rowSourceText(doc.rows[i]!);
      }
      expect(text).toBe(doc.lines[line]);
    }
  });

  test("a substitution carries the source it stands for", () => {
    const bullet = doc.rows[doc.lineRow0[9]!]!.r[0]!;
    expect(bullet[1]).toBe("•");
    expect(runSource(bullet)).toBe("- ");
    const done = doc.rows[doc.lineRow0[11]!]!.r[0]!;
    expect(done[2] & S_TASK).toBeTruthy();
    expect(done[2] & S_TASK_DONE).toBeTruthy();
    expect(runSource(done)).toBe("- [x] ");
    const quote = doc.rows[doc.lineRow0[14]!]!.r[0]!;
    expect(quote[1]).toBe("");
    expect(runSource(quote)).toBe("> ");
    expect(runSource(doc.rows[doc.lineRow0[22]!]!.r[0]!)).toBe("---");
  });

  test("every row fits the column, and its runs advance left to right", () => {
    for (const row of doc.rows) {
      expect(rowEnd(row)).toBeLessThanOrEqual(DOC_W);
      let x = -1;
      let src = -1;
      for (const run of row.r) {
        expect(run[0]).toBeGreaterThanOrEqual(x);
        expect(run[3]).toBeGreaterThanOrEqual(src);
        x = run[0];
        src = run[3];
      }
    }
  });

  test("the caret mapping round-trips over every column of every row", () => {
    for (const row of doc.rows) {
      for (let col = row.s; col <= rowSourceEnd(row); col++) {
        const x = caretX(row, col, measure);
        if (x === null) continue;
        // A column inside a substitution snaps to an edge, and a
        // zero-width substitution — a hidden quote marker, the whitespace
        // that hangs at a break — has both its edges at one x, so those
        // columns are ambiguous by construction. Every other column comes
        // back exactly.
        const ambiguous = row.r.some((run) => {
          if (run[4] === undefined && !(run[2] & S_TASK)) return false;
          const length = runSource(run).length;
          const zero = run[1] === "" && !(run[2] & S_TASK);
          return zero ? col >= run[3] && col <= run[3] + length : col > run[3] && col < run[3] + length;
        });
        if (!ambiguous) expect(colAtX(row, x, measure)).toBe(col);
      }
    }
  });
});

describe("the guest wraps as the companion does", () => {
  test("layoutLine over the same advances gives the same rows", () => {
    const doc = layoutDoc(metrics, 1, "wire.md", SOURCE);
    const kinds = classify(doc.lines);
    for (let line = 0; line < doc.lines.length; line++) {
      const mine = layoutLine(doc.lines[line]!, line, kinds[line]!, measure);
      expect(mine).toEqual(doc.rows.slice(doc.lineRow0[line]!, doc.lineRow0[line + 1]!));
    }
  });

  test("a marker's width sets the hanging indent of its continuation rows", () => {
    const doc = layoutDoc(metrics, 1, "wire.md", SOURCE);
    const task = doc.rows.slice(doc.lineRow0[12]!, doc.lineRow0[13]!);
    expect(task.length).toBeGreaterThan(1);
    expect(task[0]!.r[0]![2] & S_TASK).toBeTruthy();
    expect(task[1]!.r[0]![0]).toBe(TASK_W);
  });

  test("an empty segment list still makes one row", () => {
    expect(wrapSegments([], { measure, width: DOC_W, indent: 0, px: 14, mono: false, charWrap: false })).toEqual([
      { runs: [], s: 0 },
    ]);
  });
});

describe("edits", () => {
  test("insert, delete, split, join and a cross-line replacement patch the rows the way a fresh layout would", () => {
    const doc = layoutDoc(metrics, 1, "wire.md", SOURCE);
    let shadow = kindsOf(doc.rows);
    const steps: Array<[from: [number, number], to: [number, number], text: string]> = [
      [[7, 4], [7, 4], "really "], // insert
      [[9, 0], [9, 2], ""], // eats "- " → a paragraph, not a list item
      [[10, 14], [10, 14], "\n"], // splits the second item
      [[10, 1 << 20], [11, 0], ""], // joins it back
      [[5, 12], [5, 12], " and more"], // the heading grows
      [[9, 2], [10, 3], "X"], // a selection across lines replaced by a letter
    ];
    for (const [from, to, text] of steps) {
      const patch = replaceRange(metrics, doc, from, to, text, "t");
      shadow = patch.full ? patch.full.kinds : applySpans(shadow, patch);
      expect(shadow).toBe(kindsOf(doc.rows));
      expect(patch.text).toBe(doc.lines[patch.caret[0]]);
      expect(patch.total).toBe(doc.rows.length);
      expect(patch.map.length).toBe(96);
      const fresh = layoutDoc(metrics, 1, "wire.md", doc.lines.join("\n") + "\n");
      expect(kindsOf(fresh.rows)).toBe(kindsOf(doc.rows));
      for (const row of doc.rows) expect(rowEnd(row)).toBeLessThanOrEqual(DOC_W);
    }
    expect(doc.lines[5]).toBe("# Wire notes and more");
  });

  test("a fence typed mid-document forces a whole re-layout", () => {
    const doc = layoutDoc(metrics, 1, "wire.md", SOURCE);
    const patch = replaceRange(metrics, doc, [7, 0], [7, 0], "```\n", "t");
    expect(patch.full).toBeDefined();
    expect(patch.full!.kinds).toBe(kindsOf(doc.rows));
    expect(KIND_CHARS.indexOf(patch.full!.kinds[doc.lineRow0[10]!]!)).toBe(K_CODE);
  });

  test("a task toggles, a bullet becomes a task, a plain line becomes one", () => {
    const doc = layoutDoc(metrics, 1, "wire.md", SOURCE);
    toggleTask(metrics, doc, 11, "t");
    expect(doc.lines[11]).toBe("- [ ] a finished task");
    toggleTask(metrics, doc, 11, "t");
    expect(doc.lines[11]).toBe("- [x] a finished task");
    toggleTask(metrics, doc, 9, "t");
    expect(doc.lines[9]).toBe("- [ ] first item");
    toggleTask(metrics, doc, 7, "t");
    expect(doc.lines[7]!.startsWith("- [ ] The **guest**")).toBe(true);
  });
});

describe("extraction for the index", () => {
  const doc = layoutDoc(metrics, 1, "wire.md", SOURCE);

  test("headings, links and tags", () => {
    expect(outline(doc)).toEqual([
      { row: doc.lineRow0[5], level: K_H1, text: "Wire notes" },
      { row: doc.lineRow0[21], level: K_H2, text: "Second" },
    ]);
    expect(docLinks(doc)).toEqual([{ target: "3DS UI", line: 7 }]);
    expect(docTags(doc)).toEqual(["wire", "layout", "tag"]);
  });
});
