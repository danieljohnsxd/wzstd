/**
 * Frames without Frame_Content_Size.
 *
 * One-shot `compressFast` / `compressStrong` / `compressUltra` still emit FCS.
 * `CompressFast` / `CompressStrong` emit the pipe shape (no FCS, explicit
 * window). Foreign producers (`zstd` reading a pipe) do the same. Rejecting
 * no-FCS would be a regression: without FCS, one-shot `decompress` grows the
 * output by doubling and uses that buffer as match history.
 *
 * Hermetic coverage uses `CompressFast`. CLI-from-pipe cases skip when `zstd`
 * is absent.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CompressFast } from "../dist/compressFast.js";
import { decompress } from "../dist/decompress.js";
import { hasZstdCli, zstdCompress } from "./helpers/zstd_cli.ts";

const CLI = hasZstdCli();

/** Frame_Content_Size is present iff frame_content_flag or single_segment is set. */
function hasFcs(frame: Uint8Array): boolean {
  const flg = frame[4] ?? 0;
  return flg >> 6 !== 0 || ((flg >> 5) & 1) !== 0;
}

/** Deterministic, compressible-but-not-trivial bytes. */
function payload(n: number): Uint8Array {
  const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
  const parts: Array<string> = [];
  let total = 0;
  for (let i = 0; total < n; i++) {
    const line = `{"id":${i},"name":"${words[i % words.length]}","v":${(i * 2654435761) % 100000}}\n`;
    parts.push(line);
    total += line.length;
  }
  return new TextEncoder().encode(parts.join("")).subarray(0, n);
}

function streamFast(src: Uint8Array): Uint8Array {
  const parts: Array<Uint8Array> = [];
  const enc = new CompressFast((chunk: Uint8Array) => {
    if (chunk.length > 0) parts.push(chunk.slice());
  });
  enc.push(src, true);
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("decode: own streaming frames omit FCS", () => {
  test("CompressFast frames really do omit FCS", () => {
    const frame = streamFast(payload(50_000));
    assert.equal(hasFcs(frame), false);
    assert.deepEqual(decompress(frame), payload(50_000));
  });

  test("one-shot decompress grows through a multi-block streaming frame", () => {
    const src = payload(400_000);
    const frame = streamFast(src);
    assert.equal(hasFcs(frame), false);
    assert.deepEqual(decompress(frame), src);
  });
});

describe("decode: frames without frame content size", { skip: !CLI }, () => {
  test("CLI-from-pipe frames really do omit FCS", () => {
    // Guards the premise: if this ever stops holding, the tests below silently
    // stop covering the growing-buffer path.
    const frame = zstdCompress(payload(50_000), 3);
    assert.equal(hasFcs(frame), false, "expected `zstd` reading stdin to omit FCS");
  });

  // Spans the initial buffer (2 x block size = 256 KiB) several times over, so
  // the doubling path runs repeatedly, at both a small and a large window.
  for (const level of [3, 19]) {
    for (const size of [1_500_000, 300_000, 5_000]) {
      test(`level ${level}, ${size} B round-trips exactly`, () => {
        const src = payload(size);
        const frame = zstdCompress(src, level);
        assert.equal(hasFcs(frame), false);
        assert.deepEqual(decompress(frame), src);
      });
    }
  }

  test("multi-block growth preserves match history across block boundaries", () => {
    // Long-range repeats force backreferences that reach into earlier blocks,
    // which is what breaks if the grown buffer is not used as its own history.
    const unit = payload(200_000);
    const src = new Uint8Array(unit.length * 5);
    for (let i = 0; i < 5; i++) src.set(unit, unit.length * i);
    for (const level of [3, 19]) {
      const frame = zstdCompress(src, level);
      assert.equal(hasFcs(frame), false);
      assert.deepEqual(decompress(frame), src, `level ${level}`);
    }
  });

  test("multi-frame input concatenates", () => {
    const a = payload(300_000);
    const b = payload(9_000);
    const fa = zstdCompress(a, 3);
    const fb = zstdCompress(b, 19);
    const joined = new Uint8Array(fa.length + fb.length);
    joined.set(fa, 0);
    joined.set(fb, fa.length);
    const expected = new Uint8Array(a.length + b.length);
    expected.set(a, 0);
    expected.set(b, a.length);
    assert.deepEqual(decompress(joined), expected);
  });

  test("empty input round-trips", () => {
    const frame = zstdCompress(new Uint8Array(0), 3);
    assert.deepEqual(decompress(frame), new Uint8Array(0));
  });

  test("matches the FCS-present decode of the same bytes", () => {
    // Same data, same level, both header forms — the two paths must agree.
    const src = payload(400_000);
    const noFcs = zstdCompress(src, 3);
    const withFcs = zstdCompress(src, 3, true);
    assert.equal(hasFcs(noFcs), false);
    assert.equal(hasFcs(withFcs), true);
    assert.deepEqual(decompress(noFcs), decompress(withFcs));
    assert.deepEqual(decompress(noFcs), src);
  });
});
