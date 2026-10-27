/**
 * Cross-validation against `node:zlib`'s zstd — a third decoder for our output,
 * and a third encoder for our decoder, alongside zrip (Rust) and the host CLI.
 *
 * Two directions matter and they fail differently:
 *  - node:zlib encodes → wzstd decodes. Covers the full level band in one
 *    in-process call each, including the negative (`--fast`) tiers.
 *  - wzstd encodes → node:zlib decodes. This is the one that catches frames
 *    only *we* can read; the >128 MiB single-segment window bug was exactly
 *    that shape.
 *
 * Skips cleanly on Node builds without zstd in node:zlib.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { compressFast } from "../dist/compressFast.js";
import { compressStrong } from "../dist/compressStrong.js";
import { decompress } from "../dist/decompress.js";
import { multilingualLines, skewedBinary } from "./helpers/corpus.ts";
import { hasNodeZstd, nodeZstdCompress, nodeZstdDecompress } from "./helpers/node_zstd.ts";

const AVAILABLE = hasNodeZstd();

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

function jsonLines(n: number): Uint8Array {
  const lines: Array<string> = [];
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({ id: i, user: `user_${i % 20}`, ts: 1_700_000_000 + i }));
  }
  return bytes(lines.join("\n"));
}

const CORPUS: Array<{ name: string; data: Uint8Array }> = [
  { name: "tiny", data: bytes("hello") },
  { name: "lorem", data: bytes("lorem ipsum dolor sit amet ".repeat(200)) },
  { name: "repeat-ascii", data: bytes("abcabcabc".repeat(3000)) },
  { name: "json-lines", data: jsonLines(2000) },
  { name: "binary-ramp", data: new Uint8Array(50_000).map((_, i) => i & 0xff) },
  { name: "zeros", data: new Uint8Array(300_000) },
  // Non-ASCII and full-byte-range: the shapes that exposed the Huffman
  // weight-header cliff, so they stay in every cross-check.
  { name: "multilingual", data: bytes(multilingualLines(1500, 7)) },
  { name: "skewed-binary", data: skewedBinary(60_000) },
];

/**
 * The product decode claim is levels −8…19. node:zlib reaches the whole band
 * through one API, so this covers it far more cheaply than spawning the CLI.
 */
const LEVELS = [-8, -5, -3, -1, 1, 3, 5, 9, 12, 15, 17, 19] as const;

describe("node:zlib zstd → wzstd decompress", { skip: !AVAILABLE }, () => {
  for (const level of LEVELS) {
    for (const { name, data } of CORPUS) {
      test(`level ${level} ${name}`, () => {
        assert.deepEqual(
          decompress(nodeZstdCompress(data, level)),
          data,
          `wzstd failed to decode node:zlib level ${level} for ${name}`,
        );
      });
    }
  }
});

describe("wzstd → node:zlib zstd decompress", { skip: !AVAILABLE }, () => {
  for (const { name, data } of CORPUS) {
    test(`L1 ${name}`, () => {
      assert.deepEqual(nodeZstdDecompress(compressFast(data)), data);
    });
    test(`L3 ${name}`, () => {
      assert.deepEqual(nodeZstdDecompress(compressStrong(data)), data);
    });
  }

  test("frames above the match window are readable", () => {
    // Single-segment above the window declares Window_Size = content size,
    // which a strict decoder rejects. This is the regression guard in the
    // direction that actually broke.
    const src = new Uint8Array(1024 * 1024 + 5000);
    const unit = bytes('{"id":0,"v":"alpha"}\n');
    for (let i = 0; i < src.length; i += unit.length) {
      src.set(unit.subarray(0, Math.min(unit.length, src.length - i)), i);
    }
    for (const compress of [compressFast, compressStrong]) {
      assert.deepEqual(nodeZstdDecompress(compress(src)), src);
    }
  });
});

describe("three-way agreement", { skip: !AVAILABLE }, () => {
  test("node:zlib and wzstd decode each other's frames identically", () => {
    for (const { name, data } of CORPUS) {
      const ours = compressStrong(data);
      const theirs = nodeZstdCompress(data, 3);
      assert.deepEqual(decompress(theirs), nodeZstdDecompress(ours), name);
      assert.deepEqual(decompress(theirs), data, name);
    }
  });
});
