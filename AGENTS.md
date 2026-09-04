# Working in this repository

Pocket Vault is a product built on PocketJS, which arrives as the
`vendor/pocketjs` submodule. Nothing in `vendor/` is edited here: a runtime
change lands in [pocket-stack/pocketjs](https://github.com/pocket-stack/pocketjs)
first, and this repository moves its pin.

## Conventions

- Publish a change as a **draft pull request** before treating it as ready,
  and name it with Conventional Commits — `feat(app): …`, `fix(host): …`.
- Import PocketJS runtime, host component, lifecycle, input and animation APIs
  from `@pocketjs/framework/*`; import Solid primitives and control flow from
  `solid-js`.
- Prose states the mechanism and the reason. No slogans, no imported
  architecture jargon, no empty intensifiers.
- `app/protocol.ts` is the one file both sides import. A wire change is made
  there and nowhere else.

## The loop

```sh
bun run check                        # typecheck + tests (guest ↔ companion over the sim pair)
bun run companion -- --unicast <ip>  # the Mac side
bun run push --host <console-ip>     # rebuild the guest, hot-push it (~20 s)
bun run probe --host <console-ip>    # status, stats, tree, screenshot of both screens
bun run shots                        # both screens from the sim → media/
bun run 3ds                          # the full .3dsx — needed for a reflash
```

`app/` and `host/` changes are hot pushes and daemon restarts. A change under
`vendor/pocketjs/hosts/3ds` is native: rebuild the `.3dsx`, copy it to
`/3ds/pocketvault-main.3dsx` over ftpd, relaunch. **ftpd cannot run while a
Pocket Runtime does** — one homebrew application at a time — so a reflash
needs the console back at the Homebrew Launcher.

## Things that have cost time

- **The guest never has the document.** It has a kinds string, a prefix sum,
  and a window of rows. Anything that needs the text — search, outline,
  measuring — is a companion method. A feature that seems to need the whole
  note on the console is a feature that needs a new method.
- **Every source line is one block, and the active line is raw.** That is
  what makes a caret (line, col) and lets an edit come back as a span. Do
  not merge lines into paragraphs on the companion; Obsidian does not.
- **Rows are fetched by page, and a page stays in flight while wanted.** A
  single "latest window" query starved during a fling: every page boundary
  crossed cancelled the request. Pages under the viewport now and under
  where the fling lands are both wanted.
- **The sim hosts one surface.** `pocket.sim-deck.json` and
  `pocket.sim-stage.json` build the deck and the stage as their own bundles;
  the deck's recognizers read `globalThis.__vaultDeckSurface` so the sim can
  mount it on the primary surface. Never assume a sim frame carries both.
- **A View's main axis is horizontal.** `items-center justify-center` on a
  column of text needs `flex-col`, or the texts line up side by side and
  overflow.
- **A `class` string must be a whole literal in the source.** The compiler
  collects class strings at build time; `runClass()` in `app/stage.tsx`
  branches by returning complete literals for that reason.
- **Replies settle through a Promise.** `mac.call().then(applyPatch)` runs as
  a microtask; a headless test must `await` between frames or the patch
  never applies.
- **A raw row keeps its trailing spaces.** The wrapper trims trailing
  whitespace on every row but the raw one, where each source character is a
  caret position.
- **The runtime on the card may predate the svc wire.** "no svc mailbox on
  this host" in the status strip means `ui.svcOpen` is missing; `bun run
  probe --host <ip> -- --eval 'typeof ui.svcOpen'` confirms it, and only a
  reflash fixes it.
- **The shots use their own vault.** The edit scene writes into a note, so
  `bun run shots` generates a 60-note corpus in a scratch directory instead
  of touching `vault/`.
