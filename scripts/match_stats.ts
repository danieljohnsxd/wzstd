/**
 * Deterministic Strong matcher work counters over a corpus.
 *
 * Wall-clock on encode is ±40% between processes; these counts are exact.
 * Use this to answer "does this config do less work?" before touching the
 * timer. Ratio is whole-file compressed size (deterministic too).
 *
 * For arbitrary config A/B (size + optional stats), prefer `pnpm bench:ab`.
 *
 * ```
 *   pnpm bench:match-stats                 # synthetic
 *   pnpm bench:match-stats --extra         # + your data
 *   pnpm bench:match-stats --silesia-only  # Silesia subset alone
 *   pnpm bench:match-stats --extra-only    # real data alone
 *   pnpm bench:match-stats --sweep         # also try nearby levers
 * ```
 */
import {
  STRONG_CONFIG,
  compressStrongWithConfig,
  type MatcherConfig,
  withMatchStats,
} from "../dist/compressStrong.js";
import { selectCorpora } from "./helpers/corpora.ts";
import { addStats, emptyStats, num, pct } from "./helpers/match_stats_util.ts";
import { createProgress } from "./helpers/progress.ts";

const { corpora, values } = selectCorpora({
  sweep: { type: "boolean", default: false },
});
const WANT_SWEEP = values["sweep"] === true;

type Variant = { name: string; config: MatcherConfig };

const baseline: Variant = {
  name: "Strong (shipped)",
  config: { ...STRONG_CONFIG },
};

/** Nearby levers — full A/B suites live under `pnpm bench:ab --suite …`. */
const sweepVariants: Array<Variant> = [
  baseline,
  {
    name: "lazyDepth 2",
    config: { ...STRONG_CONFIG, lazyDepth: 2 },
  },
  {
    name: "lazyDepth 1",
    config: { ...STRONG_CONFIG, lazyDepth: 1 },
  },
  {
    // Shipped Strong is patience 4; first-hit-final is the regression probe.
    name: "patience 1 (first-hit)",
    config: { ...STRONG_CONFIG, patience: 1 },
  },
  {
    name: "patience 3",
    config: { ...STRONG_CONFIG, patience: 3 },
  },
  {
    name: "chainLimit 20",
    config: { ...STRONG_CONFIG, chainLimit: 20 },
  },
  {
    name: "chainLimit 16",
    config: { ...STRONG_CONFIG, chainLimit: 16 },
  },
  {
    name: "nullPatience 10",
    config: { ...STRONG_CONFIG, nullPatience: 10 },
  },
  {
    name: "nullPatience 16",
    config: { ...STRONG_CONFIG, nullPatience: 16 },
  },
];

const variants = WANT_SWEEP ? sweepVariants : [baseline];

for (const { label, payloads } of corpora) {
  const whole = payloads.filter((p) => p.data.length > 0);
  const srcBytes = whole.reduce((s, p) => s + p.data.length, 0);
  console.log(
    `\n${"=".repeat(72)}\n== ${label} — ${whole.length} payloads, ${srcBytes} B\n${"=".repeat(72)}`,
  );

  type Row = {
    name: string;
    out: number;
    stats: ReturnType<typeof emptyStats>;
  };
  const rows: Array<Row> = [];
  const progress = createProgress(variants.length);

  for (const v of variants) {
    const stats = emptyStats();
    let out = 0;
    for (const p of whole) {
      const { value, stats: s } = withMatchStats(() => compressStrongWithConfig(p.data, v.config));
      out += value.length;
      addStats(stats, s);
    }
    rows.push({ name: v.name, out, stats });
    progress.tick(v.name);
  }

  const base = rows[0];
  if (base === undefined) continue;

  console.log(`\n=== Work and size (deterministic) ===\n`);
  console.log(
    "variant".padEnd(24) +
      "ratio".padStart(8) +
      "Δsize".padStart(8) +
      "probes".padStart(14) +
      "Δwork".padStart(8) +
      "searches".padStart(12) +
      "  lazy%".padStart(8) +
      "  needle%".padStart(9),
  );

  for (const r of rows) {
    const ratio = r.out / srcBytes;
    const dSize = ((r.out / base.out - 1) * 100).toFixed(2) + "%";
    const dWork =
      base.stats.probes === 0
        ? "—"
        : ((r.stats.probes / base.stats.probes - 1) * 100).toFixed(1) + "%";
    const lazyShare = pct(r.stats.lazySearches, r.stats.searches);
    const needleShare = pct(r.stats.needleHits, r.stats.probes);
    console.log(
      r.name.padEnd(24) +
        ratio.toFixed(4).padStart(8) +
        dSize.padStart(8) +
        num(r.stats.probes).padStart(14) +
        dWork.padStart(8) +
        num(r.stats.searches).padStart(12) +
        lazyShare.padStart(8) +
        needleShare.padStart(9),
    );
  }

  const s = base.stats;
  const exits =
    s.exitPatience +
    s.exitNullPatience +
    s.exitChainLimit +
    s.exitMinLen +
    s.exitMaxMatch +
    s.exitNoCandidate;
  console.log(`\n=== Baseline walk exits (${base.name}) ===\n`);
  console.log(
    `  probes ${num(s.probes)}  searches ${num(s.searches)}` +
      `  (primary ${num(s.primarySearches)}, lazy ${num(s.lazySearches)})\n` +
      `  hits ${num(s.hits)}  improvements ${num(s.improvements)}\n` +
      `  needleHits/probes ${pct(s.needleHits, s.probes)}` +
      `  extends/probes ${pct(s.extends, s.probes)}\n` +
      `  exit patience(after hit) ${pct(s.exitPatience, exits)}` +
      `  nullPatience ${pct(s.exitNullPatience, exits)}\n` +
      `  exit chainLimit ${pct(s.exitChainLimit, exits)}` +
      `  minLen ${pct(s.exitMinLen, exits)}` +
      `  maxMatch ${pct(s.exitMaxMatch, exits)}` +
      `  noCandidate ${pct(s.exitNoCandidate, exits)}`,
  );

  console.log(
    "\n  ratio / Δsize / probes are deterministic. Δwork is probe count, not\n" +
      "  wall clock. For multi-variant size A/B: pnpm bench:ab --suite nearby\n",
  );
}

if (!WANT_SWEEP) {
  console.log("  (pass --sweep for nearby levers, or pnpm bench:ab --suite patience)\n");
}
