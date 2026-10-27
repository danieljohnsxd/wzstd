/**
 * Encode A/B harness — size (and optional probe stats) over MatcherConfig variants.
 *
 * Prefer this over one-off node scripts. Build once, then compare freely:
 *
 * ```
 *   pnpm bench:ab --vs patience:1
 *   pnpm bench:ab --vs patience:1 --vs nullPatience:12 --stats
 *   pnpm bench:ab --suite patience
 *   pnpm bench:ab --suite ultra-levers --limit 15
 *   pnpm bench:ab --base ultra --vs longChainLimit:8
 *   pnpm bench:ab --only rep-friendly --vs patience:1 --stats
 *   pnpm bench:ab --extra --vs windowSize:2m
 * ```
 *
 * Overrides are `key:value` against Strong (or `--base fast|ultra`) shipped config.
 * Suites: `patience`, `nearby`, `ultra-levers`.
 *
 * Not isolated wall-clock — use `pnpm bench:encode` for speed claims.
 * Probes (`--stats`) are the right work metric for matcher levers.
 */
import {
  type AbBase,
  type AbVariant,
  baseConfig,
  configFromOverrides,
  printAbReport,
  runAb,
  suiteVariants,
} from "./helpers/ab_encode.ts";
import { selectCorpora } from "./helpers/corpora.ts";

const { corpora, values } = selectCorpora({
  stats: { type: "boolean", default: false },
  suite: { type: "string" },
  vs: { type: "string", multiple: true },
  base: { type: "string", default: "strong" },
  only: { type: "string" },
  top: { type: "string", default: "12" },
});

const WANT_STATS = values["stats"] === true;
const suite = typeof values["suite"] === "string" ? values["suite"] : undefined;
const only = typeof values["only"] === "string" ? values["only"].toLowerCase() : undefined;
const baseRaw = typeof values["base"] === "string" ? values["base"] : "strong";
if (baseRaw !== "fast" && baseRaw !== "strong" && baseRaw !== "ultra") {
  throw new Error(`--base must be fast, strong, or ultra, got ${baseRaw}`);
}
const base: AbBase = baseRaw;
const topN = Number(values["top"] ?? 12);
if (!Number.isFinite(topN) || topN < 0) {
  throw new Error(`--top must be a non-negative number`);
}

const vsList: Array<string> = [];
const rawVs = values["vs"];
if (Array.isArray(rawVs)) {
  for (const v of rawVs) {
    if (typeof v === "string") vsList.push(v);
  }
} else if (typeof rawVs === "string") {
  vsList.push(rawVs);
}

if (suite !== undefined && vsList.length > 0) {
  throw new Error("pass either --suite or --vs, not both");
}
if (suite === undefined && vsList.length === 0) {
  console.log(
    "Encode A/B harness. Examples:\n" +
      "  pnpm bench:ab --vs patience:1\n" +
      "  pnpm bench:ab --vs patience:1 --vs nullPatience:12 --stats\n" +
      "  pnpm bench:ab --suite patience\n" +
      "  pnpm bench:ab --suite ultra-levers --limit 15\n" +
      "  pnpm bench:ab --base fast --vs chainLimit:6\n" +
      "  pnpm bench:ab --base ultra --vs longChainLimit:8\n" +
      "  pnpm bench:ab --only rep-friendly --vs patience:1 --stats\n" +
      "Suites: patience | nearby | ultra-levers\n" +
      "Flags: --stats  --base fast|strong|ultra  --only <substr>  --top N\n" +
      "       --extra / --extra-only / --limit N  (shared corpus flags)\n",
  );
  process.exit(0);
}

const variants: Array<AbVariant> =
  suite !== undefined
    ? suiteVariants(suite, base)
    : [
        {
          name: `${base} shipped`,
          config: baseConfig(base),
        },
        ...vsList.map((spec) => {
          const parts = spec
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          return {
            name: parts.join(" + "),
            config: configFromOverrides(parts, base),
          };
        }),
      ];

console.log(
  `A/B encode — base=${base}  variants=${variants.length}  stats=${WANT_STATS}` +
    (suite !== undefined ? `  suite=${suite}` : "") +
    (only !== undefined ? `  only~=${only}` : ""),
);

for (const corpus of corpora) {
  let payloads = corpus.payloads;
  if (only !== undefined) {
    payloads = payloads.filter((p) => p.name.toLowerCase().includes(only));
    if (payloads.length === 0) {
      console.log(`\n(${corpus.label}: no payloads match --only ${only})`);
      continue;
    }
  }
  const report = runAb({
    payloads,
    variants,
    base,
    withStats: WANT_STATS,
    topN,
  });
  printAbReport(report, corpus.label);
}
