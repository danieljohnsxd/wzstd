/**
 * Test runner: hermetic by default; `--extra` / `--extra-only` opt into the
 * user's corpus the same way the benches do.
 *
 * ```
 *   pnpm test                  # synthetic fixtures only (hermetic)
 *   pnpm test --extra          # + round-trip extra-bench-data/
 *   pnpm test --extra-only     # extra corpus alone
 *   pnpm test -- --test-name-pattern foo   # forward node --test flags after --
 * ```
 *
 * Asking for the extra corpus when it is missing is a skip inside the external
 * suite (nothing to check), not a hard error — benches take the opposite line
 * because a silent fallback would print the wrong numbers under the flag.
 *
 * Our flags are stripped; everything after a bare `--`, and any other unknown
 * tokens, is forwarded to `node --test` so name patterns and reporters still
 * work.
 */
import { spawnSync } from "node:child_process";

const raw = process.argv.slice(2);
const ours: Array<string> = [];
const forwarded: Array<string> = [];
let afterDash = false;
for (const arg of raw) {
  if (afterDash) {
    forwarded.push(arg);
    continue;
  }
  if (arg === "--") {
    afterDash = true;
    continue;
  }
  if (arg === "--extra" || arg === "--extra-only") {
    ours.push(arg);
    continue;
  }
  // Anything else is a node --test option / pattern.
  forwarded.push(arg);
}

const wantBoth = ours.includes("--extra");
const wantOnly = ours.includes("--extra-only");
if (wantBoth && wantOnly) {
  throw new Error("--extra and --extra-only contradict; pass one");
}

const wantExtra = wantBoth || wantOnly;
const env = { ...process.env };
// Always pin the env from CLI intent: a leftover export must not make plain
// `pnpm test` non-hermetic.
if (wantExtra) env["WZSTD_TEST_EXTRA"] = "1";
else delete env["WZSTD_TEST_EXTRA"];

/**
 * `--extra-only` runs just the external suite so a real-data check does not
 * re-pay the full hermetic matrix. Default and `--extra` keep the glob that
 * `pnpm test` has always used.
 */
const files = wantOnly ? ["tests/external_corpus_test.ts"] : ["tests/**/*.ts"];

const run = spawnSync(process.execPath, ["--test", ...forwarded, ...files], {
  stdio: "inherit",
  env,
});
process.exit(run.status === null ? 1 : run.status);
