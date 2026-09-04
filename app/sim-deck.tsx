// @title Pocket Vault deck (sim)
// The bottom screen alone, on the primary surface, for the headless sim —
// which hosts one surface at a time. The companion is whatever the harness
// put at globalThis.__vaultOps (the in-process sim pair).
import { mount } from "@pocketjs/framework/solid";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { Deck } from "./deck.tsx";
import { createVaultStore } from "./store.ts";
import type { CompanionOps } from "@pocketjs/framework/companion";

mount(() => {
  const store = createVaultStore((globalThis as { __vaultOps?: CompanionOps }).__vaultOps ?? null);
  onFrame((buttons) => store.frame(buttons));
  (globalThis as { __pocketVault?: unknown }).__pocketVault = store;
  return <Deck store={store} />;
});
