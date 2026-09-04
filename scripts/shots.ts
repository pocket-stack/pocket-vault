// bun run shots [outDir=media] — photograph both screens in the headless
// sim, against the real companion service in this process. Touches are
// injected the way the console delivers them; the store is driven directly
// where a touch would only be theatre.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { buildSimBundles, DECK_APP, ensureVault, openPanel, STAGE_APP, type Panel } from "./sim-panel.ts";
import { ROOT } from "./paths.ts";

const outDir = resolve(ROOT, process.argv[2] ?? "media");
mkdirSync(outDir, { recursive: true });
const vaultDir = await ensureVault();
await buildSimBundles();

const shot = (panel: Panel, name: string): void => {
  const path = resolve(outDir, `${name}.png`);
  writeFileSync(path, encodePNG(panel.render(), panel.width, panel.height));
  console.log(`pocket-vault: ${path}`);
};

// ── deck ──────────────────────────────────────────────────────────────────
{
  const deck = await openPanel(DECK_APP, 320, 240, vaultDir);
  await deck.frames(6);
  shot(deck, "deck-files");

  await deck.tap(160, 76); // the search box
  await deck.frames(2);
  for (const ch of "taffy") {
    deck.store.setQuery(deck.store.query() + ch);
    await deck.frames(2);
  }
  await deck.frames(4);
  shot(deck, "deck-search");
  deck.store.setMode("files");
  deck.store.setQuery("");
  await deck.frames(4);

  await deck.tap(120, 106); // first note in the list
  await deck.frames(8);
  deck.store.setMode("read");
  await deck.frames(8);
  shot(deck, "deck-read");

  await deck.drag(180, 200, 80, 12); // a swipe up on the trackpad
  await deck.frames(20);
  shot(deck, "deck-read-flung");

  await deck.tap(205, 47); // the Outline segment
  await deck.frames(8);
  shot(deck, "deck-outline");

  await deck.tap(285, 47); // the Edit segment
  await deck.frames(8);
  shot(deck, "deck-edit");
  await deck.tap(283, 181); // Select
  await deck.frames(4);
  shot(deck, "deck-edit-select");
  await deck.tap(295, 16); // Info
  await deck.frames(4);
  shot(deck, "deck-sheet");
  deck.close();
}

// ── stage ─────────────────────────────────────────────────────────────────
{
  const stage = await openPanel(STAGE_APP, 400, 240, vaultDir);
  await stage.frames(6);
  shot(stage, "stage-splash");
  stage.store.select(0);
  await stage.frames(10);
  shot(stage, "stage-doc");

  stage.store.scroller.scrollTo(1400, { immediate: true });
  await stage.frames(10);
  shot(stage, "stage-scrolled");

  stage.store.scroller.beginDrag();
  stage.store.scroller.drag(60);
  stage.store.scroller.endDrag(1800);
  await stage.frames(12);
  shot(stage, "stage-fling");
  await stage.frames(60);

  stage.store.enterEdit();
  await stage.frames(6);
  for (const ch of "Hello from the 3DS. ") {
    stage.store.insert(ch);
    await stage.frames(2);
  }
  await stage.frames(6);
  shot(stage, "stage-edit");
  stage.store.setSelecting(true);
  for (let i = 0; i < 12; i++) stage.store.moveCaret(-1, 0);
  await stage.frames(4);
  shot(stage, "stage-select");
  stage.store.setSelecting(false);
  stage.store.leaveEdit();
  await stage.frames(6);
  stage.close();
}
