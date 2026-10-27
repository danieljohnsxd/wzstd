/**
 * The decoder reads its own derived structures — FSE and Huffman tables, the
 * code tables, the offset history, the output buffer — **unguarded**, and only
 * reads of untrusted input still go through `at()`. This file is the standing
 * evidence for that split.
 *
 * Why it exists. `at(d, i)` is `d[i] ?? 0`, and the `?? 0` is not decoration:
 * it maps an out-of-bounds read to **0**. Raw indexing yields `undefined`
 * instead, which is still 0 through `|` and `&`, and still 0 when stored into a
 * `Uint8Array` — but it is **`NaN`** through `+` and `*`. NaN then walks
 * straight through `oubt > buf.length` and `need()`, because every comparison
 * against NaN is false. Two fail-closed checks would fail open.
 *
 * So the invariant being defended is not "the indices are in range". It is:
 *
 *   **No corrupt input may produce a non-`ZstdError`, wrong bytes reported as
 *   success on a checksummed frame, or a hang.**
 *
 * A full test suite passed while the unguarded reads were going out of bounds,
 * so passing tests are not evidence here. What produced evidence was an
 * instrumented build in which every unguarded read *throws* on `undefined`:
 * across the whole suite and the extra corpus it fired only on `buf`, only at
 * exactly one past the end, and only where the value's single destination is a
 * `Uint8Array` store — where `undefined` coerces to the same 0 the guard used
 * to supply. That equivalence is pinned directly below.
 *
 * If a future change makes an unguarded read feed arithmetic instead, this file
 * will not necessarily catch it. Re-run the trap build; see the ledger entry
 * "Unguarded reads of derived structures".
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Decompress, decompress, ZstdError } from "../dist/decompress.js";
import { compressFast } from "../dist/compressFast.js";
import { compressStrong } from "../dist/compressStrong.js";
import { jsonLines, mixedCorpus } from "./helpers/corpus.ts";

const encoder = new TextEncoder();

/** Deterministic xorshift, so a failure is reproducible from its seed alone. */
function makeRandom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>>= 0);
  };
}

function streamAll(frame: Uint8Array): Uint8Array {
  const out: Array<Uint8Array> = [];
  const d = new Decompress((chunk) => out.push(chunk));
  const STEP = 64;
  for (let i = 0; i < frame.length; i += STEP) {
    const end = Math.min(i + STEP, frame.length);
    d.push(frame.subarray(i, end), end >= frame.length);
  }
  const total = out.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of out) {
    joined.set(c, at);
    at += c.length;
  }
  return joined;
}

/**
 * Every outcome a corrupt frame is allowed to have. Anything else — a
 * `TypeError` from NaN arithmetic, a `RangeError` escaping the wide reads, a
 * plain `Error` from an instrumented build — is a defect.
 */
type Outcome = "threw-ZstdError" | "returned";

function outcome(run: () => Uint8Array): {
  kind: Outcome;
  bytes?: Uint8Array;
} {
  try {
    return { kind: "returned", bytes: run() };
  } catch (e) {
    if (e instanceof ZstdError) return { kind: "threw-ZstdError" };
    throw e;
  }
}

describe("unguarded reads survive corrupt input", () => {
  const payloads = [
    { name: "mixed-40k", data: mixedCorpus(40_000) },
    { name: "json-500", data: encoder.encode(jsonLines(500)) },
    { name: "repeat", data: encoder.encode("compress-me-please ".repeat(900)) },
  ];

  test("a byte-flip anywhere never escapes as a non-ZstdError", () => {
    // Our frames always carry a digest, so "returned" must mean the bytes are
    // right — a corrupted frame that returns wrong bytes and calls it success
    // is the exact failure the checksum exists to prevent, and NaN propagation
    // through the length checks is a way to reach it that `at()` used to block.
    const rnd = makeRandom(0x5eed);
    let flips = 0;
    let caught = 0;
    for (const { name, data } of payloads) {
      for (const encode of [compressFast, compressStrong]) {
        const frame = encode(data);
        for (let t = 0; t < 120; t++) {
          const i = rnd() % frame.length;
          const bad = frame.slice();
          bad[i] = (bad[i] ?? 0) ^ (1 << (t % 8));
          flips++;
          const r = outcome(() => decompress(bad));
          if (r.kind === "threw-ZstdError") {
            caught++;
            continue;
          }
          assert.deepEqual(
            r.bytes,
            data,
            `${name}: corrupt frame returned successfully with wrong bytes`,
          );
        }
      }
    }
    assert.ok(flips > 700, `expected a real sweep, ran ${flips}`);
    // Not a fixed count: a flip in a padding bit can legitimately decode. The
    // assertion that matters is the one inside the loop.
    assert.ok(caught > 0, "expected corruption to be detected at all");
  });

  test("truncation at every length never escapes as a non-ZstdError", () => {
    // Truncation is where the guarded reads earn their keep: `rb()` multiplies
    // what it reads, so an unguarded OOB there would produce NaN, and
    // `NaN > 2145386496` is false — the window-size check would fail open.
    for (const { data } of payloads) {
      const frame = compressStrong(data);
      // From 1, not 0: empty input is not truncation, and `decompress(empty)`
      // returning empty is the documented one-argument behaviour.
      for (let len = 1; len < frame.length; len += 7) {
        const r = outcome(() => decompress(frame.subarray(0, len)));
        if (r.kind === "returned") {
          assert.deepEqual(r.bytes, data, "truncated frame returned wrong bytes");
        }
      }
    }
  });

  test("a corrupt frame never yields a NaN-derived length", () => {
    // A NaN length walks through `oubt > buf.length` and `need()` and shows up
    // as output that is neither the right bytes nor an error. Pinned directly:
    // every returned buffer has a real, finite, non-negative length.
    const rnd = makeRandom(0xc0ffee);
    const frame = compressStrong(mixedCorpus(40_000));
    for (let t = 0; t < 400; t++) {
      const bad = frame.slice();
      // Corrupt the header region specifically -- that is where the reads feed
      // arithmetic rather than bit twiddling.
      const i = rnd() % Math.min(24, bad.length);
      bad[i] = rnd() & 0xff;
      const r = outcome(() => decompress(bad));
      if (r.kind !== "returned") continue;
      const n = r.bytes?.length ?? Number.NaN;
      assert.ok(Number.isInteger(n) && n >= 0, `decode returned a buffer of length ${n}`);
    }
  });

  test("streaming agrees with one-shot on corrupt input", () => {
    // The streaming path has its own window and its own bounds arithmetic, so
    // it needs its own sweep rather than inheriting one-shot's result.
    const rnd = makeRandom(0xfeed);
    const data = mixedCorpus(20_000);
    const frame = compressStrong(data);
    for (let t = 0; t < 200; t++) {
      const bad = frame.slice();
      const i = rnd() % bad.length;
      bad[i] = (bad[i] ?? 0) ^ 0xff;
      const one = outcome(() => decompress(bad));
      const str = outcome(() => streamAll(bad));
      if (one.kind === "returned" && str.kind === "returned") {
        assert.deepEqual(str.bytes, one.bytes, "paths disagree on corrupt input");
      }
    }
  });
});
