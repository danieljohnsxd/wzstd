/**
 * Frame header shape, and the window it declares.
 *
 * Single-segment frames declare `Window_Size = Frame_Content_Size`. That is
 * fine while the content fits our match window, but above it the frame tells
 * every decoder to reserve the whole payload for a window we never reach past
 * — and zstd's default decode limit is 2^27, so a single-segment frame over
 * 128 MiB is rejected outright. Frames larger than WINDOW_SIZE therefore carry
 * an explicit window descriptor instead.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CompressFast, compressFast } from "../dist/compressFast.js";
import { CompressStrong, compressStrong } from "../dist/compressStrong.js";
import { compressUltra } from "../dist/compressUltra.js";
import { decompress } from "../dist/decompress.js";
import { hasZstdCli, zstdDecompress } from "./helpers/zstd_cli.ts";

const CLI = hasZstdCli();

/**
 * Pinned deliberately rather than imported from `compress/shared` — the window
 * a frame declares is visible to every other decoder, so changing it is an
 * interop change that must fail here and be re-verified against zrip and the
 * host `zstd` CLI, not silently tracked.
 */
const WINDOW_SIZE = 1024 * 1024;
/** Ultra strategy window (see `src/compress/ultra.ts`). */
const ULTRA_WINDOW = 8 * 1024 * 1024;

type Header = {
  singleSegment: number;
  contentFlag: number;
  windowSize: number | undefined;
};

function readHeader(frame: Uint8Array): Header {
  assert.deepEqual([...frame.subarray(0, 4)], [0x28, 0xb5, 0x2f, 0xfd], "magic");
  const flg = frame[4] ?? 0;
  const singleSegment = (flg >> 5) & 1;
  // Reserved bit must be zero; dictionary ID must be absent.
  assert.equal(flg & 8, 0, "reserved bit set");
  assert.equal(flg & 3, 0, "unexpected dictionary ID");
  let windowSize: number | undefined;
  if (!singleSegment) {
    const wd = frame[5] ?? 0;
    const base = 1 << (10 + (wd >> 3));
    windowSize = base + (base >> 3) * (wd & 7);
  }
  return { singleSegment, contentFlag: flg >> 6, windowSize };
}

/** Deterministic filler that still leaves the encoder real work to do. */
function payload(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const unit = new TextEncoder().encode('{"id":0,"name":"alpha","v":123456}\n');
  for (let i = 0; i < n; i += unit.length) {
    out.set(unit.subarray(0, Math.min(unit.length, n - i)), i);
  }
  return out;
}

describe("frame header", () => {
  test("small frames stay single-segment", () => {
    for (const n of [0, 1, 255, 256, 5_000, 65_791, 65_792, 200_000]) {
      const h = readHeader(compressStrong(payload(n)));
      assert.equal(h.singleSegment, 1, `n=${n} should be single-segment`);
      assert.equal(h.windowSize, undefined, `n=${n}`);
    }
  });

  test("frames above the match window declare an explicit window", () => {
    // Just past the boundary — the smallest input that must switch form.
    for (const n of [WINDOW_SIZE + 1, WINDOW_SIZE * 2 + 12345]) {
      for (const [name, compress] of [
        ["Fast", compressFast],
        ["Strong", compressStrong],
      ] as const) {
        const h = readHeader(compress(payload(n)));
        assert.equal(h.singleSegment, 0, `${name} n=${n}`);
        assert.equal(h.contentFlag, 2, `${name} n=${n} keeps FCS`);
        assert.equal(
          h.windowSize,
          WINDOW_SIZE,
          `${name} n=${n} declares our real window, not the payload size`,
        );
      }
    }
  });

  test("the boundary itself is still single-segment", () => {
    const h = readHeader(compressStrong(payload(WINDOW_SIZE)));
    assert.equal(h.singleSegment, 1);
  });

  test("both header forms round-trip", () => {
    for (const n of [200_000, WINDOW_SIZE + 1, WINDOW_SIZE * 2 + 12345]) {
      const src = payload(n);
      for (const compress of [compressFast, compressStrong, compressUltra]) {
        const frame = compress(src);
        assert.deepEqual(decompress(frame), src, `n=${n}`);
        if (CLI) assert.deepEqual(zstdDecompress(frame), src, `n=${n} via CLI`);
      }
    }
  });

  test("Ultra multi-segment frames declare 8 MiB window and round-trip", () => {
    // Lean Ultra always uses an 8 MiB window (not multi-arm).
    const n = ULTRA_WINDOW + 1;
    const src = payload(n);
    const frame = compressUltra(src);
    const h = readHeader(frame);
    assert.equal(h.singleSegment, 0, `Ultra n=${n}`);
    assert.equal(h.contentFlag, 2, "Ultra keeps FCS");
    assert.equal(
      h.windowSize,
      ULTRA_WINDOW,
      `Ultra window was ${String(h.windowSize)}, expected 8 MiB`,
    );
    assert.deepEqual(decompress(frame), src);
    if (CLI) assert.deepEqual(zstdDecompress(frame), src);
  });

  test("streaming Fast/Strong frames omit FCS and declare the 1 MiB window", () => {
    const src = payload(50_000);
    for (const [name, Ctor] of [
      ["Fast", CompressFast],
      ["Strong", CompressStrong],
    ] as const) {
      const parts: Array<Uint8Array> = [];
      const enc = new Ctor((chunk: Uint8Array) => {
        if (chunk.length > 0) parts.push(chunk.slice());
      });
      enc.push(src, true);
      let total = 0;
      for (const p of parts) total += p.length;
      const frame = new Uint8Array(total);
      let at = 0;
      for (const p of parts) {
        frame.set(p, at);
        at += p.length;
      }
      const h = readHeader(frame);
      assert.equal(h.singleSegment, 0, name);
      assert.equal(h.contentFlag, 0, `${name} has no FCS`);
      assert.equal(h.windowSize, WINDOW_SIZE, name);
      assert.deepEqual(decompress(frame), src, name);
      if (CLI) assert.deepEqual(zstdDecompress(frame), src, `${name} via CLI`);
    }
  });
});
