/**
 * Encode-only bench, for iterating on `src/compress/`.
 *
 * The counterpart to `bench_decode`, and it exists for the same reason: a change
 * to the L3 matcher should not have to wait on four frame shapes being built and
 * five decoders being timed to find out whether it helped. `bench_summary` still
 * reports both sides — it is the quotable table, not the iteration tool.
 *
 * **Report four numbers on any encoder change: Fast size, Strong size, L1 speed, L3
 * speed.** The levels are a product constraint, not two points on a curve: L1 is
 * ~2.2x faster for ~2x the output, and a change that pulls them together removes
 * L1's reason to exist even when each level looks fine alone. This bench puts all
 * four in one table so that is hard to miss. The one acceptable convergence is a
 * change strictly better on both axes — say which you have.
 *
 * **Ratio is over whole payloads; speed is over a cap.** A byte prefix changes
 * what a matcher can find, so a ratio from one is a fiction. Throughput is a
 * per-byte rate, so a slice is legitimate there.
 *
 * **Every timed row runs in its own process** (`helpers/isolate.ts`). Sizes are
 * deterministic and are computed here; nothing is timed in this process.
 *
 *   pnpm bench:encode                # main set (synthetic + silesia), 4 MB cap
 *   pnpm bench:encode --extra        # + your data, reported separately
 *   pnpm bench:encode --peers        # add zrip and node:zlib for context
 *   pnpm bench:encode --lvl19        # add node:zlib -19: how much ratio is left
 *   pnpm bench:encode --no-ultra     # skip Ultra (Fast/Strong + fflate gzip)
 *   pnpm bench:encode --wzstd-only   # time only wzstd tiers; reuse fixed controls
 *   pnpm bench:encode --wzstd-only --encoder fast # one wzstd tier only
 *   pnpm bench:encode --extra-only 1000000
 */
import { hasNodeZstd } from "../tests/helpers/node_zstd.ts";
import { ensureZrip } from "../tests/helpers/zrip_init.ts";
import { MAIN_CORPUS_NOTE, selectCorpora } from "./helpers/corpora.ts";
import { ENCODER_OPTIONS, encoderGroup, encoderList } from "./helpers/encoders.ts";
import { createIsolate, num } from "./helpers/isolate.ts";
import { createProgress } from "./helpers/progress.ts";

/**
 * Encoder knobs compose with the corpus flags: `--peers` adds the zstd ceilings,
 * `--lvl19` adds the expensive ratio reference, `--no-ultra` drops Ultra.
 * fflate gzip is always on (pure-JS cross-format peer). The roster itself lives
 * in `helpers/encoders.ts`, shared with `bench_summary` so the two cannot drift;
 * that bench takes peers unconditionally.
 */
const {
  cap: CAP,
  corpora,
  mainOnly,
  values,
} = selectCorpora({
  ...ENCODER_OPTIONS,
  "wzstd-only": { type: "boolean", default: false },
  encoder: { type: "string" },
});
const WANT_PEERS = values["peers"] === true;
const NO_ULTRA = values["no-ultra"] === true;
const WZSTD_ONLY = values["wzstd-only"] === true;
const ENCODER_FILTER = values["encoder"];

if (WZSTD_ONLY && (WANT_PEERS || values["lvl19"] === true)) {
  throw new Error("--wzstd-only cannot be combined with --peers or --lvl19");
}
if (
  ENCODER_FILTER !== undefined &&
  ENCODER_FILTER !== "fast" &&
  ENCODER_FILTER !== "strong" &&
  ENCODER_FILTER !== "ultra"
) {
  throw new Error("--encoder must be fast, strong, or ultra");
}
if (ENCODER_FILTER !== undefined && !WZSTD_ONLY) {
  throw new Error("--encoder requires --wzstd-only");
}
if (ENCODER_FILTER === "ultra" && NO_ULTRA) {
  throw new Error("--encoder ultra cannot be combined with --no-ultra");
}

const median = (v: Array<number>): number => {
  // oxlint-disable-next-line unicorn/no-array-sort -- filter() already copied
  const s = v.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s[s.length >> 1] ?? Number.NaN;
};

// Lazy peer import: without --peers this process never loads zrip WASM.
let zripCompress: ((d: Uint8Array, level: number) => Uint8Array) | undefined;
if (WANT_PEERS) {
  await ensureZrip();
  ({ compress: zripCompress } = await import("@paddor/zrip"));
}
const allEncoders = encoderList({
  peers: WANT_PEERS,
  lvl19: values["lvl19"] === true,
  noUltra: NO_ULTRA,
  ...(zripCompress === undefined ? {} : { zripCompress }),
});
const ENCODERS = allEncoders.filter(([label]) => {
  if (!WZSTD_ONLY) return true;
  if (ENCODER_FILTER === undefined) return label.startsWith("wzstd");
  return label === `wzstd ${ENCODER_FILTER[0]?.toUpperCase()}${ENCODER_FILTER.slice(1)}`;
});

if (mainOnly) {
  console.log("(main set: in-repo synthetic + silesia subset — --extra for your data)");
}
if (WZSTD_ONLY) {
  console.log("(fixed peer controls skipped — wzstd tiers only)");
} else if (!WANT_PEERS) {
  console.log("(no zrip — --peers to add; fflate + node gzip + node:zlib -3 always on)");
}
if (NO_ULTRA) console.log("(Ultra skipped — omit --no-ultra to include)");
if (!hasNodeZstd()) console.log("(node:zlib zstd absent — those rows skipped)");

const iso = createIsolate();

for (const { label, payloads } of corpora) {
  const whole = payloads.filter((p) => p.data.length > 0);
  const capped = whole.map((p) => (p.data.length > CAP ? p.data.subarray(0, CAP) : p.data));
  const srcBytes = whole.reduce((sum, p) => sum + p.data.length, 0);

  console.log(
    `\n${"=".repeat(72)}\n== ${label} — ${whole.length} payloads, ${srcBytes} B\n${"=".repeat(72)}`,
  );

  const staged = iso.stage(capped.map((d) => ({ data: d, bytes: d.length })));

  /** Per-payload ratios as well as the total: one file can hide a regression. */
  type Row = {
    label: string;
    ratio: number;
    speed: number;
    worstName: string;
    worstRatio: number;
  };
  const rows: Array<Row> = [];
  const progress = createProgress(ENCODERS.length);

  for (const [eLabel, subject, fn] of ENCODERS) {
    let src = 0;
    let out = 0;
    let worstName = "";
    let worstRatio = Number.NEGATIVE_INFINITY;
    for (const p of whole) {
      const size = fn(p.data).length;
      src += p.data.length;
      out += size;
      const r = size / p.data.length;
      if (r > worstRatio) {
        worstRatio = r;
        worstName = p.name;
      }
    }
    rows.push({
      label: eLabel,
      ratio: out / src,
      speed: median(iso.measure(subject, staged)),
      worstName,
      worstRatio,
    });
    progress.tick(eLabel);
  }

  console.log(`\n=== Encode — corpus totals for ratio, median MB/s for speed ===\n`);
  console.log(
    "encoder".padEnd(18) +
      "ratio".padStart(8) +
      "saved".padStart(9) +
      "MB/s in".padStart(10) +
      "vs Strong".padStart(8) +
      "  worst payload",
  );
  const l3Rate = rows.find((r) => r.label === "wzstd Strong")?.speed ?? Number.NaN;
  let lastGroup = "";
  for (const r of rows) {
    const group = encoderGroup(r.label);
    if (group !== lastGroup) {
      console.log(`  --- ${group} ---`);
      lastGroup = group;
    }
    const vsL3 =
      Number.isFinite(r.speed) && Number.isFinite(l3Rate) && l3Rate !== 0
        ? `${(r.speed / l3Rate).toFixed(2)}x`
        : "—";
    console.log(
      r.label.padEnd(18) +
        r.ratio.toFixed(4).padStart(8) +
        `${((1 - r.ratio) * 100).toFixed(1)}%`.padStart(9) +
        num(r.speed, 10) +
        vsL3.padStart(8) +
        `  ${r.worstRatio.toFixed(4)} ${r.worstName}`,
    );
  }

  const l1 = rows.find((r) => r.label === "wzstd Fast");
  const l3 = rows.find((r) => r.label === "wzstd Strong");
  if (l1 && l3 && Number.isFinite(l1.speed) && Number.isFinite(l3.speed) && l3.speed !== 0) {
    console.log(
      `\n  Fast is ${(l1.speed / l3.speed).toFixed(2)}x the speed of Strong for ` +
        `${(l1.ratio / l3.ratio).toFixed(2)}x the output.`,
    );
  }
}

const measureFailed = iso.anyFailed();
iso.dispose();

console.log(
  "\n  ratio = compressed/original over WHOLE payloads; lower is better.\n" +
    "  worst payload = the single file with the highest ratio, which is where\n" +
    "  a regression shows before the total moves.\n" +
    "  Speed is measured per encoder in its own process, median across payloads.\n" +
    "  Fast and Strong are a product constraint, not two points on a curve: report\n" +
    "  Fast size, Strong size, Fast speed and Strong speed on any encoder change.\n" +
    (mainOnly ? MAIN_CORPUS_NOTE : ""),
);

if (measureFailed) process.exitCode = 1;
