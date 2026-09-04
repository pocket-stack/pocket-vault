#!/usr/bin/env bun
// Writes a deterministic Obsidian-style vault: N markdown notes, each at least
// MIN_BYTES, cross-linked with [[wikilinks]]. Same seed → same bytes, so the
// index the companion builds is reproducible too.
//
//   bun scripts/corpus.ts [dir=vault] [count=1000] [minKiB=100]

import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "vault";
/** The vault's shape, so the folder tree, the tags and the backlinks have
 *  something real to show. */
const FOLDERS = ["00 Inbox", "01 Projects", "01 Projects/PocketJS", "02 Areas", "03 Resources", "Templates"];
const count = Number(process.argv[3] ?? 1000);
const minBytes = Number(process.argv[4] ?? 100) * 1024;

let seed = 0x9e3779b9;
const rnd = (): number => {
  // xorshift32
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x1_0000_0000;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));

const TOPICS = ["retained tree", "damage rectangles", "glyph atlas", "tick loop", "virtual list", "kinetic scroll",
  "taffy layout", "QuickJS", "svc wire", "companion daemon", "line breaking", "sqlite index", "wifi latency",
  "baked tailwind", "frame budget", "touch bias", "chord map", "minimap", "top screen", "bottom screen",
  "PICA200", "GLES1", "usbmux", "beacon", "record framing", "backpressure", "stale query", "prefix sum",
  "row heights", "caret", "wikilink", "front matter", "outline", "full-text search", "debounce", "fsync",
  "hot push", "golden frame", "determinism", "simulation hz", "effect shell", "arena", "ephemeron", "memo",
  "signal", "resource", "renderer", "raster", "dither", "palette", "landscape", "density", "hit region"];
const VERBS = ["measures", "keeps", "drops", "frames", "streams", "indexes", "breaks", "pins", "echoes",
  "coalesces", "schedules", "bounds", "reuses", "advances", "settles", "rejects", "admits", "records", "replays",
  "batches", "drains", "paints", "wraps", "hands off", "resolves"];
const NOUNS = ["the guest", "the host", "the companion", "the device", "the daemon", "the wire", "the tick",
  "a record", "a window of rows", "the caret", "the atlas", "the corpus", "the vault", "the index", "a query",
  "the reply", "the ring buffer", "the inbox", "the budget", "the outline", "the minimap", "the fling",
  "the top screen", "the bottom screen", "the d-pad", "the shoulder button", "a chord", "the keyboard"];
const TAILS = ["so the main thread never waits.", "before the next frame is due.", "within one tick.",
  "and the result lands on a later tick.", "which is why the layout lives on the desktop.",
  "with the row heights sent as a prefix sum.", "at 60 Hz on the console and 30 Hz on the film.",
  "without touching the file on the device.", "because the wire carries lines, not pixels.",
  "so a stale reply is dropped on arrival.", "and every byte of it is bounded per frame.",
  "which the sim reproduces byte for byte.", "under the 16 KiB record ceiling.", "as the contacts demo already does."];
const LANGS = ["ts", "c", "rust", "sh", "json"];
const CODE: Record<string, string[]> = {
  ts: ["const page = createQuery(link, () => [\"doc.rows\", { id: doc(), from: first(), count: 60 }]);",
    "for (const rec of inbox.drain(BUDGET)) apply(rec);", "export function prefixSum(h: Uint8Array): Uint32Array {",
    "  const out = new Uint32Array(h.length + 1);", "  for (let i = 0; i < h.length; i++) out[i + 1] = out[i] + h[i];",
    "  return out;", "}", "link.send(\"doc.edit\", { id, row, col, insert: ch });"],
  c: ["static u32 svc_poll(u8 *dst, u32 cap) {", "  u32 n = ring_read(&rx, dst, cap);", "  return n;", "}",
    "if (len > POCKET_SVC_MAX_RECORD) return -1;"],
  rust: ["let rows = heights.iter().map(|h| *h as u32).scan(0, |acc, h| { *acc += h; Some(*acc) });",
    "fn budget(&self) -> usize { self.bytes_per_tick.min(self.inbox.len()) }"],
  sh: ["bun run companion --vault ./vault --beacon", "bun tools/3ds-dev.ts dev --host 172.20.11.51 --app vault"],
  json: ["{ \"t\": \"rows\", \"id\": 412, \"from\": 1200, \"rows\": [\"# Heading\", \"plain text\"] }"],
};

function sentence(): string {
  const s = `${cap(pick(NOUNS))} ${pick(VERBS)} ${pick(NOUNS)} ${pick(TAILS)}`;
  const r = rnd();
  if (r < 0.08) return s.replace(pick(NOUNS), (m) => `**${m}**`);
  if (r < 0.14) return s.replace(pick(NOUNS), (m) => `_${m}_`);
  if (r < 0.2) return s.replace(pick(NOUNS), (m) => `\`${m.replace(/ /g, "_")}\``);
  return s;
}
const cap = (s: string): string => s[0]!.toUpperCase() + s.slice(1);
function paragraph(): string {
  const n = int(3, 9);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(sentence());
  if (rnd() < 0.3) out.push(`See [[${slug(pick(TOPICS))}-${int(1, count)}]].`);
  return out.join(" ");
}
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
function block(depth: number): string {
  const r = rnd();
  if (r < 0.5) return paragraph();
  if (r < 0.62) return Array.from({ length: int(3, 7) }, () => `- ${sentence()}`).join("\n");
  if (r < 0.7) return Array.from({ length: int(3, 6) }, (_, i) => `${i + 1}. ${sentence()}`).join("\n");
  if (r < 0.78) { const l = pick(LANGS); return "```" + l + "\n" + CODE[l]!.slice(0, int(2, CODE[l]!.length)).join("\n") + "\n```"; }
  if (r < 0.85) return `> ${sentence()}\n> ${sentence()}`;
  if (r < 0.9) return `| topic | verb | tail |\n|---|---|---|\n` + Array.from({ length: int(2, 5) }, () => `| ${pick(TOPICS)} | ${pick(VERBS)} | ${pick(TAILS).replace(/\.$/, "")} |`).join("\n");
  if (depth < 3) return `${"#".repeat(depth + 2)} ${cap(pick(TOPICS))} ${pick(["notes", "in practice", "on the wire", "at 60 Hz", "revisited"])}\n\n${paragraph()}`;
  return paragraph();
}

mkdirSync(dir, { recursive: true });
for (const folder of FOLDERS) mkdirSync(join(dir, folder), { recursive: true });
if (readdirSync(dir).filter((entry) => entry.endsWith(".md")).length > 0 && !process.argv.includes("--force")) {
  console.error(`${dir} is not empty; pass --force to overwrite`);
  process.exit(1);
}
let total = 0;
for (let i = 1; i <= count; i++) {
  const title = `${cap(pick(TOPICS))} ${pick(["field notes", "design record", "runbook", "postmortem", "sketch", "questions", "ledger"])} ${i}`;
  const parts: string[] = [
    `---\ntitle: ${title}\ntags: [${pick(TOPICS).split(" ")[0]}, ${pick(TOPICS).split(" ")[0]}]\ncreated: 2026-${String(int(1, 9)).padStart(2, "0")}-${String(int(1, 28)).padStart(2, "0")}\n---`,
    `# ${title}`,
    paragraph(),
    `> Focus: ${sentence()}`,
    `> ${sentence()}`,
    "",
    `- [${rnd() < 0.5 ? "x" : " "}] ${sentence()}`,
    `- [ ] ${sentence()}`,
    `See also [[${slug(pick(TOPICS))}-${int(1, count)}]] and #${pick(TOPICS).split(" ")[0]}.`,
  ];
  let bytes = parts.join("\n\n").length;
  let section = 0;
  while (bytes < minBytes + int(0, 60 * 1024)) {
    section += 1;
    parts.push(`## ${section}. ${cap(pick(TOPICS))}`);
    const n = int(2, 6);
    for (let b = 0; b < n; b++) parts.push(block(int(0, 2)));
    bytes = parts.reduce((a, p) => a + p.length + 2, 0);
  }
  const body = parts.join("\n\n") + "\n";
  const folder = i % 7 === 0 ? "" : FOLDERS[i % FOLDERS.length]!;
  writeFileSync(join(dir, folder, `${slug(title)}.md`), body);
  total += body.length;
}
console.log(`${count} notes, ${(total / 1024 / 1024).toFixed(1)} MiB in ${dir}`);
