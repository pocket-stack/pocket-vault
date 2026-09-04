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
  await deck.frames(8);
  deck.store.toggleFolder("01 Projects");
  await deck.frames(8);
  shot(deck, "deck-files");

  await deck.tap(200, 120); // a note in the right pane
  await deck.frames(12);
  shot(deck, "deck-open");

  await deck.tap(205, 15); // the Links segment
  await deck.frames(12);
  shot(deck, "deck-links");

  await deck.tap(293, 15); // the Tags segment
  await deck.frames(10);
  shot(deck, "deck-tags");

  await deck.tap(120, 15); // back to Files
  await deck.frames(8);
  await deck.drag(309, 60, 150, 12); // scrub the document from the strip
  await deck.frames(10);
  shot(deck, "deck-scrub");

  deck.store.openMenu("vault");
  await deck.frames(6);
  shot(deck, "deck-menu");
  deck.store.closeMenu();
  await deck.frames(4);

  deck.store.enterEdit();
  await deck.frames(10);
  for (const [x, y] of [[36, 60], [67, 60], [98, 60]] as const) {
    await deck.tap(x, y);
    await deck.frames(4);
  }
  shot(deck, "deck-edit");
  await deck.tap(288, 120); // Select
  await deck.frames(6);
  shot(deck, "deck-edit-select");
  deck.store.leaveEdit();
  await deck.frames(6);

  await deck.tap(295, 15); // the magnifier
  await deck.frames(8);
  for (const ch of "taffy") {
    deck.store.setQuery(deck.store.query() + ch);
    await deck.frames(3);
  }
  await deck.frames(8);
  shot(deck, "deck-search");
  deck.close();
}

// ── stage ─────────────────────────────────────────────────────────────────
{
  const stage = await openPanel(STAGE_APP, 400, 240, vaultDir);
  await stage.frames(8);
  shot(stage, "stage-splash");
  stage.store.select(0);
  await stage.frames(14);
  shot(stage, "stage-doc");

  stage.store.scroller.scrollTo(340, { immediate: true });
  await stage.frames(12);
  shot(stage, "stage-blocks");

  stage.store.scroller.beginDrag();
  stage.store.scroller.drag(60);
  stage.store.scroller.endDrag(1800);
  await stage.frames(12);
  shot(stage, "stage-fling");
  await stage.frames(60);

  stage.store.openMenu("actions");
  await stage.frames(6);
  shot(stage, "stage-menu");
  stage.store.closeMenu();
  await stage.frames(4);

  stage.store.scroller.scrollTo(150, { immediate: true });
  await stage.frames(10);
  stage.store.enterEdit();
  await stage.frames(8);
  for (const ch of "Typed on a 3DS. ") {
    stage.store.insert(ch);
    await stage.frames(2);
  }
  await stage.frames(8);
  shot(stage, "stage-edit");
  stage.store.setSelecting(true);
  for (let i = 0; i < 10; i++) stage.store.moveCaret(-1, 0);
  await stage.frames(4);
  shot(stage, "stage-select");
  stage.store.setSelecting(false);
  stage.store.leaveEdit();
  await stage.frames(6);
  stage.close();
}
