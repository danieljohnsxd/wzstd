/**
 * Decode A/B against cached frames.
 *
 * Builds own-Fast / own-Strong / `--fast=8` / lvl3 once under
 * `bench-data/decode-cache/` and times `dist/` against that blob. Isolated
 * children — rebuild between variants. No zrip, no level 19.
 *
 *   pnpm bench:ab-decode --silesia-only
 *   pnpm bench:ab-decode --rebuild-cache
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compressFast } from "../dist/compressFast.js";
import { compressStrong } from "../dist/compressStrong.js";
import { hasZstdCli, zstdCompress } from "../tests/helpers/zstd_cli.ts";
import { MAIN_CORPUS_NOTE, selectCorpora } from "./helpers/corpora.ts";
import { createIsolate, num } from "./helpers/isolate.ts";

const CACHE = join("bench-data", "decode-cache");
const { corpora, values } = selectCorpora({
  "rebuild-cache": { type: "boolean", default: false },
});
const REBUILD = values["rebuild-cache"] === true;

type Shape = "own-Fast" | "own-Strong" | "fast8" | "lvl3";

const cli = hasZstdCli();
if (!cli) console.log("(host zstd CLI absent — fast8 / lvl3 columns skipped)");

mkdirSync(CACHE, { recursive: true });

const median = (v: Array<number>): number => {
  // oxlint-disable-next-line unicorn/no-array-sort -- filter() already copied
  const s = v.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s[s.length >> 1] ?? Number.NaN;
};

const cacheName = (corpus: string, name: string, shape: Shape): string =>
  `${corpus}__${name}__${shape}.zst`.replaceAll("/", "_");

const loadOrBuild = (
  corpus: string,
  name: string,
  shape: Shape,
  build: () => Uint8Array,
): Uint8Array => {
  const path = join(CACHE, cacheName(corpus, name, shape));
  if (!REBUILD && existsSync(path)) return new Uint8Array(readFileSync(path));
  const frame = build();
  writeFileSync(path, frame);
  return frame;
};

type Item = {
  corpus: string;
  name: string;
  shape: Shape;
  bytes: number;
  data: Uint8Array;
};

const items: Array<Item> = [];
for (const c of corpora) {
  for (const p of c.payloads) {
    if (p.data.length === 0) continue;
    const raw = p.data;
    items.push({
      corpus: c.id,
      name: p.name,
      shape: "own-Fast",
      bytes: raw.length,
      data: loadOrBuild(c.id, p.name, "own-Fast", () => compressFast(raw)),
    });
    items.push({
      corpus: c.id,
      name: p.name,
      shape: "own-Strong",
      bytes: raw.length,
      data: loadOrBuild(c.id, p.name, "own-Strong", () => compressStrong(raw)),
    });
    if (cli) {
      items.push({
        corpus: c.id,
        name: p.name,
        shape: "fast8",
        bytes: raw.length,
        data: loadOrBuild(c.id, p.name, "fast8", () => zstdCompress(raw, -8)),
      });
      items.push({
        corpus: c.id,
        name: p.name,
        shape: "lvl3",
        bytes: raw.length,
        data: loadOrBuild(c.id, p.name, "lvl3", () => zstdCompress(raw, 3)),
      });
    }
  }
}

if (items.length === 0) throw new Error("no frames to decode");
console.log(
  `decode A/B — ${items.length} cached frames under ${CACHE}` + (REBUILD ? " (rebuilt)" : ""),
);
if (corpora.every((c) => c.id !== "extra")) {
  console.log(`(${MAIN_CORPUS_NOTE})`);
}

const iso = createIsolate();
const staged = iso.stage(items.map((it) => ({ data: it.data, bytes: it.bytes })));
const ours = iso.measure("wzstd", staged);
const lvl3Idx = items.map((it, i) => (it.shape === "lvl3" ? i : -1)).filter((i) => i >= 0);
const fz = iso.measure("fzstd", staged, lvl3Idx);
if (iso.anyFailed()) process.exitCode = 1;
iso.dispose();

const fzByItem = new Map<number, number>();
for (let i = 0; i < lvl3Idx.length; i++) {
  const itemIdx = lvl3Idx[i];
  if (itemIdx === undefined) continue;
  fzByItem.set(itemIdx, fz[i] ?? Number.NaN);
}

const shapes: Array<Shape> = cli
  ? ["own-Fast", "own-Strong", "fast8", "lvl3"]
  : ["own-Fast", "own-Strong"];

for (const c of corpora) {
  console.log(`\n=== ${c.label} ===`);
  console.log(
    "payload".padEnd(22) +
      "shape".padStart(12) +
      "wzstd".padStart(9) +
      "fzstd".padStart(9) +
      "vs-fz".padStart(8),
  );
  const byShape = new Map<Shape, Array<number>>();
  const vsFz: Array<number> = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it === undefined || it.corpus !== c.id) continue;
    const rate = ours[i] ?? Number.NaN;
    const list = byShape.get(it.shape) ?? [];
    list.push(rate);
    byShape.set(it.shape, list);
    const peer = it.shape === "lvl3" ? (fzByItem.get(i) ?? Number.NaN) : Number.NaN;
    if (Number.isFinite(rate) && Number.isFinite(peer) && peer > 0) {
      vsFz.push(rate / peer);
    }
    if (it.bytes < 64 * 1024) continue;
    console.log(
      it.name.padEnd(22) +
        it.shape.padStart(12) +
        num(rate, 9) +
        num(peer, 9) +
        (Number.isFinite(rate) && Number.isFinite(peer) && peer > 0
          ? `${(rate / peer).toFixed(2)}x`.padStart(8)
          : "—".padStart(8)),
    );
  }
  console.log("--- medians ---");
  for (const shape of shapes) {
    const rates = byShape.get(shape) ?? [];
    console.log(`  ${shape.padEnd(12)} ${num(median(rates), 9)} MB/s`);
  }
  if (vsFz.length > 0) {
    console.log(`  vs-fz (lvl3, median of ratios) ${median(vsFz).toFixed(2)}x`);
  }
}
