/**
 * Ultra lever dissection — thin wrapper over the shared A/B harness.
 *
 * Prefer `pnpm bench:ab --suite ultra-levers` directly. This script stays so
 * old notes and muscle memory still work.
 *
 *   pnpm build && node scripts/ultra_lever_sweep.ts
 *   node scripts/ultra_lever_sweep.ts --limit 20
 *   node scripts/ultra_lever_sweep.ts --stats
 */
import { printAbReport, runAb, suiteVariants } from "./helpers/ab_encode.ts";
import { selectCorpora } from "./helpers/corpora.ts";

const { corpora, values } = selectCorpora({
  stats: { type: "boolean", default: true },
});
const WANT_STATS = values["stats"] !== false;

const variants = suiteVariants("ultra-levers", "strong");
console.log(
  `Ultra lever suite (${variants.length} variants, stats=${WANT_STATS})\n` +
    `  (same as: pnpm bench:ab --suite ultra-levers${WANT_STATS ? " --stats" : ""})`,
);

for (const corpus of corpora) {
  const report = runAb({
    payloads: corpus.payloads,
    variants,
    base: "strong",
    withStats: WANT_STATS,
    topN: 8,
  });
  printAbReport(report, corpus.label);
}
