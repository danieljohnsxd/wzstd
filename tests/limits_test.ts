/**
 * Resource limits on untrusted input: the `maxSize` output cap, the fixed
 * 128 MiB window limit, and the per-sequence bound that keeps a block's CPU
 * proportional to the output it may legally produce.
 *
 * Every attack here is a small hand-built frame, so the file is hermetic (no
 * CLI) and fast. DoS regressions assert bounded work — a throw, with only a
 * generous 1 s ceiling where time is the symptom; tight perf thresholds live
 * in `pnpm bench:check`. Each one reproduced against the previous decoder:
 *
 * - 10 KB of RLE blocks decoded to 327 MB with no error (no output cap).
 * - A 40 KB compressed block of 20000 maximum-length matches ran 2.3 s of
 *   byte copies that all fell off the end of the block buffer before the
 *   overflow check after the loop fired.
 * - A sequence consuming more literals than the block carried decoded to
 *   wrong bytes with no error.
 *
 * Assertions name the error code: a bare `assert.throws()` would pass on an
 * unrelated failure.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  Decompress,
  decompress,
  decompressStream,
  ZstdError,
  ZstdErrorCode,
} from "../dist/index.js";

const MiB = 1024 * 1024;

const cat = (...parts: Array<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** 3-byte block header. Type 0 raw, 1 RLE, 2 compressed. */
const blockHeader = (last: boolean, type: number, size: number): Uint8Array => {
  const h = (last ? 1 : 0) | (type << 1) | (size << 3);
  return new Uint8Array([h & 255, (h >> 8) & 255, (h >> 16) & 255]);
};

/** Frame header: windowed, no content size, no checksum, 128 KiB window. */
const WINDOWED = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 7 << 3]);

/** A frame of `n` RLE blocks, 128 KiB of zeros each: 4 input bytes per block. */
function rleBomb(n: number): Uint8Array {
  const parts: Array<Uint8Array> = [WINDOWED];
  for (let i = 0; i < n; i++) parts.push(blockHeader(i === n - 1, 1, 131072), new Uint8Array([0]));
  return cat(...parts);
}

/**
 * A compressed block of `n` identical sequences, all three code streams in
 * RLE mode (Compression_Mode 1), so the bitstream carries only extra bits:
 * `extraBytes` zero bytes, then the end-of-stream marker. Raw literals.
 */
function seqBlock(n: number, lits: Uint8Array, llCode: number, mlCode: number, extraBytes: number) {
  const ns =
    n < 128
      ? [n]
      : n < 0x7f00
        ? [(n >> 8) + 0x80, n & 255]
        : [0xff, (n - 0x7f00) & 255, ((n - 0x7f00) >> 8) & 255];
  const body = cat(
    new Uint8Array([lits.length << 3]),
    lits,
    // Modes: LL, OF, ML all RLE; then their single symbols in that order.
    new Uint8Array([...ns, 0x54, llCode, 0, mlCode]),
    new Uint8Array(extraBytes),
    new Uint8Array([1]),
  );
  return cat(blockHeader(true, 2, body.length), body);
}

/** Eight bytes of history so rep offset 1 (initially 4) has something to read. */
const HISTORY = cat(blockHeader(false, 0, 8), new Uint8Array(8).fill(97));

function code(run: () => unknown): number | "decoded" {
  try {
    run();
    return "decoded";
  } catch (e) {
    if (e instanceof ZstdError) return e.code;
    throw e;
  }
}

function streamAll(frame: Uint8Array, opts?: { maxSize?: number }): number {
  let n = 0;
  const d = new Decompress((c) => {
    n += c.length;
  }, opts);
  for (let i = 0; i < frame.length; i += 4096) d.push(frame.subarray(i, i + 4096));
  d.push(new Uint8Array(0), true);
  return n;
}

async function webStreamAll(frame: Uint8Array, opts?: { maxSize?: number }): Promise<number> {
  const src = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(frame);
      c.close();
    },
  });
  const plain = src.pipeThrough(decompressStream(opts));
  let n = 0;
  for await (const c of plain) n += c.length;
  return n;
}

describe("maxSize", () => {
  test("rejects anything but Infinity or a non-negative safe integer, at call time", () => {
    for (const bad of [Number.NaN, -1, 1.5, "10", null, 2 ** 53, -Infinity]) {
      // Deliberately wrong types: this test checks runtime validation.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const opts = { maxSize: bad } as unknown as { maxSize: number };
      assert.throws(() => decompress(new Uint8Array(0), opts), TypeError, String(bad));
      assert.throws(() => new Decompress(undefined, opts), TypeError, String(bad));
      assert.throws(() => decompressStream(opts), TypeError, String(bad));
    }
    for (const ok of [0, 1, 2 ** 53 - 1, Infinity, undefined]) {
      assert.equal(decompress(new Uint8Array(0), { maxSize: ok }).length, 0);
      assert.ok(new Decompress(undefined, { maxSize: ok }));
      decompressStream({ maxSize: ok });
    }
  });

  test("a 10 KB RLE bomb stops at the 64 MiB default on every path", async () => {
    const bomb = rleBomb(2500); // 10006 bytes, 327 MB if fully decoded
    assert.ok(bomb.length < 11_000);
    assert.equal(
      code(() => decompress(bomb)),
      ZstdErrorCode.OutputTooLarge,
    );
    assert.equal(
      code(() => streamAll(bomb)),
      ZstdErrorCode.OutputTooLarge,
    );
    await assert.rejects(webStreamAll(bomb), (e) => {
      assert.ok(e instanceof ZstdError);
      assert.equal(e.code, ZstdErrorCode.OutputTooLarge);
      return true;
    });
  });

  test("Infinity opts out; the default is exactly 64 MiB", () => {
    const over = rleBomb(513); // 64 MiB + 128 KiB
    assert.equal(
      code(() => decompress(over)),
      ZstdErrorCode.OutputTooLarge,
    );
    assert.equal(decompress(over, { maxSize: Infinity }).length, 513 * 131072);
    assert.equal(streamAll(over, { maxSize: Infinity }), 513 * 131072);
    const exact = rleBomb(512); // exactly 64 MiB
    assert.equal(decompress(exact).length, 64 * MiB);
    assert.equal(streamAll(exact), 64 * MiB);
  });

  test("the cap is exact and counts every concatenated frame", () => {
    const one = rleBomb(1); // 131072 bytes
    const two = cat(one, one);
    assert.equal(decompress(two, { maxSize: 262144 }).length, 262144);
    assert.equal(streamAll(two, { maxSize: 262144 }), 262144);
    assert.equal(
      code(() => decompress(two, { maxSize: 262143 })),
      ZstdErrorCode.OutputTooLarge,
    );
    assert.equal(
      code(() => streamAll(two, { maxSize: 262143 })),
      ZstdErrorCode.OutputTooLarge,
    );
    assert.equal(
      code(() => decompress(one, { maxSize: 0 })),
      ZstdErrorCode.OutputTooLarge,
    );
    // `out` and maxSize: the smaller bound wins.
    const out = new Uint8Array(131072);
    assert.equal(
      code(() => decompress(one, { out, maxSize: 1000 })),
      ZstdErrorCode.OutputTooLarge,
    );
    assert.equal(decompress(one, { out, maxSize: Infinity }), out);
  });

  test("a declared content size above the cap fails before any block is read", () => {
    // Windowed (1 KiB), 4-byte FCS of 3 GB, and no blocks at all: without the
    // early check this is UnexpectedEOF, after trying to allocate 3 GB.
    const fcs = 3_000_000_000;
    const frame = new Uint8Array([
      0x28,
      0xb5,
      0x2f,
      0xfd,
      0x80,
      0x00,
      fcs & 255,
      (fcs >>> 8) & 255,
      (fcs >>> 16) & 255,
      fcs >>> 24,
    ]);
    assert.equal(
      code(() => decompress(frame)),
      ZstdErrorCode.OutputTooLarge,
    );
    assert.equal(
      code(() => streamAll(frame)),
      ZstdErrorCode.OutputTooLarge,
    );
    // Opted out, the declaration still cannot buy an allocation the 10-byte
    // input could never fill: it fails as truncated, having allocated little.
    const before = process.memoryUsage().arrayBuffers;
    assert.equal(
      code(() => decompress(frame, { maxSize: Infinity })),
      ZstdErrorCode.UnexpectedEOF,
    );
    assert.ok(process.memoryUsage().arrayBuffers - before < 16 * MiB);
  });
});

describe("per-sequence bounds", () => {
  test("20000 max-length matches fail at the first overflow, not after the loop", () => {
    // ML code 52 = 65539 + 16 extra bits; two such matches exceed a 128 KiB
    // block. The previous decoder copied all 1.3 GB, byte by byte, into
    // nowhere (2.3 s), then rejected the block.
    const frame = cat(WINDOWED, HISTORY, seqBlock(20000, new Uint8Array(0), 0, 52, 40000));
    for (const run of [() => decompress(frame), () => streamAll(frame)]) {
      const t = performance.now();
      assert.equal(code(run), ZstdErrorCode.InvalidData);
      const ms = performance.now() - t;
      assert.ok(ms < 1000, `took ${Math.round(ms)} ms`);
    }
  });

  test("a sequence that consumes more literals than the block holds is rejected", () => {
    // Two literals, one sequence asking for five. This used to decode to 13
    // bytes, three of them invented, with no error.
    const frame = cat(WINDOWED, HISTORY, seqBlock(1, new Uint8Array([1, 2]), 5, 0, 0));
    assert.equal(
      code(() => decompress(frame)),
      ZstdErrorCode.InvalidData,
    );
    assert.equal(
      code(() => streamAll(frame)),
      ZstdErrorCode.InvalidData,
    );
  });

  test("empty compressed blocks decode to nothing on both paths", () => {
    // Correctness only. Their cost per block (they once allocated 128 KiB
    // each on the streaming path) is a perf regression check in
    // `pnpm bench:check`, not a test.
    const n = 1000;
    const empty = cat(blockHeader(false, 2, 2), new Uint8Array([0, 0]));
    const parts: Array<Uint8Array> = [WINDOWED];
    for (let i = 0; i < n; i++) parts.push(empty);
    const frame = cat(...parts, blockHeader(true, 0, 0));
    assert.equal(decompress(frame).length, 0);
    assert.equal(streamAll(frame), 0);
  });
});

describe("window limit (hermetic)", () => {
  test("128 MiB is accepted, anything above is WindowSizeTooLarge", () => {
    const withWindow = (wd: number) =>
      cat(
        new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, wd]),
        blockHeader(true, 1, 16),
        new Uint8Array([7]),
      );
    assert.equal(decompress(withWindow(17 << 3)).length, 16);
    assert.equal(streamAll(withWindow(17 << 3)), 16);
    for (const wd of [(17 << 3) | 1, 18 << 3, 31 << 3]) {
      assert.equal(
        code(() => decompress(withWindow(wd))),
        ZstdErrorCode.WindowSizeTooLarge,
      );
      assert.equal(
        code(() => streamAll(withWindow(wd))),
        ZstdErrorCode.WindowSizeTooLarge,
      );
    }
  });

  test("a single-segment frame declares its content size as its window", () => {
    // Same rule libzstd's streaming decoder (the CLI, node:zlib) applies.
    const fcs = 2 ** 27 + 1;
    const frame = new Uint8Array([
      0x28,
      0xb5,
      0x2f,
      0xfd,
      0xa0,
      fcs & 255,
      (fcs >>> 8) & 255,
      (fcs >>> 16) & 255,
      fcs >>> 24,
    ]);
    assert.equal(
      code(() => decompress(frame, { maxSize: Infinity })),
      ZstdErrorCode.WindowSizeTooLarge,
    );
  });
});
