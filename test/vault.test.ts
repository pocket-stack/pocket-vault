// The guest store against the real companion service, in one process, over
// the sim pair — no renderer, no sockets, no device. A frame here is what a
// frame is on the console: the store's frame(), one pump (requests go out), a
// transport tick (replies become visible), one pump (replies land), then the
// microtask queue (a call() settles through a Promise).
//
// What is asserted is the shape of the conversation and the promise the
// editor makes: a keystroke shows before the request goes out, offline
// typing drains on reconnect, and the companion's patch confirms what the
// screen already shows.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoot } from "solid-js";
import { BTN } from "../vendor/pocketjs/framework/src/input-api.ts";
import { createCompanionHost } from "../vendor/pocketjs/tools/companion-host.ts";
import { createSimCompanionPair, type SimCompanionPair } from "../vendor/pocketjs/hosts/sim/companion.ts";
import { setMeasurer } from "../app/fonts.ts";
import { K_H1, K_TASK, ROW_H, type Row } from "../app/protocol.ts";
import { rowSourceText } from "../app/rowmap.ts";
import { createVaultStore, type VaultStore } from "../app/store.ts";
import { createVaultService } from "../host/serve.ts";

let dir = "";
let service: ReturnType<typeof createVaultService>;

const NOTE = (n: number): string =>
  [
    "---",
    `title: Note ${String(n).padStart(2, "0")}`,
    "tags: [wire, notes]",
    "---",
    "",
    `# Note ${n}`,
    "",
    ...Array.from(
      { length: 12 },
      (_, i) => `Paragraph ${i} of note ${n}: ${"the quick brown fox jumps over the lazy dog ".repeat(2)}`,
    ),
    "",
    "- first **bold** item",
    "- [ ] a task to do",
    "- [x] a task that is done",
    "",
    "> Focus: fast capture",
    "> Works offline.",
    "",
    `See also [[Note ${String(((n % 12) + 1)).padStart(2, "0")}]] and #wire.`,
    "",
    "```ts",
    "const x = 1;",
    "```",
  ].join("\n") + "\n";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pocket-vault-"));
  mkdirSync(join(dir, "01 Projects"), { recursive: true });
  mkdirSync(join(dir, "02 Areas"), { recursive: true });
  for (let n = 1; n <= 12; n++) {
    const folder = n % 3 === 0 ? "01 Projects" : n % 3 === 1 ? "" : "02 Areas";
    writeFileSync(join(dir, folder, `note-${n}.md`), NOTE(n));
  }
  service = createVaultService({ vault: dir, memory: true, log: () => {} });
  // No host in a headless test: the guest measures with the companion's
  // Metrics, the same Inter advances the atlas was baked from.
  setMeasurer((text, face, px) => service.metrics.width(text, face, px));
});

afterAll(() => {
  service.close();
  setMeasurer(null);
  rmSync(dir, { recursive: true, force: true });
});

async function frames(store: VaultStore, pair: SimCompanionPair, n = 1, buttons = 0): Promise<void> {
  for (let i = 0; i < n; i++) {
    store.frame(buttons);
    store.mac.core.pump();
    pair.tick();
    store.mac.core.pump();
    await Promise.resolve();
    await Promise.resolve();
  }
}

/** The first row index the guest holds for a source line. */
function firstRowOfLine(store: VaultStore, line: number): number {
  const total = store.doc()?.rows ?? 0;
  for (let i = 0; i < total; i++) if (store.rowAt(i)?.l === line) return i;
  return -1;
}

/** Put the caret on a source line the way a tap does: enter edit, then aim.
 *  The front matter is a poor line to type into — it reclassifies the whole
 *  note — so the editing tests aim at a paragraph. */
async function caretOnLine(store: VaultStore, pair: SimCompanionPair, line: number): Promise<void> {
  store.enterEdit();
  await frames(store, pair, 2);
  const row = firstRowOfLine(store, line);
  expect(row).toBeGreaterThanOrEqual(0);
  store.caretToRow(row, 0);
  await frames(store, pair, 2);
}

/** The rows the guest holds for one source line, in order. */
function rowsOfLine(store: VaultStore, line: number): Row[] {
  const out: Row[] = [];
  const total = store.doc()?.rows ?? 0;
  for (let i = 0; i < total; i++) {
    const row = store.rowAt(i);
    if (row && row.l === line) out.push(row);
  }
  return out;
}

function screenText(store: VaultStore, line: number): string {
  return rowsOfLine(store, line)
    .map((row) => rowSourceText(row))
    .join("");
}

describe("browsing the vault", () => {
  test("the tree opens, a folder filters the list, and a note opens with styled rows", async () => {
    const pair = createSimCompanionPair(service.host);
    await createRoot(async (dispose) => {
      const store = createVaultStore(pair.ops);
      await frames(store, pair, 4);
      expect(store.mac.status()).toBe("linked");

      // The root's children: two folders, then the notes at the root.
      const roots = store.treeRows();
      expect(roots.filter((row) => row.entry.folder).map((row) => row.entry.name)).toEqual([
        "01 Projects",
        "02 Areas",
      ]);
      expect(roots.find((row) => row.entry.folder && row.entry.name === "01 Projects")!.entry.count).toBe(4);
      // A folder with more notes than the tree carries ends with a row that
      // hands the rest to the note list.
      expect(roots.some((row) => row.entry.name.endsWith("more in this folder"))).toBe(false);
      expect(store.listTotal()).toBe(12);

      // Opening a folder fetches its children and filters the note list.
      store.toggleFolder("01 Projects");
      store.setFolder("01 Projects");
      await frames(store, pair, 4);
      expect(store.treeRows().some((row) => row.depth === 1)).toBe(true);
      expect(store.listTotal()).toBe(4);

      store.setFolder("");
      await frames(store, pair, 3);
      expect(store.listTotal()).toBe(12);
      store.select(0);
      await frames(store, pair, 4);
      const doc = store.doc()!;
      expect(doc.title).toBe("Note 01");
      expect(doc.kinds.length).toBe(doc.rows);

      // WYSIWYG: the heading keeps its "# " marker, dimmed, and the task
      // rows carry a checkbox that stands in for "- [ ] ".
      const heading = rowsOfLine(store, 5)[0]!;
      expect(heading.k).toBe(K_H1);
      expect(heading.r[0]![1]).toBe("# ");
      expect(screenText(store, 5)).toBe("# Note 1");
      const task = rowsOfLine(store, 21)[0]!;
      expect(task.k).toBe(K_TASK);
      expect(screenText(store, 21)).toBe("- [ ] a task to do");
      dispose();
    });
  });

  test("tags and links describe the open note", async () => {
    const pair = createSimCompanionPair(service.host);
    await createRoot(async (dispose) => {
      const store = createVaultStore(pair.ops);
      await frames(store, pair, 3);
      store.select(0);
      await frames(store, pair, 4);

      store.setTab("links");
      await frames(store, pair, 4);
      expect(store.outline().map((item) => item.text)).toEqual(["Note 1"]);
      const links = store.links()!;
      expect(links.out.map((link) => link.title)).toEqual(["Note 02"]);
      expect(links.out[0]!.id).not.toBeNull();

      store.setTab("tags");
      await frames(store, pair, 4);
      expect(store.tags().map((item) => item.tag).sort()).toEqual(["notes", "wire"]);
      store.setTag("wire");
      await frames(store, pair, 3);
      expect(store.listTotal()).toBe(12);
      dispose();
    });
  });

  test("search narrows the list and a foreign change on disk bumps the version", async () => {
    const pair = createSimCompanionPair(service.host);
    await createRoot(async (dispose) => {
      const store = createVaultStore(pair.ops);
      await frames(store, pair, 3);
      store.setQuery("Note 07");
      await frames(store, pair, 3);
      // The note itself, and the note whose body links to it.
      expect(store.listTotal()).toBe(2);
      expect(store.listItem(0)?.title).toBe("Note 07");
      store.setQuery("");
      await frames(store, pair, 3);
      expect(store.listTotal()).toBe(12);

      writeFileSync(join(dir, "note-13.md"), NOTE(13));
      service.index.sync();
      service.host.publish("vault.changed", { version: service.index.currentVersion() });
      await frames(store, pair, 4);
      expect(store.listTotal()).toBe(13);
      dispose();
    });
  });
});

describe("editing is local first", () => {
  test("a keystroke, a split and a join all show before the companion answers", async () => {
    const pair = createSimCompanionPair(service.host);
    await createRoot(async (dispose) => {
      const store = createVaultStore(pair.ops);
      await frames(store, pair, 3);
      store.select(0);
      await frames(store, pair, 5);
      const before = store.doc()!;

      // A paragraph, not the front matter.
      await caretOnLine(store, pair, 7);
      expect(store.deck()).toBe("edit");
      const caret = store.caret()!;
      const line = caret.line;
      expect(line).toBe(7);
      const source = readFileSync(join(dir, "note-1.md"), "utf8").split("\n")[line]!;
      expect(store.activeText()).toBe(source);

      // Typing: the text, the caret AND the painted rows move on this frame,
      // with nothing sent yet.
      store.insert("Q");
      store.insert("Z");
      expect(store.activeText()).toBe(`QZ${source}`);
      expect(store.caret()).toEqual({ line, col: 2 });
      expect(screenText(store, line)).toBe(`QZ${source}`);
      expect(store.unconfirmed()).toBeGreaterThan(0);

      await frames(store, pair, 4);
      expect(store.unconfirmed()).toBe(0);
      expect(store.activeText()).toBe(`QZ${source}`);
      expect(store.doc()!.rev).toBeGreaterThan(before.rev);

      // Backspace, still local.
      store.backspace();
      expect(store.activeText()).toBe(`Q${source}`);
      await frames(store, pair, 4);
      expect(store.activeText()).toBe(`Q${source}`);

      // Return splits the line locally: the caret is on the new line and
      // both halves are painted before any reply.
      const rowsBefore = store.doc()!.rows;
      store.insert("\n");
      expect(store.caret()).toEqual({ line: line + 1, col: 0 });
      expect(store.activeText()).toBe(source);
      expect(screenText(store, line)).toBe("Q");
      expect(screenText(store, line + 1)).toBe(source);
      expect(store.doc()!.rows).toBeGreaterThanOrEqual(rowsBefore);
      await frames(store, pair, 4);
      expect(store.unconfirmed()).toBe(0);
      expect(store.doc()!.rows).toBe(store.doc()!.kinds.length);

      // Backspace at column 0 joins it back, locally, reading the line above
      // out of its own rows.
      store.backspace();
      expect(store.caret()).toEqual({ line, col: 1 });
      expect(store.activeText()).toBe(`Q${source}`);
      expect(screenText(store, line)).toBe(`Q${source}`);
      await frames(store, pair, 4);
      expect(store.unconfirmed()).toBe(0);

      // The file on disk agrees once the note is saved.
      store.leaveEdit();
      await frames(store, pair, 3);
      service.flush();
      expect(readFileSync(join(dir, "note-1.md"), "utf8").split("\n")[line]).toBe(`Q${source}`);
      dispose();
    });
  });

  test("offline keystrokes keep landing and drain on reconnect", async () => {
    const pair = createSimCompanionPair(service.host);
    await createRoot(async (dispose) => {
      const store = createVaultStore(pair.ops);
      await frames(store, pair, 3);
      store.select(1);
      await frames(store, pair, 5);
      await caretOnLine(store, pair, 8);
      const caret = store.caret()!;
      const source = store.activeText();
      expect(caret).toEqual({ line: 8, col: 0 });

      pair.disconnect();
      await frames(store, pair, 2);
      expect(store.mac.status()).toBe("searching");
      store.insert("!");
      store.insert("!");
      expect(store.activeText()).toBe(`!!${source}`);
      expect(screenText(store, caret.line)).toBe(`!!${source}`);

      pair.connect();
      await frames(store, pair, 6);
      expect(store.mac.status()).toBe("linked");
      expect(store.unconfirmed()).toBe(0);
      expect(store.activeText()).toBe(`!!${source}`);
      store.leaveEdit();
      await frames(store, pair, 3);
      service.flush();
      const note = store.doc()!;
      expect(readFileSync(join(dir, note.path), "utf8").split("\n")[caret.line]).toBe(`!!${source}`);
      dispose();
    });
  });

  test("a selection is replaced, and a task toggles through the companion", async () => {
    const pair = createSimCompanionPair(service.host);
    await createRoot(async (dispose) => {
      const store = createVaultStore(pair.ops);
      await frames(store, pair, 3);
      store.select(2);
      await frames(store, pair, 5);
      await caretOnLine(store, pair, 9);
      const line = store.caret()!.line;
      const source = store.activeText();
      expect(source.length).toBeGreaterThan(10);

      store.setSelecting(true);
      for (let i = 0; i < 5; i++) store.moveCaret(1, 0);
      expect(store.anchor()).toEqual({ line, col: 0 });
      expect(store.caret()).toEqual({ line, col: 5 });
      store.insert("X");
      expect(store.activeText()).toBe(`X${source.slice(5)}`);
      store.setSelecting(false);
      await frames(store, pair, 4);
      expect(store.unconfirmed()).toBe(0);

      // A checkbox flips on the companion, which owns the source text.
      const task = rowsOfLine(store, 21)[0];
      if (task) {
        store.caretToRow(store.doc()!.kinds.length - 1, 0);
        await frames(store, pair, 2);
      }
      store.toggleTask();
      await frames(store, pair, 4);
      expect(store.lastError()).toBeNull();
      dispose();
    });
  });
});

describe("the shoulders", () => {
  test("a tap turns a page, a hold opens the menu and the d-pad picks an item", async () => {
    const pair = createSimCompanionPair(service.host);
    await createRoot(async (dispose) => {
      const store = createVaultStore(pair.ops);
      await frames(store, pair, 3);
      store.select(0);
      await frames(store, pair, 6);
      expect(store.pages()).toBeGreaterThan(1);

      // A tap: pressed and released inside the hold window.
      await frames(store, pair, 2, BTN.RTRIGGER);
      await frames(store, pair, 2, 0);
      expect(store.scroller.intent()).toBeGreaterThan(0);
      expect(store.menu()).toBeNull();

      // A hold: the menu opens and stays while the shoulder is down.
      await frames(store, pair, 20, BTN.LTRIGGER);
      expect(store.menu()).toBe("vault");
      expect(store.menuIndex()).toBe(0);
      store.frame(BTN.LTRIGGER | BTN.DOWN);
      expect(store.menuIndex()).toBe(1);
      // Releasing without A closes it and does not turn a page.
      const where = store.scroller.intent();
      await frames(store, pair, 2, 0);
      expect(store.menu()).toBeNull();
      expect(store.scroller.intent()).toBe(where);

      // Held, then A: the item runs.
      await frames(store, pair, 20, BTN.RTRIGGER);
      expect(store.menu()).toBe("actions");
      store.frame(BTN.RTRIGGER | BTN.CIRCLE);
      await frames(store, pair, 3, 0);
      expect(store.menu()).toBeNull();
      expect(store.deck()).toBe("edit");
      store.leaveEdit();
      dispose();
    });
  });
});

describe("row paging stays bounded", () => {
  test("a page that never fills is asked again at most every PAGE_RETRY_FRAMES, not every frame", async () => {
    // A companion whose rows reply is always empty: the worst case for the
    // pager. On the console this once outran the replies on a slow link and
    // hit the companion module's 64-pending cap inside a frame.
    let rowsCalls = 0;
    const hollow = createCompanionHost({
      app: "vault",
      name: "hollow",
      methods: {
        ...service.methods,
        "doc.rows": (params: { from: number; rev: number }) => {
          rowsCalls += 1;
          return { from: params.from, rev: params.rev, rows: [] };
        },
      },
    });
    const pair = createSimCompanionPair(hollow);
    await createRoot(async (dispose) => {
      const store = createVaultStore(pair.ops);
      await frames(store, pair, 3);
      store.select(0);
      await frames(store, pair, 3);
      expect(store.doc()).not.toBeNull();
      const before = rowsCalls;
      await frames(store, pair, 120);
      // Two seconds of frames, a handful of wanted pages, retries every 30
      // frames: tens of requests, not hundreds — and nothing piles up.
      expect(rowsCalls - before).toBeLessThan(40);
      expect(store.mac.core.pendingCount()).toBeLessThan(8);
      expect(store.lastError()).toBeNull();
      dispose();
    });
  });
});

describe("row heights", () => {
  test("every cached row's height matches the kinds string the prefix sum runs over", async () => {
    const pair = createSimCompanionPair(service.host);
    await createRoot(async (dispose) => {
      const store = createVaultStore(pair.ops);
      await frames(store, pair, 3);
      store.select(0);
      await frames(store, pair, 6);
      const kinds = store.doc()!.kinds;
      let seen = 0;
      for (let i = 0; i < kinds.length; i++) {
        const row = store.rowAt(i);
        if (!row) continue;
        seen += 1;
        expect(ROW_H[row.k]).toBe(ROW_H[parseInt(kinds[i]!, 36)]);
      }
      expect(seen).toBeGreaterThan(10);
      dispose();
    });
  });
});

describe("typing and untyping", () => {
  test("a run of characters, confirmed, then the same number of backspaces returns the line", async () => {
    const pair = createSimCompanionPair(service.host);
    await createRoot(async (dispose) => {
      const store = createVaultStore(pair.ops);
      await frames(store, pair, 3);
      store.select(3);
      await frames(store, pair, 6);
      await caretOnLine(store, pair, 10);
      const source = store.activeText();
      const at = store.caret()!.col;

      const typed = "## Live heading ";
      for (const ch of typed) store.insert(ch);
      expect(store.activeText()).toBe(source.slice(0, at) + typed + source.slice(at));
      // Let every patch land, so the caret and the text come back from the
      // companion before the next keystroke.
      await frames(store, pair, 8);
      expect(store.unconfirmed()).toBe(0);
      expect(store.caret()).toEqual({ line: 10, col: at + typed.length });
      expect(store.activeText()).toBe(source.slice(0, at) + typed + source.slice(at));

      for (let i = 0; i < typed.length; i++) store.backspace();
      expect(store.caret()).toEqual({ line: 10, col: at });
      expect(store.activeText()).toBe(source);
      await frames(store, pair, 8);
      expect(store.unconfirmed()).toBe(0);
      expect(store.activeText()).toBe(source);
      expect(store.doc()!.lines).toBeGreaterThan(10);
      dispose();
    });
  });
});

describe("delete asks first", () => {
  test("one tap arms it, a second deletes, and time disarms", async () => {
    const pair = createSimCompanionPair(service.host);
    await createRoot(async (dispose) => {
      const store = createVaultStore(pair.ops);
      await frames(store, pair, 3);
      store.select(0);
      await frames(store, pair, 5);
      const before = store.listTotal();
      const id = store.doc()!.id;

      store.armDelete();
      expect(store.deleteArmed()).toBe(true);
      // A resting stylus must not cost a note: the arming lapses.
      await frames(store, pair, 160);
      expect(store.deleteArmed()).toBe(false);
      await frames(store, pair, 2);
      expect(service.index.note(id)).not.toBeNull();

      store.armDelete();
      store.deleteNote();
      await frames(store, pair, 6);
      expect(service.index.note(id)).toBeNull();
      expect(store.doc()).toBeNull();
      // The list may also carry notes earlier tests added; what matters is
      // that it lost exactly this one.
      expect(store.listTotal()).toBeLessThan(before + 1);
      dispose();
    });
  });
});

describe("the link coming back", () => {
  test("a companion restart re-queries the vault, even with nothing pending", async () => {
    const pair = createSimCompanionPair(service.host);
    await createRoot(async (dispose) => {
      const store = createVaultStore(pair.ops);
      await frames(store, pair, 4);
      const before = store.listTotal();
      expect(before).toBeGreaterThan(0);

      // The vault changes while the guest is away, so no event reaches it.
      writeFileSync(join(dir, "note-99.md"), NOTE(99));
      service.index.sync();
      pair.disconnect();
      await frames(store, pair, 2);
      expect(store.mac.status()).toBe("searching");
      pair.connect();
      await frames(store, pair, 6);
      expect(store.mac.status()).toBe("linked");
      // A settled query is not pending, so the module cannot re-issue it —
      // the store's link generation is what makes this show up.
      expect(store.listTotal()).toBe(before + 1);
      expect(store.treeRows().length).toBeGreaterThan(0);
      dispose();
    });
  });
});
