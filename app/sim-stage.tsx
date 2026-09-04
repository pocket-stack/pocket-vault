// @title Pocket Vault stage (sim)
// The top screen alone, for the headless sim. The harness drives the store
// through globalThis.__pocketVault (open a note, scroll, edit).
import { mount } from "@pocketjs/framework/solid";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { Stage } from "./stage.tsx";
import { createVaultStore } from "./store.ts";
import type { CompanionOps } from "@pocketjs/framework/companion";

mount(() => {
  const store = createVaultStore((globalThis as { __vaultOps?: CompanionOps }).__vaultOps ?? null);
  onFrame((buttons) => store.frame(buttons));
  (globalThis as { __pocketVault?: unknown }).__pocketVault = store;
  return <Stage store={store} />;
});
