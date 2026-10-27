/**
 * Decode-only bench, for iterating on `src/decompress.ts`.
 *
 * `bench_summary` spends most of its wall clock in the encoders, which makes it
 * unusable for tightening a decode loop. This one only decodes.
 *
 * **Level notation.** A bare minus is ambiguous here — `zstd -19` is *level 19*
 * while `zstd --fast=8` is *level −8* — and the two used to be written "CLI −19"
 * and "CLI −8", which reads as the same sign. So: positive levels are `lvl3` /
 * `lvl19`, the negative band is `fast8` (its actual CLI spelling, `--fast=8`).
 *
 * Frames come from both of our own levels (L1 and L3) and from the host `zstd`
 * CLI (`--fast=8`, level 3, level 19), because the product decodes arbitrary
 * zstd, not just what we emit. Level 19 in particular produces far longer matches
 * and larger literal sections than our encoder does, so it hits other branches;
 * `--fast=8` is copy-bound rather than bitstream-bound. Our own two levels are
 * both here because both ship and they are not the same shape — L1 trades ~2×
 * the output for speed, which changes the match/literal mix the decoder walks.
 *
 * Rate is MB/s of *output*, so frames of different size compare fairly.
 *
 * Four tables, deliberately not one wide row:
 *
 *  1. **Shape sweep** — one decoder (wzstd, verifying) over five frame shapes.
 *  2. **Peer compare on lvl3** — wzstd vs fzstd vs zrip. `vs-fz` is the product
 *     claim (we verify; fzstd never hashes). `zrip` is a ceiling, not a peer.
 *  3. **Cost of verification by shape** — nv÷verify on every shape (hash cost).
 *  4. **Checksum off on lvl3** — `nv/fz` is the like-for-like pair with fzstd.
 *     Never quote `nv/fz` bare as "our decode vs fzstd".
 *
 * **Each decoder runs in its own process** (`helpers/isolate.ts`). The `vs-fz`
 * column is the reason: it is a cross-implementation comparison, and a shared
 * process is exactly what makes those unreliable — ±15% noise, plus whatever the
 * first implementation left in the JIT and the heap for the next one. This
 * process only builds frames, which is deterministic work.
 *
 *   pnpm bench:decode                # main set (synthetic + silesia), 4 MB cap
 *   pnpm bench:decode --extra        # + your data, medianed apart
 *   pnpm bench:decode --extra-only 1000000
 */
import { compressFast } from "../dist/compressFast.js";
import { compressStrong } from "../dist/compressStrong.js";
import { hasZstdCli, zstdCompress } from "../tests/helpers/zstd_cli.ts";
import { MAIN_CORPUS_NOTE, selectCorpora } from "./helpers/corpora.ts";
import { createIsolate, num } from "./helpers/isolate.ts";
import { createProgress } from "./helpers/progress.ts";

/** Throughput is a per-byte rate, so a slice is legitimate here (ratio is not). */
const { cap: CAP, corpora, mainOnly } = selectCorpora();

const median = (v: Array<number>): number => {
  // oxlint-disable-next-line unicorn/no-array-sort -- filter() already copied
  const s = v.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s[s.length >> 1] ?? Number.NaN;
};

const ratioOrNaN = (a: number, b: number): number =>
  Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : Number.NaN;

const ratioCell = (v: number, w: number, digits: number): string =>
  (Number.isFinite(v) ? `${v.toFixed(digits)}x` : "—").padStart(w);

const cli = hasZstdCli();
if (!cli) console.log("(host zstd CLI absent — CLI frame columns skipped)");

if (mainOnly) {
  console.log("(main set: in-repo synthetic + silesia subset — --extra for your data)");
}

/**
 * Payloads keep their corpus tag, because the median lines below are **per
 * corpus and never pooled**. Pooling is the weighting defect the ledger records:
 * 33 synthetic fixtures worth 3.0 MB outvoting a handful of much larger files
 * meant most of the bytes got a minority of the vote, and it is what made the
 * last fzstd figure unusable. The per-payload rows were always fine; the single
 * MEDIAN line under them was not.
 */
const payloads = corpora
  .flatMap((c) => c.payloads.map((p) => ({ name: p.name, data: p.data, id: c.id })))
  .filter((p) => p.data.length > 0)
  .map((p) => ({
    name: p.name,
    corpus: p.id,
    data: p.data.length > CAP ? p.data.subarray(0, CAP) : p.data,
  }));

if (payloads.length === 0) throw new Error("no payloads to decode");

type Row = {
  name: string;
  corpus: string;
  n: number;
  /** Verifying wzstd, one column per frame shape. */
  oursL1: number;
  ours: number;
  fast8: number;
  cli3: number;
  cli19: number;
  /** Same shapes with `{ checksum: false }` — for cost = nv÷verify. */
  oursL1nv: number;
  oursNv: number;
  fast8nv: number;
  cli3nv: number;
  cli19nv: number;
  /** Peers on the lvl3 frame only. */
  fzstd: number;
  zrip: number;
};
type Shape = "oursL1" | "ours" | "fast8" | "cli3" | "cli19";

/**
 * Build every frame first, recording where each one landed in the staged blob.
 * Frames are deterministic, so building them here costs the comparison nothing —
 * and building them once means the three decoders below all read the identical
 * bytes rather than three independently-encoded copies of them.
 */
const items: Array<{ data: Uint8Array; bytes: number }> = [];
const slots: Array<Partial<Record<Shape, number>>> = [];

// Build every payload's frames, then one isolated run per decoder subject.
// Frame build is the long stretch when the CLI is producing level 19.
// Measure subjects differ in their pick sets, so the runs stay unrolled; the
// labels only pin the progress total to the tick sites below.
const MEASURE_LABELS = [
  "measure wzstd",
  "measure wzstd (checksum off)",
  "measure fzstd",
  "measure zrip",
] as const;
const progress = createProgress(payloads.length + MEASURE_LABELS.length);

for (const p of payloads) {
  const n = p.data.length;
  const slot: Partial<Record<Shape, number>> = {};
  const add = (shape: Shape, frame: Uint8Array | undefined): void => {
    if (frame === undefined) return;
    slot[shape] = items.length;
    items.push({ data: frame, bytes: n });
  };
  // Both of our own levels, because they are different frame shapes and both
  // ship: L1 targets speed and emits roughly 2× the bytes, so its frames carry
  // more and shorter matches and a larger literal share than L3's. Decoding our
  // own L1 output is a real consumer workload, and it was the one frame this
  // bench never fed to the decoder.
  add("oursL1", compressFast(p.data));
  add("ours", compressStrong(p.data));
  // The negative band is a different frame shape, not just a faster encoder:
  // mostly raw/RLE literals, long matches and few sequences, so it leans on
  // the copy paths rather than the bitstream and entropy paths.
  add("fast8", cli ? zstdCompress(p.data, -8) : undefined);
  add("cli3", cli ? zstdCompress(p.data, 3) : undefined);
  add("cli19", cli ? zstdCompress(p.data, 19) : undefined);
  slots.push(slot);
  progress.tick(`frames ${p.name}`);
}

const iso = createIsolate();
const staged = iso.stage(items);

// Verifying and no-verify both walk the full staged set so cost (nv÷verify) is
// a fair within-shape ratio: same child workload, same frames, only the hash
// differs. Peers stay on lvl3 — the one shape the product claim shares.
const ourRates = iso.measure("wzstd", staged);
progress.tick(MEASURE_LABELS[0]);
const nvRates = iso.measure("wzstd-noverify", staged);
progress.tick(MEASURE_LABELS[1]);
const cli3Picks = slots.map((s) => s.cli3).filter((i): i is number => i !== undefined);
const cli3Pos = new Map(cli3Picks.map((itemIdx, pos) => [itemIdx, pos]));
const fzRates = iso.measure("fzstd", staged, cli3Picks);
progress.tick(MEASURE_LABELS[2]);
const zripRates = iso.measure("zrip", staged, cli3Picks);
progress.tick(MEASURE_LABELS[3]);
const measureFailed = iso.anyFailed();
iso.dispose();

const at = (rates: Array<number>, i: number | undefined): number =>
  i === undefined ? Number.NaN : (rates[i] ?? Number.NaN);
const atCli3 = (rates: Array<number>, i: number | undefined): number =>
  at(rates, i === undefined ? undefined : cli3Pos.get(i));

const rows: Array<Row> = payloads.map((p, i) => {
  const slot = slots[i] ?? {};
  return {
    name: p.name,
    corpus: p.corpus,
    n: p.data.length,
    oursL1: at(ourRates, slot.oursL1),
    ours: at(ourRates, slot.ours),
    fast8: at(ourRates, slot.fast8),
    cli3: at(ourRates, slot.cli3),
    cli19: at(ourRates, slot.cli19),
    oursL1nv: at(nvRates, slot.oursL1),
    oursNv: at(nvRates, slot.ours),
    fast8nv: at(nvRates, slot.fast8),
    cli3nv: at(nvRates, slot.cli3),
    cli19nv: at(nvRates, slot.cli19),
    fzstd: atCli3(fzRates, slot.cli3),
    zrip: atCli3(zripRates, slot.cli3),
  };
});

/**
 * Four tables, four questions — not one wide row that mixes them.
 *
 *  1. Shape sweep: one decoder (wzstd, verifying) over five frame shapes.
 *  2. Peer compare: three decoders on the shared lvl3 frame + product ratios.
 *  3. Cost of verification by shape: nv÷verify (how much the hash costs).
 *  4. Like-for-like with fzstd on lvl3: both skip the hash (nv/fz).
 *
 * Ratios on median lines are the **median of per-payload ratios**, not the
 * ratio of the medians — only the former answers "on a typical payload".
 */
const NAME_W = 22;
const BYTES_W = 9;

const printTable = (
  title: string,
  caption: string,
  headers: Array<[string, number]>,
  body: Array<{ label: string; bytes: string; cells: Array<string> }>,
): void => {
  console.log(`\n=== ${title} ===`);
  if (caption !== "") console.log(`  ${caption}`);
  console.log(
    "\n" +
      "payload".padEnd(NAME_W) +
      "bytes".padStart(BYTES_W) +
      headers.map(([h, w]) => h.padStart(w)).join(""),
  );
  for (const row of body) {
    console.log(row.label.padEnd(NAME_W) + row.bytes.padStart(BYTES_W) + row.cells.join(""));
  }
};

/** One median block per corpus, never pooled — see the note on `payloads`. */
const byCorpus = (["synthetic", "silesia", "extra"] as const)
  .map((id) => ({ id, rows: rows.filter((r) => r.corpus === id) }))
  .filter((c) => c.rows.length > 0);

// --- 1. Shape sweep ----------------------------------------------------------
{
  const headers: Array<[string, number]> = [
    ["own-Fast", 9],
    ["own-Strong", 9],
    ["fast8", 9],
    ["lvl3", 9],
    ["lvl19", 9],
  ];
  const body: Array<{ label: string; bytes: string; cells: Array<string> }> = [];
  for (const r of rows) {
    body.push({
      label: r.name,
      bytes: String(r.n),
      cells: [num(r.oursL1, 9), num(r.ours, 9), num(r.fast8, 9), num(r.cli3, 9), num(r.cli19, 9)],
    });
  }
  for (const { id, rows: of } of byCorpus) {
    body.push({
      label: `MEDIAN ${id}`,
      bytes: `${of.length} pl`,
      cells: [
        num(median(of.map((r) => r.oursL1)), 9),
        num(median(of.map((r) => r.ours)), 9),
        num(median(of.map((r) => r.fast8)), 9),
        num(median(of.map((r) => r.cli3)), 9),
        num(median(of.map((r) => r.cli19)), 9),
      ],
    });
  }
  printTable(
    "1. wzstd (checksum on) by frame shape — MB/s out",
    "One decoder, five frames. own-* = FCS exact buffer; CLI shapes = no FCS (growing buffer).",
    headers,
    body,
  );
}

// --- 2. Peer compare on lvl3 -------------------------------------------------
{
  const headers: Array<[string, number]> = [
    ["wzstd", 9],
    ["fzstd", 9],
    ["zrip", 10],
    ["vs-fz", 9],
    ["zrip/us", 8],
  ];
  const body: Array<{ label: string; bytes: string; cells: Array<string> }> = [];
  for (const r of rows) {
    body.push({
      label: r.name,
      bytes: String(r.n),
      cells: [
        num(r.cli3, 9),
        num(r.fzstd, 9),
        num(r.zrip, 10),
        ratioCell(ratioOrNaN(r.cli3, r.fzstd), 9, 2),
        ratioCell(ratioOrNaN(r.zrip, r.cli3), 8, 1),
      ],
    });
  }
  for (const { id, rows: of } of byCorpus) {
    body.push({
      label: `MEDIAN ${id}`,
      bytes: `${of.length} pl`,
      cells: [
        num(median(of.map((r) => r.cli3)), 9),
        num(median(of.map((r) => r.fzstd)), 9),
        num(median(of.map((r) => r.zrip)), 10),
        ratioCell(median(of.map((r) => ratioOrNaN(r.cli3, r.fzstd))), 9, 2),
        ratioCell(median(of.map((r) => ratioOrNaN(r.zrip, r.cli3))), 8, 1),
      ],
    });
  }
  printTable(
    "2. Peer compare on lvl3 frame — MB/s out",
    "vs-fz = wzstd/fzstd, WE VERIFY (default claim). >=1 ⇒ faster while doing more work. zrip is a ceiling.",
    headers,
    body,
  );
}

// --- 3. Cost of verification by shape ---------------------------------------
{
  const headers: Array<[string, number]> = [
    ["own-Fast", 8],
    ["own-Strong", 8],
    ["fast8", 8],
    ["lvl3", 8],
    ["lvl19", 8],
  ];
  const costCells = (r: Row): Array<string> => [
    ratioCell(ratioOrNaN(r.oursL1nv, r.oursL1), 8, 3),
    ratioCell(ratioOrNaN(r.oursNv, r.ours), 8, 3),
    ratioCell(ratioOrNaN(r.fast8nv, r.fast8), 8, 3),
    ratioCell(ratioOrNaN(r.cli3nv, r.cli3), 8, 3),
    ratioCell(ratioOrNaN(r.cli19nv, r.cli19), 8, 3),
  ];
  const body: Array<{ label: string; bytes: string; cells: Array<string> }> = [];
  for (const r of rows) {
    body.push({ label: r.name, bytes: String(r.n), cells: costCells(r) });
  }
  for (const { id, rows: of } of byCorpus) {
    body.push({
      label: `MEDIAN ${id}`,
      bytes: `${of.length} pl`,
      cells: [
        ratioCell(median(of.map((r) => ratioOrNaN(r.oursL1nv, r.oursL1))), 8, 3),
        ratioCell(median(of.map((r) => ratioOrNaN(r.oursNv, r.ours))), 8, 3),
        ratioCell(median(of.map((r) => ratioOrNaN(r.fast8nv, r.fast8))), 8, 3),
        ratioCell(median(of.map((r) => ratioOrNaN(r.cli3nv, r.cli3))), 8, 3),
        ratioCell(median(of.map((r) => ratioOrNaN(r.cli19nv, r.cli19))), 8, 3),
      ],
    });
  }
  printTable(
    "3. Cost of verification by shape (nv÷verify)",
    "cost = skip÷verify throughput. 1.12× means verify takes ~12% longer (skip is 1.12× the MB/s). Digests on; peers not involved.",
    headers,
    body,
  );
}

// --- 4. Like-for-like with fzstd on lvl3 -------------------------------------
{
  const headers: Array<[string, number]> = [
    ["wzstd-nv", 9],
    ["fzstd", 9],
    ["nv/fz", 8],
  ];
  const body: Array<{ label: string; bytes: string; cells: Array<string> }> = [];
  for (const r of rows) {
    body.push({
      label: r.name,
      bytes: String(r.n),
      cells: [num(r.cli3nv, 9), num(r.fzstd, 9), ratioCell(ratioOrNaN(r.cli3nv, r.fzstd), 8, 2)],
    });
  }
  for (const { id, rows: of } of byCorpus) {
    body.push({
      label: `MEDIAN ${id}`,
      bytes: `${of.length} pl`,
      cells: [
        num(median(of.map((r) => r.cli3nv)), 9),
        num(median(of.map((r) => r.fzstd)), 9),
        ratioCell(median(of.map((r) => ratioOrNaN(r.cli3nv, r.fzstd))), 8, 2),
      ],
    });
  }
  printTable(
    "4. Checksum off on lvl3 (like-for-like with fzstd)",
    "nv/fz is NOT the product claim — both skip the hash. Default claim is vs-fz in table 2.",
    headers,
    body,
  );
}

console.log(
  "\n  Frame names: own-Fast/Strong = our compressors (always FCS + digest);\n" +
    "  fast8 / lvl3 / lvl19 = host CLI over a pipe (no FCS → growing buffer).\n" +
    "  Peers always decode the lvl3 frame. Ratios = median of per-payload ratios.\n" +
    "  Each decoder ran in its own process; frames were built once, up front.\n" +
    "  Corpora are medianed separately and must NOT be averaged.\n" +
    (mainOnly ? MAIN_CORPUS_NOTE : ""),
);

if (process.env["WZSTD_BENCH_JSON"] === "1") {
  console.log(`__JSON__${JSON.stringify(rows)}`);
}

// A full table of — is not a successful run. Columns stay printable either way.
if (measureFailed) process.exitCode = 1;
