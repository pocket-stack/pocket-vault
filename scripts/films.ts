// bun run films [outDir=media] [--only <name>] — record both screens in the
// headless sim as GIFs. Every frame is kept and encoded at 30 fps, so a 60 Hz
// scene plays at half speed and the flings and settles are legible. Two
// ffmpeg passes share one palette per film; the same scene records to the
// same bytes.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { $ } from "bun";
import { buildSimBundles, DECK_APP, ensureVault, openPanel, STAGE_APP, type Panel } from "./sim-panel.ts";
import { ROOT } from "./paths.ts";

const argv = process.argv.slice(2);
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : undefined;
const outDir = resolve(ROOT, argv.find((arg, i) => !arg.startsWith("--") && argv[i - 1] !== "--only") ?? "media");
mkdirSync(outDir, { recursive: true });
const vaultDir = await ensureVault();
await buildSimBundles();

const FPS = 30;

interface Cut {
  name: string;
  app: string;
  width: number;
  height: number;
  play(panel: Panel): Promise<void>;
}

const CUTS: Cut[] = [
  {
    name: "stage-fling",
    app: STAGE_APP,
    width: 400,
    height: 240,
    async play(stage) {
      await stage.frames(8); // the list page arrives before a row can be selected
      stage.store.select(0);
      await stage.frames(12);
      stage.store.scroller.beginDrag();
      for (let i = 0; i < 6; i++) {
        stage.store.scroller.drag(28);
        await stage.frames(1);
      }
      stage.store.scroller.endDrag(2600);
      await stage.frames(96);
    },
  },
  {
    name: "deck-tour",
    app: DECK_APP,
    width: 320,
    height: 240,
    async play(deck) {
      await deck.frames(10);
      await deck.drag(160, 200, 120, 8); // scroll the list
      await deck.frames(30);
      await deck.tap(120, 116); // a note
      await deck.frames(12);
      await deck.tap(120, 36); // Read
      await deck.frames(16);
      await deck.drag(180, 190, 90, 10); // trackpad swipe
      await deck.frames(40);
      await deck.drag(20, 60, 150, 24); // scrub the minimap
      await deck.frames(24);
      await deck.tap(200, 36); // Outline
      await deck.frames(20);
      await deck.tap(120, 96); // a heading
      await deck.frames(24);
      await deck.tap(280, 36); // Edit
      await deck.frames(20);
      for (const [x, y] of [[54, 133], [86, 133], [118, 133]] as const) {
        await deck.tap(x, y);
        await deck.frames(6);
      }
      await deck.frames(20);
    },
  },
  {
    name: "stage-edit",
    app: STAGE_APP,
    width: 400,
    height: 240,
    async play(stage) {
      await stage.frames(8);
      stage.store.select(0);
      await stage.frames(12);
      stage.store.scroller.scrollTo(160);
      await stage.frames(24);
      stage.store.enterEdit();
      await stage.frames(14);
      for (const ch of "Typed on a 3DS, laid out on a Mac. ") {
        stage.store.type(ch);
        await stage.frames(3);
      }
      await stage.frames(12);
      for (let i = 0; i < 3; i++) {
        stage.store.moveCaret(0, 1);
        await stage.frames(10);
      }
      await stage.frames(20);
      stage.store.leaveEdit();
      await stage.frames(24);
    },
  },
];

function encodeGif(frames: Uint8Array[], width: number, height: number, path: string): void {
  const work = resolve(tmpdir(), `pocket-vault-film-${process.pid}`);
  mkdirSync(work, { recursive: true });
  const raw = resolve(work, "frames.rgba");
  const merged = new Uint8Array(frames.length * width * height * 4);
  frames.forEach((frame, i) => merged.set(frame, i * width * height * 4));
  writeFileSync(raw, merged);
  const input = ["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(FPS), "-i", raw];
  const palette = resolve(work, "palette.png");
  Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", ...input, "-vf", "palettegen=max_colors=128:stats_mode=full", palette]);
  const result = Bun.spawnSync([
    "ffmpeg", "-y", "-loglevel", "error", ...input, "-i", palette,
    "-lavfi", "paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle", "-loop", "0", path,
  ]);
  rmSync(work, { recursive: true, force: true });
  if (result.exitCode !== 0) throw new Error(`ffmpeg failed for ${path}: ${result.stderr.toString()}`);
}

for (const cut of CUTS) {
  if (only && cut.name !== only) continue;
  const panel = await openPanel(cut.app, cut.width, cut.height, vaultDir);
  const frames: Uint8Array[] = [];
  panel.record(frames);
  await cut.play(panel);
  panel.record(null);
  panel.close();
  const path = resolve(outDir, `${cut.name}.gif`);
  encodeGif(frames, cut.width, cut.height, path);
  console.log(`pocket-vault: ${path} (${frames.length} frames, ${(Bun.file(path).size / 1024).toFixed(0)} KiB)`);
}
void $;
