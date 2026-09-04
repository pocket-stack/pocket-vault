// The guest store against the real companion service, in one process, over
// the sim pair — no renderer, no sockets, no device. A frame here is: the
// store's frame(), one pump (requests go out), a transport tick (replies
// become visible), one pump (replies land). What is asserted is the shape of
// the conversation: a list page, a document summary, a window of rows that
// follows a fling, and an edit that comes back as a span and reaches the
// file on disk.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoot } from "solid-js";
import { createSimCompanionPair, type SimCompanionPair } from "../vendor/pocketjs/hosts/sim/companion.ts";
import { K_RAW, ROW_H, rowTops } from "../app/protocol.ts";
import { createVaultStore, type VaultStore } from "../app/store.ts";
import { setRawMeasurer } from "../app/wrap.ts";
import { createVaultService } from "../host/serve.ts";

let dir = "";
let service: ReturnType<typeof createVaultService>;

const NOTE = (n: number): string =>
  `---\ntitle: Note ${String(n).padStart(2, "0")}\n---\n\n# Note ${n}\n\n` +
  Array.from({ length: 40 }, (_, i) => `Paragraph ${i} of note ${n}: ${"the quick brown fox jumps over the lazy dog ".repeat(3)}`).join("\n\n") +
  "\n\n- first **bold** item\n- second item with \`code\`\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pocket-vault-"));
  for (let n = 1; n <= 12; n++) writeFileSync(join(dir, `note-${n}.md`), NOTE(n));
  service = createVaultService({ vault: dir, memory: true, log: () => {} });
  // No host in a headless test: the guest's raw wrap measures with the
  // companion's Metrics, the same Inter advances the atlas was baked from.
  setRawMeasurer((text) => service.metrics.width(text, "regular", 14));
});

afterAll(() => {
  service.close();
  rmSync(dir, { recursive: true, force: true });
});

/** One frame: requests out, transport tick, replies in, then the microtask
 *  queue — call() settles through a Promise, as it does on the console
 *  where the host drains jobs after the frame callback. */
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

describe("Pocket Vault guest ↔ companion", () => {
  test("lists, opens, scrolls and edits a note without ever reading a file on the guest", async () => {
    const pair = createSimCompanionPair(service.host);
    await createRoot(async (dispose) => {
      const store = createVaultStore(pair.ops);
      await frames(store, pair, 2);
      expect(store.mac.status()).toBe("linked");
      expect(store.listTotal()).toBe(12);
      expect(store.listItem(0)?.title).toBe("Note 01");
      expect(store.listItem(11)?.title).toBe("Note 12");

      store.select(2);
      await frames(store, pair, 2);
      const doc = store.doc()!;
      expect(doc.title).toBe("Note 03");
      expect(doc.rows).toBeGreaterThan(80);
      expect(doc.kinds.length).toBe(doc.rows);
      expect(store.rowAt(0)?.r[0]?.[1]).toBe("---");
      const tops = rowTops(doc.kinds);
      expect(tops[tops.length - 1]).toBe(store.docHeight());

      // A fling: rows keep arriving for where the viewport is heading.
      store.scroller.beginDrag();
      store.scroller.drag(120);
      store.scroller.endDrag(2400);
      await frames(store, pair, 40);
      expect(store.scroller.offset()).toBeGreaterThan(400);
      const [first, last] = store.visibleRange();
      let cached = 0;
      for (let i = first; i <= last; i++) if (store.rowAt(i)) cached += 1;
      expect(cached).toBe(last - first + 1);

      // Edit mode: the first visible line comes back raw with a caret on it.
      store.enterEdit();
      await frames(store, pair, 2);
      expect(store.mode()).toBe("edit");
      const caret = store.caret()!;
      expect(caret.col).toBe(0);
      const before = readFileSync(join(dir, "note-3.md"), "utf8").split("\n")[caret.line];
      expect(store.activeText()).toBe(before);

      // Local first: the text and the caret move on the keystroke, before
      // any reply; the companion confirms afterwards.
      store.insert("Q");
      store.insert("Z");
      expect(store.activeText()).toBe(`QZ${before}`);
      expect(store.caret()).toEqual({ line: caret.line, col: 2 });
      expect(store.unconfirmed()).toBeGreaterThan(0);
      const rawRows = () => {
        const out: string[] = [];
        for (let i = 0; i < store.doc()!.rows; i++) {
          const row = store.rowAt(i);
          if (row && row.l === caret.line && row.k === K_RAW) out.push(row.r.map((run) => run[1]).join(""));
        }
        return out.join("");
      };
      expect(rawRows().startsWith("QZ")).toBe(true);
      await frames(store, pair, 3);
      expect(store.unconfirmed()).toBe(0);
      expect(store.activeText()).toBe(`QZ${before}`);
      store.backspace();
      await frames(store, pair, 3);
      expect(store.activeText()).toBe(`Q${before}`);
      expect(store.doc()!.rev).toBeGreaterThan(doc.rev);

      // Every row height still matches the kinds string the patches spliced.
      const kinds = store.doc()!.kinds;
      let sawRaw = false;
      for (let i = 0; i < kinds.length; i++) {
        const row = store.rowAt(i);
        if (!row) continue;
        expect(ROW_H[row.k]).toBe(ROW_H[parseInt(kinds[i]!, 36)]);
        if (row.k === K_RAW) sawRaw = true;
      }
      expect(sawRaw).toBe(true);

      // Offline: keystrokes keep landing locally; on reconnect the queue
      // drains once and the file agrees.
      pair.disconnect();
      await frames(store, pair, 2);
      expect(store.mac.status()).toBe("searching");
      store.insert("!");
      store.insert("!");
      expect(store.activeText()).toBe(`Q!!${before}`);
      await frames(store, pair, 2);
      expect(store.activeText()).toBe(`Q!!${before}`);
      pair.connect();
      await frames(store, pair, 4);
      expect(store.mac.status()).toBe("linked");
      expect(store.unconfirmed()).toBe(0);

      // A structural edit waits for its patch; a keystroke typed meanwhile
      // is replayed after it.
      store.insert("\n");
      store.insert("R");
      await frames(store, pair, 4);
      expect(store.caret()).toEqual({ line: caret.line + 1, col: 1 });
      expect(store.activeText()).toBe(`R${before}`);

      // Select back over the R with the anchor and delete it.
      store.setSelecting(true);
      store.moveCaret(-1, 0);
      expect(store.selection()).toEqual({ anchor: { line: caret.line + 1, col: 1 }, head: { line: caret.line + 1, col: 0 } });
      store.backspace();
      expect(store.activeText()).toBe(before);
      store.setSelecting(false);
      await frames(store, pair, 3);

      store.leaveEdit();
      await frames(store, pair, 2);
      expect(store.mode()).toBe("read");
      service.flush();
      const lines = readFileSync(join(dir, "note-3.md"), "utf8").split("\n");
      expect(lines[caret.line]).toBe("Q!!");
      expect(lines[caret.line + 1]).toBe(before);
      dispose();
    });
  });

  test("search narrows the list and a foreign change on disk bumps the version", async () => {
    const pair = createSimCompanionPair(service.host);
    await createRoot(async (dispose) => {
      const store = createVaultStore(pair.ops);
      await frames(store, pair, 2);
      store.setQuery("Note 07");
      await frames(store, pair, 2);
      expect(store.listTotal()).toBe(1);
      expect(store.listItem(0)?.title).toBe("Note 07");
      store.setQuery("");
      await frames(store, pair, 2);
      expect(store.listTotal()).toBe(12);

      writeFileSync(join(dir, "note-13.md"), NOTE(13));
      service.index.sync();
      service.host.publish("vault.changed", { version: service.index.currentVersion() });
      await frames(store, pair, 3);
      expect(store.listTotal()).toBe(13);
      dispose();
    });
  });
});
