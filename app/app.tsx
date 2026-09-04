// app/app.tsx — Pocket Vault on the 3DS: the note on the top screen, every
// control on the bottom one, and one companion link to the Mac that holds
// the vault. The store owns the conversation; Stage and Deck only draw and
// route touches.

import { AuxiliarySurface } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { Deck } from "./deck.tsx";
import { Stage } from "./stage.tsx";
import { createVaultStore } from "./store.ts";

export default function VaultApp() {
  const store = createVaultStore();
  onFrame((buttons) => store.frame(buttons));
  (globalThis as { __pocketVault?: unknown }).__pocketVault = store;
  return (
    <>
      <Stage store={store} />
      <AuxiliarySurface>
        <Deck store={store} />
      </AuxiliarySurface>
    </>
  );
}
