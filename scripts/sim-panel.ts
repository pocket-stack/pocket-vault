// scripts/sim-panel.ts — one screen of Pocket Vault in PocketJS's headless
// sim, wired to the real companion service in this process through the sim
// pair. shots.ts photographs it; films.ts records it frame by frame. The sim
// hosts one surface at a time, so the deck and the stage are separate
// bundles (pocket.sim-deck.json, pocket.sim-stage.json) mounted on the
// primary surface; the deck's recognizers follow `__vaultDeckSurface`.

import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { $ } from "bun";
import { createSimCompanionPair } from "../vendor/pocketjs/hosts/sim/companion.ts";
import { createVaultService } from "../host/serve.ts";
import type { VaultStore } from "../app/store.ts";
import { buildGuest } from "./guest.ts";
import { ROOT } from "./paths.ts";

export const DECK_APP = "pocketvault-deck";
export const STAGE_APP = "pocketvault-stage";

/** The vault the sim renders. The edit scenes write into a note, so this is
 *  a deterministic 60-note corpus in a scratch directory unless POCKET_VAULT
 *  names one. */
export async function ensureVault(): Promise<string> {
  const dir = process.env.POCKET_VAULT
    ? resolve(ROOT, process.env.POCKET_VAULT)
    : resolve(tmpdir(), "pocket-vault-shots");
  if (!existsSync(dir) || !existsSync(resolve(dir, "arena-design-record-152.md"))) {
    rmSync(dir, { recursive: true, force: true });
    await $`bun ${ROOT}/scripts/corpus.ts ${dir} 60 100`.quiet();
  }
  return dir;
}

export async function buildSimBundles(): Promise<void> {
  await buildGuest("pocket.sim-deck.json");
  await buildGuest("pocket.sim-stage.json");
}

export interface Panel {
  readonly width: number;
  readonly height: number;
  readonly store: VaultStore;
  /** Run n frames with the given contacts held; replies land one frame after
   *  they are asked for, as on the console. */
  frames(n: number, touches?: number[]): Promise<void>;
  tap(x: number, y: number): Promise<void>;
  /** A finger travelling from y0 to y1 at x over `steps` frames, released. */
  drag(x: number, y0: number, y1: number, steps: number): Promise<void>;
  /** The current frame's pixels (a copy — the sim reuses its buffer). */
  render(): Uint8Array;
  /** Frames recorded while `sink` is set: every frame() appends a copy. */
  record(sink: Uint8Array[] | null): void;
  close(): void;
}

export const pack = (x: number, y: number, id = 0): number => (id << 18) | (y << 9) | x;

export async function openPanel(app: string, width: number, height: number, vaultDir: string): Promise<Panel> {
  const service = createVaultService({ vault: vaultDir, memory: true, log: () => {} });
  const pair = createSimCompanionPair(service.host);
  const { bootWorld } = await import("../vendor/pocketjs/hosts/sim/sim.ts");
  const world = await bootWorld(
    app,
    60,
    { __vaultOps: pair.ops, __vaultDeckSurface: "primary" },
    undefined,
    { width, height },
  );
  const store = (globalThis as { __pocketVault?: VaultStore }).__pocketVault;
  if (!store) throw new Error(`${app} did not publish its store`);
  let sink: Uint8Array[] | null = null;
  const frames = async (n: number, touches: number[] = []): Promise<void> => {
    for (let i = 0; i < n; i++) {
      world.frame(0, undefined, touches);
      pair.tick();
      await Promise.resolve();
      await Promise.resolve();
      if (sink) sink.push(Uint8Array.from(world.render()));
    }
  };
  return {
    width,
    height,
    store,
    frames,
    tap: async (x, y) => {
      await frames(2, [pack(x, y)]);
      await frames(1);
    },
    drag: async (x, y0, y1, steps) => {
      for (let i = 0; i <= steps; i++) {
        const y = Math.round(y0 + ((y1 - y0) * i) / steps);
        await frames(1, [pack(x, y)]);
      }
      await frames(1);
    },
    render: () => Uint8Array.from(world.render()),
    record: (next) => {
      sink = next;
    },
    close: () => service.close(),
  };
}
