/**
 * One summary of where wzstd stands against every peer, on both sides.
 *
 * Three benches, one question each: `bench_encode` and `bench_decode` are for
 * iterating on one side without paying for the other, and this one exists to be
 * *quotable* — both sides, every implementation, speed and ratio in one place.
 * `bench_compress` and `bench_throughput` were deleted rather than fixed: both
 * compared wzstd against zrip inside one process, which is the measurement
 * defect `helpers/isolate.ts` exists to prevent, and everything they reported is
 * here.
 *
 * **Who is a peer and who is a ceiling.** Only fzstd is a like-for-like
 * comparison — pure JS, no native code, and the implementation `src/decompress.ts`
 * derives from. zrip is Rust → WebAssembly and `node:zlib` is the C libzstd
 * in-process; both are ceilings, and both are useful precisely because they say
 * how much of the gap is language and how much is us.
 *
 * **Checksums are not free and not uniform.** Every row here except fzstd
 * verifies the frame content checksum by default. fzstd never does — it skips
 * the four bytes without hashing them. The `wzstd (checksum off)` row is the
 * like-for-like pair with fzstd; the verifying `wzstd` row is the default claim
 * and is strictly more work. Do **not** form a `vs-fz` ratio from this table —
 * that number lives in `bench:decode` (see the decode-table footer).
 *
 * **Level notation.** A bare minus is ambiguous — `zstd -19` is *level 19* while
 * `zstd --fast=8` is *level −8*. Positive levels are written `lvl3` / `lvl19`;
 * the negative band keeps its CLI spelling, `fast8`.
 *
 * Ratio is measured on **whole payloads** — a byte prefix changes what a codec
 * can find and makes the number a fiction. Throughput is a per-byte rate, so it
 * may use a cap.
 *
 * **Every timed row runs in its own process** (`helpers/isolate.ts`). This table
 * exists to be compared across implementations, which is exactly the thing a
 * shared process corrupts — it once put a no-verify decode row above the
 * verifying one on all four frame shapes. The parent builds frames and computes
 * ratios (both deterministic, and unaffected); it times nothing.
 *
 *   pnpm bench:summary                # main set (synthetic + silesia), 4 MB cap
 *   pnpm bench:summary --extra        # + your data
 *   pnpm bench:summary --extra-only 1000000
 *
 * **Order: encode, then decode.** Encode does not need peer frames; decode does
 * (and building lvl19 is most of the pre-decode wall clock). Encoder work used
 * to sit last, so a long decode matrix delayed the numbers people came for.
 * For encode-only iteration prefer `pnpm bench:encode`.
 */
import { compressStrong } from "../dist/compressStrong.js";
import { hasNodeZstd, nodeZstdCompress } from "../tests/helpers/node_zstd.ts";
import { ensureZrip } from "../tests/helpers/zrip_init.ts";
import { hasZstdCli, zstdCompress } from "../tests/helpers/zstd_cli.ts";
import { MAIN_CORPUS_NOTE, selectCorpora } from "./helpers/corpora.ts";
import { encoderGroup, encoderList } from "./helpers/encoders.ts";
import { createIsolate, num, type SubjectId } from "./helpers/isolate.ts";
import { createProgress } from "./helpers/progress.ts";

/** `--lvl19` is the only encoder knob here; peers are not optional in a summary. */
const {
  cap: CAP,
  corpora,
  mainOnly,
  values,
} = selectCorpora({ lvl19: { type: "boolean", default: false } });

const median = (v: Array<number>): number => {
  // oxlint-disable-next-line unicorn/no-array-sort -- filter() already copied
  const s = v.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s[s.length >> 1] ?? Number.NaN;
};

await ensureZrip();
const { compress: zripCompress } = await import("@paddor/zrip");
const cli = hasZstdCli();
const nodeZstd = hasNodeZstd();
if (!cli) console.log("(host zstd CLI absent — CLI-produced frames skipped)");
if (!nodeZstd) console.log("(node:zlib zstd absent — those columns skipped)");

// Corpus selection, the flags and the never-pool rule live in `helpers/corpora`.
if (mainOnly) {
  console.log("(main set: in-repo synthetic + silesia subset — --extra for your data)");
}

// ---------------------------------------------------------------- decode ----

/**
 * Reach libzstd **in-process** rather than shelling out.
 *
 * `node:zlib` is the same C library the `zstd` CLI is built on, so the frames
 * are equivalent for this table's purpose, and it avoids `spawnSync` entirely.
 * That matters: the CLI helper pipes stdin, and a summary pass needs hundreds of
 * frames — enough spawns that a deadlock is a matter of time, not luck. The CLI
 * stays as the fallback when `node:zlib` has no zstd.
 *
 * (`bench_decode.ts` still uses CLI frames on purpose: reading a pipe, the CLI
 * omits the frame content size, which is a genuinely different decoder path.
 * That distinction is that bench's job, not this one's.)
 */
const libzstd = (d: Uint8Array, level: number): Uint8Array | undefined => {
  // `checksum: true` is not optional here. node:zlib's one-shot API omits the
  // content checksum by default while the CLI writes one, so without this the
  // frames carry nothing to verify and the "verifies" column below measures
  // the same work in every row — which is exactly the claim it exists to test.
  if (nodeZstd) return nodeZstdCompress(d, level, true);
  return cli ? zstdCompress(d, level) : undefined;
};

/** Frame shapes worth separating: they exercise different decoder paths. */
const FRAMES: Array<[string, (d: Uint8Array) => Uint8Array | undefined]> = [
  ["own-Strong", (d) => compressStrong(d)],
  ["fast8", (d) => libzstd(d, -8)],
  ["lvl3", (d) => libzstd(d, 3)],
  ["lvl19", (d) => libzstd(d, 19)],
];

/**
 * `verifies` is load-bearing: it is why the rows are not interchangeable, and it
 * is the reason the no-verify row can live here at all. Read down that column
 * before comparing any two numbers across it — `wzstd` against `fzstd` is
 * parity-or-better *while doing strictly more work*, and `wzstd (checksum off)`
 * against `fzstd` is the like-for-like pair. Neither is "the" decode number.
 *
 * The no-verify row returned with `ZstdDecodeOptions.checksum`. It was dropped
 * once before with the option, and it had also measured *badly*: running every
 * decoder in one process put it **above** the verified row on the real corpus,
 * which is impossible, and is exactly the same-process artifact the ledger
 * warns about. Every row is a separate child process now, which is what makes
 * that impossible to reproduce — do not "simplify" that away to add a row.
 */
const DECODERS: Array<[string, string, SubjectId]> = [
  ["wzstd", "yes", "wzstd"],
  ["wzstd (checksum off)", "no", "wzstd-noverify"],
  ["wzstd streaming", "yes", "wzstd-stream"],
  ["fzstd", "never", "fzstd"],
  ["zrip (Rust→WASM)", "yes", "zrip"],
  ...(nodeZstd
    ? ([["node:zlib (C)", "yes", "node-zlib"]] as Array<[string, string, SubjectId]>)
    : []),
];

// ---------------------------------------------------------------- encode ----

/**
 * Peers are always in — a summary without them is not a summary — so the only
 * choice here is `--lvl19`. The roster itself lives in `helpers/encoders.ts`,
 * shared with `bench_encode`, so the two cannot drift.
 *
 * Ratio is whole-payload; speed is capped. Encoders are isolated per process for
 * the same reason the decoders are: the `vs Strong` column is a cross-encoder ratio,
 * and the Fast-vs-Strong multiple is a number this project makes product decisions on
 * — a pooled median once said L1 was only 1.27x L3, which would have left L1
 * with no reason to exist. Ratio stays in this process: sizes are deterministic
 * and a shared heap cannot move them.
 *
 * The decode side keeps its `lvl19` column unconditionally: those frames are
 * built from capped payloads and cost a few seconds, and level 19 frames are a
 * genuinely different decoder path that regressions have hidden in before.
 */
const ENCODERS = encoderList({
  peers: true,
  lvl19: values["lvl19"] === true,
  zripCompress,
});
if (values["lvl19"] !== true) {
  console.log("(node:zlib -19 encode skipped — --lvl19 to include)");
}

const iso = createIsolate();

for (const { label, payloads } of corpora) {
  const whole = payloads.filter((p) => p.data.length > 0);
  const capped = whole.map((p) => ({
    name: p.name,
    data: p.data.length > CAP ? p.data.subarray(0, CAP) : p.data,
  }));
  const srcBytes = whole.reduce((s, p) => s + p.data.length, 0);

  console.log(
    `\n${"=".repeat(72)}\n== ${label} — ${whole.length} payloads, ${srcBytes} B\n${"=".repeat(72)}`,
  );

  // Encode first, then decode. Encode does not need peer frames; decode does
  // (and building lvl19 frames is most of the pre-decode wall clock). Printer
  // order matches so a partial run still answers "how is Fast/Strong?".
  const steps = ENCODERS.length + FRAMES.length + DECODERS.length;
  const progress = createProgress(steps);

  // Measure everything before printing: the `vs Strong` column needs L3's rate,
  // and Fast is reported above it.
  const stagedPayloads = iso.stage(capped.map((p) => ({ data: p.data, bytes: p.data.length })));
  const encodeRows: Array<[string, number, number]> = [];
  for (const [eLabel, subject, fn] of ENCODERS) {
    // Ratio is over whole payloads and stays here — it is a byte count, not a
    // measurement. Speed is over the capped copies, in the child.
    let src = 0;
    let out = 0;
    for (const p of whole) {
      src += p.data.length;
      out += fn(p.data).length;
    }
    const speed = median(iso.measure(subject, stagedPayloads));
    encodeRows.push([eLabel, out / src, speed]);
    progress.tick(`encode ${eLabel}`);
  }

  console.log(`\n=== Encode — corpus totals for ratio, median MB/s for speed ===\n`);
  console.log(
    "encoder".padEnd(20) +
      "ratio".padStart(8) +
      "saved".padStart(9) +
      "MB/s in".padStart(10) +
      "vs Strong".padStart(8),
  );
  const l3Rate = encodeRows.find(([l]) => l === "wzstd Strong")?.[2] ?? Number.NaN;
  let lastEncodeGroup = "";
  for (const [eLabel, ratio, speed] of encodeRows) {
    const group = encoderGroup(eLabel);
    if (group !== lastEncodeGroup) {
      console.log(`  --- ${group} ---`);
      lastEncodeGroup = group;
    }
    const vsL3 =
      Number.isFinite(speed) && Number.isFinite(l3Rate) && l3Rate !== 0
        ? `${(speed / l3Rate).toFixed(2)}x`
        : "—";
    console.log(
      eLabel.padEnd(20) +
        ratio.toFixed(4).padStart(8) +
        `${((1 - ratio) * 100).toFixed(1)}%`.padStart(9) +
        num(speed, 10) +
        vsL3.padStart(8),
    );
  }

  /**
   * Build every frame **once**. Generating them inside the decoder loop
   * rebuilt the identical frame for each decoder — six times over, `zstd -19`
   * included — which was most of the wall clock and bought nothing.
   */
  const built: Array<Array<{ frame: Uint8Array; out: number }>> = [];
  for (const [shape, make] of FRAMES) {
    const frames: Array<{ frame: Uint8Array; out: number }> = [];
    for (const p of capped) {
      const f = make(p.data);
      if (f) frames.push({ frame: f, out: p.data.length });
    }
    built.push(frames);
    progress.tick(`frames ${shape} (${frames.length})`);
  }

  /**
   * Stage every shape's frames once, then hand the same file to each decoder's
   * child. Frames are built by this process and only *read* by the children, so
   * nothing about who decodes them changes what they contain.
   */
  const stagedFrames = iso.stage(
    built.flat().map(({ frame, out }) => ({ data: frame, bytes: out })),
  );
  const shapeCounts = built.map((frames) => frames.length);

  const decodeRows: Array<[string, string, Array<number>]> = [];
  for (const [dLabel, verifies, subject] of DECODERS) {
    const rates = iso.measure(subject, stagedFrames);
    let at = 0;
    const perFrame = shapeCounts.map((count) => {
      const slice = rates.slice(at, at + count);
      at += count;
      return median(slice);
    });
    decodeRows.push([dLabel, verifies, perFrame]);
    progress.tick(`decode ${dLabel}`);
  }

  console.log(`\n=== Decode — MB/s of output, median of ${capped.length} payloads ===`);
  console.log("  rows = decoder · columns = who produced the frame (not different decoders)");
  console.log(
    "\n" +
      "decoder".padEnd(20) +
      "verifies".padStart(9) +
      FRAMES.map(([h]) => h.padStart(10)).join(""),
  );
  // Pure-JS rows first (product claim), then ceilings — DECODERS is ordered
  // that way; the group rule just makes the break visible.
  let lastGroup = "";
  for (let i = 0; i < decodeRows.length; i++) {
    const row = decodeRows[i];
    if (row === undefined) continue;
    const [dLabel, verifies, vals] = row;
    const subject = DECODERS[i]?.[2];
    const group = subject === "zrip" || subject === "node-zlib" ? "ceilings" : "pure JS";
    if (group !== lastGroup) {
      console.log(`  --- ${group} ---`);
      lastGroup = group;
    }
    console.log(dLabel.padEnd(20) + verifies.padStart(9) + vals.map((v) => num(v, 10)).join(""));
  }
  // This table and `bench:decode` are not interchangeable for the product
  // claim. Frames here prefer node:zlib with FCS (exact output buffer);
  // `bench:decode` uses the host CLI over a pipe (no FCS → growing buffer),
  // which is a different decoder path, and its `vs-fz` is the median of
  // per-payload ratios rather than a ratio of the medians printed here.
  console.log(
    "\n  Product claim (vs-fz / nv/fz / verification cost): `pnpm bench:decode` only.\n" +
      (nodeZstd
        ? "  Frames here are node:zlib with FCS + digest; `bench:decode` uses CLI pipe (no FCS).\n"
        : cli
          ? "  Frames here fell back to host CLI (no FCS) — same path as bench:decode;\n" +
            "  do not treat absolute MB/s as a different decoder path.\n"
          : "  No node:zlib and no host CLI — only own-Strong frames were measured here.\n"),
  );
}

const measureFailed = iso.anyFailed();
iso.dispose();

console.log(
  "\n  Every timed row above ran in its own process; ratios are byte counts.\n" +
    "  fast8 = zstd --fast=8 (level −8). lvl3 / lvl19 = zstd -3 / -19 (positive).\n" +
    "  ratio = compressed/original over WHOLE payloads; lower is better.\n" +
    "  Only fzstd is a peer (pure JS). zrip is Rust→WASM and node:zlib is C —\n" +
    "  both are ceilings, and neither is a like-for-like comparison.\n" +
    "  fzstd never hashes; `wzstd (checksum off)` opts out; every other row verifies.\n" +
    "  The corpora are reported separately and must NOT be averaged: the\n" +
    "  synthetic set is ~3 MB of small fixtures that sit in cache and reads\n" +
    "  high. Quote the extra rows; reproduce anywhere with the synthetic ones.\n" +
    (mainOnly ? MAIN_CORPUS_NOTE : ""),
);

if (measureFailed) process.exitCode = 1;
