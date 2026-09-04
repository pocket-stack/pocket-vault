// bun run guest [manifest.json …] — build guest bundles (dist/<output>.js +
// .pak inside the submodule's dist), which is what the headless sim and the
// tests load. Default: pocket.json. `bun run push` builds the .pocket package
// on top of it.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";
import { resolve3dsBuildPlan } from "../vendor/pocketjs/tools/3ds-profile.ts";
import { passThrough } from "./run.ts";
import { PLAN_DIR, ROOT, VENDOR } from "./paths.ts";

export async function buildGuest(manifestPath: string): Promise<string> {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, manifestPath), "utf8"));
  const plan = resolve3dsBuildPlan(manifest);
  mkdirSync(PLAN_DIR, { recursive: true });
  const planPath = resolve(PLAN_DIR, `${plan.app.output}.3ds.plan.json`);
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  await passThrough(
    $`bun tools/build.ts --plan=${planPath} --project-root=${ROOT} --outdir=${VENDOR}/dist`.cwd(VENDOR).quiet(),
  );
  return plan.app.output;
}

if (import.meta.main) {
  const manifests = process.argv.slice(2);
  for (const manifest of manifests.length > 0 ? manifests : ["pocket.json"]) {
    console.log(`pocket-vault: built ${await buildGuest(manifest)}`);
  }
}
