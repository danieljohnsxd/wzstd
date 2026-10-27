/**
 * Encode A/B engine: size (+ optional probe stats) for MatcherConfig variants.
 *
 * One `pnpm build`, then many comparisons — no ad-hoc one-off scripts.
 * Used by `scripts/ab_encode.ts` and the ultra-lever suite.
 */
import { FAST_CONFIG, compressFastWithConfig } from "../../dist/compressFast.js";
import {
  STRONG_CONFIG,
  compressStrongWithConfig,
  type MatcherConfig,
  type MatchStats,
  withMatchStats,
} from "../../dist/compressStrong.js";
import { ULTRA_CONFIG, compressUltraWithConfig } from "../../dist/compressUltra.js";
import type { Payload } from "../../tests/helpers/corpus.ts";
import { addStats, emptyStats, num, pct } from "./match_stats_util.ts";
import { createProgress } from "./progress.ts";

export type AbBase = "fast" | "strong" | "ultra";

export type AbVariant = {
  name: string;
  config: MatcherConfig;
};

type AbDelta = {
  variant: string;
  payload: string;
  relPct: number;
  baseSize: number;
  size: number;
};

function compareDeltaWorse(a: AbDelta, b: AbDelta): number {
  return b.relPct - a.relPct;
}

function compareDeltaBetter(a: AbDelta, b: AbDelta): number {
  return a.relPct - b.relPct;
}

export type AbPayloadResult = {
  name: string;
  raw: number;
  /** Compressed size per variant, same order as the variants list. */
  sizes: Array<number>;
};

export type AbVariantTotal = {
  name: string;
  size: number;
  ratio: number;
  /** vs first variant (baseline): size / base.size */
  vsBase: number;
  /** equal-weight mean of per-payload ratios */
  eqMeanRatio: number;
  stats: MatchStats | null;
  /** payload counts relative to baseline size */
  better: number;
  worse: number;
  identical: number;
};

export type AbReport = {
  baseName: string;
  raw: number;
  payloads: number;
  variants: Array<AbVariantTotal>;
  /** Top relative regressions for each non-base variant (name, payload, rel%). */
  topWorse: Array<{
    variant: string;
    payload: string;
    relPct: number;
    baseSize: number;
    size: number;
  }>;
  topBetter: Array<{
    variant: string;
    payload: string;
    relPct: number;
    baseSize: number;
    size: number;
  }>;
  perPayload: Array<AbPayloadResult>;
};

const KNOWN_KEYS = [
  "chainLimit",
  "patience",
  "nullPatience",
  "lazyDepth",
  "preferRepOffsets",
  "huffmanLiterals",
  "offsetSurcharge16",
  "offsetSurchargeFrom",
  "windowSize",
  "hashBits",
  "rowBits",
  "probeReps",
  "longHashBits",
  "longChainLimit",
  "primaryHashBytes",
  "longHashOnlyIfShort",
  "optimalParse",
  "binaryTree",
  "searchSkipShift",
] as const;

function parseBool(raw: string, key: string): boolean {
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${key} expects true/false, got ${raw}`);
}

function parseNum(raw: string, key: string): number {
  const lower = raw.toLowerCase();
  let n: number;
  if (key === "windowSize" && /m(ib)?$/.test(lower)) {
    n = Math.round(Number.parseFloat(lower) * 1024 * 1024);
  } else if (key === "windowSize" && /k(ib)?$/.test(lower)) {
    n = Math.round(Number.parseFloat(lower) * 1024);
  } else {
    n = Number(raw);
  }
  if (!Number.isFinite(n)) {
    throw new Error(`${key} expects a number, got ${raw}`);
  }
  return n;
}

/** Clone Fast, Strong, or Ultra shipped config. */
export function baseConfig(base: AbBase = "strong"): MatcherConfig {
  if (base === "fast") return { ...FAST_CONFIG };
  return base === "ultra" ? { ...ULTRA_CONFIG } : { ...STRONG_CONFIG };
}

function cloneStrong(): MatcherConfig {
  return { ...STRONG_CONFIG };
}

/**
 * Parse `key:value` overrides into a Partial config.
 * Numbers as decimal; booleans as true/false; `windowSize` may use `8m` / `2mib`.
 */
export function parseOverride(spec: string): Partial<MatcherConfig> {
  const colon = spec.indexOf(":");
  if (colon <= 0) {
    throw new Error(
      `override must be key:value (got ${JSON.stringify(spec)}); ` +
        `examples: patience:1 nullPatience:12 longHashBits:17 windowSize:8m`,
    );
  }
  const key = spec.slice(0, colon);
  const raw = spec.slice(colon + 1);
  switch (key) {
    case "chainLimit":
      return { chainLimit: parseNum(raw, key) };
    case "patience":
      return { patience: parseNum(raw, key) };
    case "nullPatience":
      return { nullPatience: parseNum(raw, key) };
    case "lazyDepth":
      return { lazyDepth: parseNum(raw, key) };
    case "preferRepOffsets":
      return { preferRepOffsets: parseBool(raw, key) };
    case "huffmanLiterals":
      return { huffmanLiterals: parseBool(raw, key) };
    case "offsetSurcharge16":
      return { offsetSurcharge16: parseNum(raw, key) };
    case "offsetSurchargeFrom":
      return { offsetSurchargeFrom: parseNum(raw, key) };
    case "windowSize":
      return { windowSize: parseNum(raw, key) };
    case "hashBits":
      return { hashBits: parseNum(raw, key) };
    case "rowBits":
      return { rowBits: parseNum(raw, key) };
    case "probeReps":
      return { probeReps: parseBool(raw, key) };
    case "longHashBits":
      return { longHashBits: parseNum(raw, key) };
    case "longChainLimit":
      return { longChainLimit: parseNum(raw, key) };
    case "primaryHashBytes": {
      const n = parseNum(raw, key);
      if (n !== 4 && n !== 8) {
        throw new Error("primaryHashBytes must be 4 or 8");
      }
      return { primaryHashBytes: n };
    }
    case "longHashOnlyIfShort":
      return { longHashOnlyIfShort: parseBool(raw, key) };
    case "optimalParse":
      return { optimalParse: parseBool(raw, key) };
    case "binaryTree":
      return { binaryTree: parseBool(raw, key) };
    case "searchSkipShift":
      return { searchSkipShift: parseNum(raw, key) };
    default:
      throw new Error(
        `unknown MatcherConfig key ${JSON.stringify(key)}; known: ${KNOWN_KEYS.join(" ")}`,
      );
  }
}

/** Apply one or more `key:value` specs onto a base config. */
export function configFromOverrides(specs: Array<string>, base: AbBase = "strong"): MatcherConfig {
  const cfg = baseConfig(base);
  for (const s of specs) {
    Object.assign(cfg, parseOverride(s));
  }
  return cfg;
}

/**
 * Named preset suites. First entry is always the baseline for vs- columns.
 */
export function suiteVariants(name: string, base: AbBase = "strong"): Array<AbVariant> {
  const b = () => baseConfig(base);
  const MiB = 1024 * 1024;

  switch (name) {
    case "patience":
      return [
        { name: "shipped", config: b() },
        { name: "patience 1 (first-hit)", config: { ...b(), patience: 1 } },
        { name: "patience 3", config: { ...b(), patience: 3 } },
        { name: "nullPat 12", config: { ...b(), nullPatience: 12 } },
        { name: "nullPat 24", config: { ...b(), nullPatience: 24 } },
        {
          name: "nullPat 12 + pat1",
          config: { ...b(), nullPatience: 12, patience: 1 },
        },
        { name: "lazy 3", config: { ...b(), lazyDepth: 3 } },
      ];
    case "nearby":
      return [
        { name: "shipped", config: b() },
        { name: "patience 1 (first-hit)", config: { ...b(), patience: 1 } },
        { name: "patience 3", config: { ...b(), patience: 3 } },
        { name: "lazyDepth 2", config: { ...b(), lazyDepth: 2 } },
        { name: "lazyDepth 1", config: { ...b(), lazyDepth: 1 } },
        { name: "chainLimit 24", config: { ...b(), chainLimit: 24 } },
        { name: "chainLimit 16", config: { ...b(), chainLimit: 16 } },
        { name: "nullPatience 10", config: { ...b(), nullPatience: 10 } },
        { name: "nullPatience 16", config: { ...b(), nullPatience: 16 } },
      ];
    case "ultra-levers":
      // Historical Ultra dissection; baseline = Strong primary, not Ultra.
      return [
        { name: "Strong (baseline)", config: cloneStrong() },
        {
          name: "prim8 only",
          config: { ...cloneStrong(), primaryHashBytes: 8 },
        },
        {
          name: "lh bits17 lim32",
          config: {
            ...cloneStrong(),
            longHashBits: 17,
            longChainLimit: 32,
          },
        },
        {
          name: "lh bits17 lim16",
          config: {
            ...cloneStrong(),
            longHashBits: 17,
            longChainLimit: 16,
          },
        },
        {
          name: "lh bits17 lim8",
          config: {
            ...cloneStrong(),
            longHashBits: 17,
            longChainLimit: 8,
          },
        },
        {
          name: "lh bits17 lim4",
          config: {
            ...cloneStrong(),
            longHashBits: 17,
            longChainLimit: 4,
          },
        },
        {
          name: "lh bits15 lim8",
          config: {
            ...cloneStrong(),
            longHashBits: 15,
            longChainLimit: 8,
          },
        },
        {
          name: "lh lim32 adaptive",
          config: {
            ...cloneStrong(),
            longHashBits: 17,
            longChainLimit: 32,
            longHashOnlyIfShort: true,
          },
        },
        {
          name: "win8 only",
          config: { ...cloneStrong(), windowSize: 8 * MiB },
        },
        {
          name: "lh lim4 + win8",
          config: {
            ...cloneStrong(),
            longHashBits: 17,
            longChainLimit: 4,
            windowSize: 8 * MiB,
          },
        },
        {
          name: "nullPat 24",
          config: { ...cloneStrong(), nullPatience: 24 },
        },
        {
          name: "nullPat 48",
          config: { ...cloneStrong(), nullPatience: 48 },
        },
        { name: "lazy 0", config: { ...cloneStrong(), lazyDepth: 0 } },
        { name: "lazy 3", config: { ...cloneStrong(), lazyDepth: 3 } },
        {
          name: "BT only",
          config: { ...cloneStrong(), binaryTree: true },
        },
        {
          name: "Ultra-shaped lim4+win8",
          config: {
            ...cloneStrong(),
            windowSize: 8 * MiB,
            longHashBits: 17,
            longChainLimit: 4,
          },
        },
      ];
    default:
      throw new Error(
        `unknown suite ${JSON.stringify(name)}; known: patience, nearby, ultra-levers`,
      );
  }
}

function encodeWith(base: AbBase, data: Uint8Array, config: MatcherConfig): Uint8Array {
  if (base === "fast") return compressFastWithConfig(data, config);
  return base === "ultra"
    ? compressUltraWithConfig(data, config)
    : compressStrongWithConfig(data, config);
}

/**
 * Run every variant over every payload. When `withStats`, wraps each encode in
 * `withMatchStats` (slower; deterministic probe counts).
 */
export function runAb(opts: {
  payloads: Array<Payload>;
  variants: Array<AbVariant>;
  base: AbBase;
  withStats: boolean;
  /** Max relative-size deltas to keep per side. */
  topN?: number;
}): AbReport {
  const { payloads, variants, base, withStats } = opts;
  const topN = opts.topN ?? 12;
  if (variants.length === 0) {
    throw new Error("runAb: need at least one variant");
  }

  const whole = payloads.filter((p) => p.data.length > 0);
  const raw = whole.reduce((s, p) => s + p.data.length, 0);
  const nVar = variants.length;
  const sizes: Array<Array<number>> = variants.map(() => []);
  const totals = variants.map(() => 0);
  const statsAcc: Array<MatchStats | null> = variants.map(() => (withStats ? emptyStats() : null));

  const progress = createProgress(whole.length * nVar);
  const perPayload: Array<AbPayloadResult> = [];

  for (const p of whole) {
    const rowSizes: Array<number> = [];
    for (let vi = 0; vi < nVar; vi++) {
      const v = variants[vi];
      if (v === undefined) continue;
      let frame: Uint8Array;
      if (withStats) {
        const { value, stats } = withMatchStats(() => encodeWith(base, p.data, v.config));
        frame = value;
        const acc = statsAcc[vi];
        if (acc !== null && acc !== undefined) addStats(acc, stats);
      } else {
        frame = encodeWith(base, p.data, v.config);
      }
      rowSizes.push(frame.length);
      totals[vi] = (totals[vi] ?? 0) + frame.length;
      sizes[vi]?.push(frame.length);
      progress.tick(`${v.name} ${p.name}`);
    }
    perPayload.push({ name: p.name, raw: p.data.length, sizes: rowSizes });
  }

  const baseTotal = totals[0] ?? 0;
  const baseSizes = sizes[0] ?? [];
  const variantTotals: Array<AbVariantTotal> = [];
  const topWorse: AbReport["topWorse"] = [];
  const topBetter: AbReport["topBetter"] = [];

  for (let vi = 0; vi < nVar; vi++) {
    const v = variants[vi];
    if (v === undefined) continue;
    const size = totals[vi] ?? 0;
    const eqMean =
      whole.length === 0
        ? 0
        : perPayload.reduce((s, r) => s + (r.sizes[vi] ?? 0) / r.raw, 0) / whole.length;
    let better = 0;
    let worse = 0;
    let identical = 0;
    if (vi === 0) {
      identical = whole.length;
    } else {
      for (let pi = 0; pi < whole.length; pi++) {
        const a = baseSizes[pi] ?? 0;
        const b = sizes[vi]?.[pi] ?? 0;
        if (b < a) better++;
        else if (b > a) worse++;
        else identical++;
        const rel = a === 0 ? 0 : ((b - a) / a) * 100;
        const entry = {
          variant: v.name,
          payload: whole[pi]?.name ?? "?",
          relPct: rel,
          baseSize: a,
          size: b,
        };
        if (rel > 0) topWorse.push(entry);
        if (rel < 0) topBetter.push(entry);
      }
    }
    variantTotals.push({
      name: v.name,
      size,
      ratio: raw === 0 ? 0 : size / raw,
      vsBase: baseTotal === 0 ? 1 : size / baseTotal,
      eqMeanRatio: eqMean,
      stats: statsAcc[vi] ?? null,
      better,
      worse,
      identical,
    });
  }

  // Copy then sort: target lib is ES2022 (no Array#toSorted in types).
  const worseSorted = topWorse.slice();
  worseSorted.sort(compareDeltaWorse);
  const betterSorted = topBetter.slice();
  betterSorted.sort(compareDeltaBetter);

  return {
    baseName: variants[0]?.name ?? "baseline",
    raw,
    payloads: whole.length,
    variants: variantTotals,
    topWorse: worseSorted.slice(0, topN),
    topBetter: betterSorted.slice(0, topN),
    perPayload,
  };
}

/** Pretty-print an {@link AbReport}. */
export function printAbReport(report: AbReport, label: string): void {
  console.log(
    `\n${"=".repeat(72)}\n== ${label} — ${report.payloads} payloads, ${num(report.raw)} B raw\n` +
      `== baseline: ${report.baseName}\n${"=".repeat(72)}\n`,
  );

  const hasStats = report.variants.some((v) => v.stats !== null);
  const head =
    "variant".padEnd(28) +
    "size".padStart(12) +
    "ratio".padStart(8) +
    "eqMean".padStart(8) +
    "vsBase".padStart(8) +
    " +/−/=".padStart(12) +
    (hasStats ? "probes".padStart(14) + "Δprb".padStart(8) : "");
  console.log(head);
  console.log("-".repeat(head.length));

  const baseProbes = report.variants[0]?.stats?.probes ?? 0;
  for (const v of report.variants) {
    const delta =
      v.name === report.baseName ? "  (base)" : ` ${v.better}/${v.worse}/${v.identical}`;
    let line =
      v.name.padEnd(28) +
      num(v.size).padStart(12) +
      v.ratio.toFixed(4).padStart(8) +
      v.eqMeanRatio.toFixed(4).padStart(8) +
      v.vsBase.toFixed(3).padStart(8) +
      delta.padStart(12);
    if (hasStats && v.stats !== null) {
      const dPrb =
        baseProbes === 0 ? "—" : `${((v.stats.probes / baseProbes - 1) * 100).toFixed(1)}%`;
      line += num(v.stats.probes).padStart(14) + dPrb.padStart(8);
    }
    console.log(line);
  }

  if (report.topBetter.length > 0) {
    console.log("\n--- biggest size wins vs baseline (rel %) ---");
    for (const e of report.topBetter) {
      console.log(
        `  ${e.variant.padEnd(22)} ${e.payload.padEnd(22)} ${e.relPct.toFixed(2).padStart(8)}%  ${e.baseSize}→${e.size}`,
      );
    }
  }
  if (report.topWorse.length > 0) {
    console.log("\n--- biggest size losses vs baseline (rel %) ---");
    for (const e of report.topWorse) {
      console.log(
        `  ${e.variant.padEnd(22)} ${e.payload.padEnd(22)} +${e.relPct.toFixed(2).padStart(7)}%  ${e.baseSize}→${e.size}`,
      );
    }
  } else if (report.variants.length > 1) {
    console.log("\n  (no per-payload regressions vs baseline)");
  }

  const base = report.variants[0];
  if (base?.stats !== null && base?.stats !== undefined) {
    const s = base.stats;
    const exits =
      s.exitPatience +
      s.exitNullPatience +
      s.exitChainLimit +
      s.exitMinLen +
      s.exitMaxMatch +
      s.exitNoCandidate;
    console.log(`\n--- baseline walk exits (${base.name}) ---`);
    console.log(
      `  probes ${num(s.probes)}  searches ${num(s.searches)}` +
        `  hits ${num(s.hits)}  improvements ${num(s.improvements)}\n` +
        `  exit patience ${pct(s.exitPatience, exits)}` +
        `  nullPatience ${pct(s.exitNullPatience, exits)}` +
        `  chainLimit ${pct(s.exitChainLimit, exits)}`,
    );
  }

  console.log(
    "\n  size / ratio / probes are deterministic. vsBase is total compressed\n" +
      "  size ratio (not equal-weight). eqMean is mean of per-payload ratios.\n" +
      "  +/−/= counts payloads better / worse / identical vs baseline.\n",
  );
}
