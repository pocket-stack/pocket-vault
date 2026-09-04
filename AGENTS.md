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
bun run companion -- --unicast <ip> [--unicast <ip2>]   # the Mac side
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
- **Every source line is one block, and every marker stays on screen.** That
  totality — every source character has a screen position — is what lets the
  caret sit on a styled row and lets the guest read a cached line back
  exactly (`app/rowmap.ts`). Anything that hides source characters must add
  a substitution run carrying `srcText`, or the mapping stops being total and
  the editor stops working. There is no raw mode; a line looks the same
  whether or not the caret is in it.
- **The wrapper is ONE file, shared** (`app/linewrap.ts` over
  `app/markdown.ts`). The companion and the guest both run it; a second copy
  would drift and every local edit would flicker. `test/layout.test.ts`
  asserts the two agree row for row.
- **The guest owns the caret line.** Keystrokes, splits and joins apply to
  its local text and re-wrap immediately; the request follows. When the patch
  for an edit the guest already applied arrives, the guest adopts the
  companion's rows **per line** (`adoptLineRows`) — never the span's
  `removed` count, which is in the companion's pre-edit coordinates and would
  double-count. A whole re-layout arriving mid-flight (a fence or the front
  matter reclassified) drops the guest's claim to its own rows until the
  queue drains.
- **Edit sequence numbers are per GUEST session**, the number in the hello,
  not the transport session: a reconnect re-sends the in-flight edit over a
  new connection and the companion must recognise it.
- **Every colour, control shape and box is a token in `app/theme.ts`.** Add a
  token; do not write a hex literal or a magic offset in a component.
- **Text does not clip itself.** A `Text` with a width still paints past it;
  wrap it in a `T.CLIP` box or a long title bleeds over its neighbours.
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
- **Whitespace at a break is kept as a zero-width run.** Trimming it would
  break the mapping; painting it would overflow the column. Both edges of
  such a run sit at one x, so those columns are ambiguous by construction —
  the round-trip test exempts them and nothing else.
- **Headless tests need a measurer.** `setMeasurer` in `app/fonts.ts` takes
  the companion's Metrics when there is no host to measure with; the slot
  literals there are asserted against `fontSlotFor` so a re-pinned table
  fails the suite instead of mis-measuring.
- **A resync is a smell.** Set `__vaultTrace` to have the store log why one
  happened (`probe --eval 'globalThis.__vaultTrace = true'`).
- **The runtime on the card may predate the svc wire.** "no svc mailbox on
  this host" in the status strip means `ui.svcOpen` is missing; `bun run
  probe --host <ip> -- --eval 'typeof ui.svcOpen'` confirms it, and only a
  reflash fixes it.
- **Launching the `.3dsx` on a card that has run another Pocket app boots
  THAT app.** The runtime's package state (`sdmc:/pocketjs/runtime/state`,
  `packages/`) is global per card, so `startup_choice` loads the last
  globally active package — a console that last ran Pocket Term shows Pocket
  Term's UI under our binary. Two ways out: while ftpd is open, upload the
  package as `pocketjs/runtime/pending.pocket` (the runtime promotes it on
  the next boot), or just launch and `bun run push --host <ip>`, which
  installs it as a candidate and commits. Per-app runtime slots are upstream
  PR #355 and not in this pin.
- **`bun run push --host <ip>` wants a key named for that address.** Keys
  live in `.pocket/devices/<ip>-8131.key` (git-ignored) and are planted into
  the submodule before the tool runs. Discovery matches by device id and
  usually finds any key for the console, but when the UDP reply is missed
  the tool falls back to the address-named file and says "not paired" —
  copy the console's key to `<current-ip>-8131.key`. A console keeps its
  device id across networks, so a key from an old address still works —
  `3ds:dev discover` prints the id, and any key file with that id pairs.
- **A console on another subnet needs `--unicast`.** The beacon's broadcast
  does not cross subnets; pass every console's address (they can repeat).
- **The Info sheet counts requests.** `rows N · edits N · max pending N` and
  the last error; `probe --eval 'JSON.stringify(__pocketVault.stats())'`
  reads the same counters. A "64 requests already pending" there means some
  path is issuing faster than the link answers; the pager itself is capped
  at 8 in flight and 3 new per frame.
- **The shots use their own vault.** The edit scene writes into a note, so
  `bun run shots` generates a 60-note corpus in a scratch directory instead
  of touching `vault/`.
