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
      const raw = store.activeLineText();
      const before = readFileSync(join(dir, "note-3.md"), "utf8").split("\n")[caret.line];
      expect(raw).toBe(before);

      store.type("Q");
      store.type("Z");
      await frames(store, pair, 2);
      expect(store.caret()).toEqual({ line: caret.line, col: 2 });
      expect(store.activeLineText()).toBe(`QZ${before}`);
      store.backspace();
      await frames(store, pair, 2);
      expect(store.activeLineText()).toBe(`Q${before}`);
      expect(store.doc()!.rev).toBeGreaterThan(doc.rev);

      // The raw row is one of the cached rows and every row height still
      // matches the kinds string the patches spliced.
      const kinds = store.doc()!.kinds;
      let sawRaw = false;
      for (let i = 0; i < kinds.length; i++) {
        const row = store.rowAt(i);
        if (!row) continue;
        expect(ROW_H[row.k]).toBe(ROW_H[parseInt(kinds[i]!, 36)]);
        if (row.k === K_RAW) sawRaw = true;
      }
      expect(sawRaw).toBe(true);

      store.leaveEdit();
      await frames(store, pair, 2);
      expect(store.mode()).toBe("read");
      service.flush();
      const after = readFileSync(join(dir, "note-3.md"), "utf8").split("\n")[caret.line];
      expect(after).toBe(`Q${before}`);
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
