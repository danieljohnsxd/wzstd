/**
 * Round-trip whatever is in `extra-bench-data/` — **opt-in**, via
 * `pnpm test --extra` or `pnpm test --extra-only` (sets `WZSTD_TEST_EXTRA=1`).
 *
 * On this machine that is multi-megabyte GeoJSONL district bundles: many blocks
 * per frame, very long lines, dense digit runs, and a narrow alphabet — a shape
 * the synthetic corpus does not produce. On someone else's it is their data, and
 * the value is the same either way: real files find frame shapes fixtures do not.
 *
 * **Why the default `pnpm test` does not run this.** That directory is defined
 * as *whatever the user put there*, so running it by default makes the
 * correctness suite depend on data the repo has never seen: the same command
 * means different things on two machines, the run time is whatever the files
 * happen to weigh, and a failure may be a bug or may be one odd input. It is
 * also the part of the suite that drives `zstd -19` through `spawnSync`, which
 * is how the runner has been wedged before. Default stays hermetic and fast;
 * this is one flag away.
 *
 * **Run it before shipping any format change** — literal framing, weight
 * headers, sequence tables, window handling. That is exactly where fixture-only
 * coverage has missed things.
 *
 * Skipped rather than failed when the directory is absent, so `pnpm test
 * --extra` on a fresh clone is a no-op rather than an error. The benches take
 * the opposite line and error when asked for a corpus they cannot find: a test
 * with nothing to check has nothing to report, while a bench would print the
 * wrong corpus under the heading you asked for.
 *
 * **Round-trip is always on.** Ratio-direction and multi-block asserts only run
 * when the inventory looks compressible / large enough — the directory is a
 * generic slot for any user data, including already-compressed or tiny files.
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { decompress as zripDecompress } from "@paddor/zrip";
import { compressFast } from "../dist/compressFast.js";
import { compressStrong } from "../dist/compressStrong.js";
import { compressUltra } from "../dist/compressUltra.js";
import { decompress } from "../dist/decompress.js";
import {
  externalCorpusDir,
  externalPayloads,
  hasExternalCorpus,
} from "./helpers/external_corpus.ts";
import { walkBlocks } from "./helpers/frame.ts";
import { ensureZrip } from "./helpers/zrip_init.ts";
import { hasZstdCli, zstdDecompress } from "./helpers/zstd_cli.ts";

/** Cap per payload so the suite stays quick; still spans many blocks when large. */
const MAX_BYTES = 1_500_000;

/** Opt-in: `pnpm test --extra` / `--extra-only`. See the header. */
const WANTED = process.env["WZSTD_TEST_EXTRA"] === "1";
const RUN = WANTED && hasExternalCorpus();

describe(
  "external corpus (extra-bench-data/)",
  {
    skip: RUN
      ? false
      : WANTED
        ? `no non-empty files in ${externalCorpusDir()}`
        : "opt-in: pnpm test --extra (or --extra-only)",
  },
  () => {
    // Only pay zrip init when this suite actually runs — hermetic `pnpm test`
    // used to hit ensureZrip here even while every test was skipped.
    before(async () => {
      await ensureZrip();
    });

    const payloads = RUN ? externalPayloads(MAX_BYTES) : [];

    test("corpus is present and non-trivial", () => {
      assert.ok(payloads.length > 0, `expected files in ${externalCorpusDir()}`);
    });

    for (const payload of payloads) {
      test(`${payload.name}: round-trips through every decoder`, () => {
        for (const [label, compress] of [
          ["Fast", compressFast],
          ["Strong", compressStrong],
          ["Ultra", compressUltra],
        ] as const) {
          const frame = compress(payload.data);
          // User files may exceed the 64 MiB default output cap.
          assert.deepEqual(
            decompress(frame, { maxSize: Infinity }),
            payload.data,
            `${payload.name} ${label} wzstd`,
          );
          assert.deepEqual(zripDecompress(frame), payload.data, `${payload.name} ${label} zrip`);
          if (hasZstdCli()) {
            assert.deepEqual(
              zstdDecompress(frame),
              payload.data,
              `${payload.name} ${label} zstd-cli`,
            );
          }
        }
      });
    }

    /**
     * Ratio-direction only when L3 actually shrinks the payload. Already-
     * compressed or high-entropy user data is a valid corpus for round-trip
     * and must not fail because neither level found a match.
     */
    const compressible = payloads.filter((p) => compressStrong(p.data).length < p.data.length);

    test(
      "Strong beats Fast on total compressible bytes",
      { skip: compressible.length === 0 ? "no compressible payloads" : false },
      () => {
        // Per-file L3 < Fast is not guaranteed: Fast's raw 8-bit match pricing
        // can win individual shapes. The product claim is Strong wins on
        // the corpus total.
        let l1 = 0;
        let l3 = 0;
        for (const payload of compressible) {
          l1 += compressFast(payload.data).length;
          l3 += compressStrong(payload.data).length;
        }
        assert.ok(l3 < l1, `Strong total (${l3}) should beat Fast total (${l1})`);
      },
    );

    test(
      "Ultra not worse than L3 on compressible payloads",
      { skip: compressible.length === 0 ? "no compressible payloads" : false },
      () => {
        for (const payload of compressible) {
          const l3 = compressStrong(payload.data).length;
          const ultra = compressUltra(payload.data).length;
          assert.ok(ultra <= l3, `${payload.name}: Ultra (${ultra}) should be ≤ L3 (${l3})`);
        }
      },
    );

    test(
      "frames span multiple blocks",
      {
        // Anything over 128 KiB must produce more than one block; this is the
        // only corpus that exercises cross-block reps and hash-chain continuity
        // at size. All-small inventories skip rather than fail.
        skip:
          payloads.filter((p) => p.data.length > 400_000).length === 0
            ? "no multi-block-sized payloads"
            : false,
      },
      () => {
        const large = payloads.filter((p) => p.data.length > 400_000);
        for (const payload of large) {
          const blocks = walkBlocks(compressStrong(payload.data)).length;
          assert.ok(blocks > 1, `${payload.name}: expected multiple blocks, got ${blocks}`);
        }
      },
    );
  },
);
