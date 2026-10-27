/**
 * compressFast / compressStrong / compressUltra: multi-seq + FSE, interop
 * with zrip + zstd CLI. Product tiers only — no L1/L3 aliases.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { compress as zripCompress, decompress as zripDecompress } from "@paddor/zrip";
import {
  CompressFast,
  FAST_CONFIG,
  compressFast,
  compressFastStream,
} from "../dist/compressFast.js";
import {
  CompressStrong,
  STRONG_CONFIG,
  compressStrong,
  compressStrongStream,
} from "../dist/compressStrong.js";
import { ULTRA_CONFIG, compressUltra } from "../dist/compressUltra.js";
import { decompress as decompressSubpath } from "../dist/decompress.js";
import { decompressStream as decompressStreamSubpath } from "../dist/decompressStream.js";
import * as root from "../dist/index.js";
import { decompress } from "../dist/index.js";
import { frameHeaderSize } from "./helpers/frame.ts";
import { ensureZrip } from "./helpers/zrip_init.ts";
import { hasZstdCli, zstdDecompress } from "./helpers/zstd_cli.ts";

const encoder = new TextEncoder();
const DIST_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

function bytes(s: string): Uint8Array {
  return encoder.encode(s);
}

function assertBytesEqual(a: Uint8Array, b: Uint8Array, msg?: string): void {
  assert.equal(a.length, b.length, msg ?? "length mismatch");
  assert.deepEqual(a, b, msg);
}

function assertInterop(frame: Uint8Array, data: Uint8Array, label: string): void {
  assertBytesEqual(decompress(frame), data, `${label} wzstd`);
  assertBytesEqual(zripDecompress(frame), data, `${label} zrip`);
  if (hasZstdCli()) {
    assertBytesEqual(zstdDecompress(frame), data, `${label} zstd-cli`);
  }
}

/**
 * Literals_Block_Type for each compressed (type-2) block in a single-segment frame.
 * Type 2 = Huffman-compressed literals.
 */
function compressedBlockLiteralTypes(frame: Uint8Array): Array<number> {
  assert.ok(frame.length >= 6, "frame too short");
  assert.equal(frame[0], 0x28);
  assert.equal(frame[1], 0xb5);
  assert.equal(frame[2], 0x2f);
  assert.equal(frame[3], 0xfd);
  let pos = frameHeaderSize(frame);
  const litTypes: Array<number> = [];
  while (pos + 3 <= frame.length) {
    const b0 = frame[pos] ?? 0;
    const b1 = frame[pos + 1] ?? 0;
    const b2 = frame[pos + 2] ?? 0;
    const h = b0 | (b1 << 8) | (b2 << 16);
    const last = (h & 1) === 1;
    const blockType = (h >>> 1) & 3;
    const size = h >>> 3;
    pos += 3;
    if (blockType === 2) {
      assert.ok(pos < frame.length, "missing literals header");
      litTypes.push((frame[pos] ?? 0) & 3);
    }
    pos += size;
    if (last) break;
  }
  return litTypes;
}

/**
 * Low-entropy payload that leaves enough literals for Strong Huffman (type 2)
 * while still producing matches so the block is compressed.
 */
function huffmanLiteralsPayload(len = 400): Uint8Array {
  const out = new Uint8Array(len);
  let s = 7;
  for (let i = 0; i < out.length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const r = s % 100;
    // Zipf over a–d so Huffman beats raw; sparse copies keep a seq block.
    out[i] = r < 50 ? 0x61 : r < 75 ? 0x62 : r < 90 ? 0x63 : 0x64;
  }
  for (let i = 40; i + 8 < out.length; i += 40) {
    out.set(out.subarray(i - 20, i - 12), i);
  }
  return out;
}

before(async () => {
  await ensureZrip();
});

const CASES: Array<{ name: string; data: Uint8Array }> = [
  {
    name: "lorem",
    data: bytes("Lorem ipsum dolor sit amet, consectetur adipiscing elit."),
  },
  { name: "repeat-ascii", data: bytes("hello world ".repeat(2_000)) },
  { name: "json-lines", data: bytes(jsonLines(200)) },
  { name: "zeros-100k", data: new Uint8Array(100_000) },
  { name: "binary-ramp", data: binaryRamp(20_000) },
  { name: "short-repeat", data: bytes("abcd".repeat(500)) },
  { name: "size-255", data: new Uint8Array(255).fill(7) },
  { name: "size-256", data: new Uint8Array(256).fill(8) },
  { name: "size-4096", data: bytes("xy".repeat(2048)) },
  { name: "over-block", data: bytes("block-edge-".repeat(15_000)) },
  { name: "mixed", data: mixedCorpus(40_000) },
  { name: "rep-friendly", data: repFriendly(30_000) },
];

describe("API surface", () => {
  test("root export is decode-only and matches the decompress subpath", () => {
    assert.equal(decompress, decompressSubpath);
    assert.deepEqual(Object.keys(root).sort(), [
      "Decompress",
      "ZstdError",
      "ZstdErrorCode",
      "decompress",
      "decompressStream",
    ]);
  });

  test("empty input round-trips all compressors", () => {
    assertInterop(compressFast(new Uint8Array(0)), new Uint8Array(0), "Fast empty");
    assertInterop(compressStrong(new Uint8Array(0)), new Uint8Array(0), "Strong empty");
    assertInterop(compressUltra(new Uint8Array(0)), new Uint8Array(0), "Ultra empty");
  });
});

describe("compressFast", () => {
  for (const { name, data } of CASES) {
    test(`round-trip ${name} (${data.length} B)`, () => {
      assertInterop(compressFast(data), data, `Fast ${name}`);
    });
  }

  test("repetitive data shrinks", () => {
    const data = bytes("compress-me-please ".repeat(400));
    const frame = compressFast(data);
    assert.ok(frame.length < data.length * 0.2);
    assertInterop(frame, data, "Fast shrink");
  });

  test("random data round-trips", () => {
    const data = new Uint8Array(8_000);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.imul(i + 17, 1103515245) + 12345) & 0xff;
    }
    assertInterop(compressFast(data), data, "Fast random");
  });
});

describe("compressStrong", () => {
  for (const { name, data } of CASES) {
    test(`round-trip ${name} (${data.length} B)`, () => {
      assertInterop(compressStrong(data), data, `Strong ${name}`);
    });
  }

  test("zeros shrink", () => {
    const data = new Uint8Array(50_000);
    const frame = compressStrong(data);
    assert.ok(frame.length < 64);
    assertInterop(frame, data, "Strong zeros");
  });

  test("multi-block round-trip", () => {
    const data = mixedCorpus(200_000);
    const frame = compressStrong(data);
    assertInterop(frame, data, "Strong multi-block");
    assert.ok(frame.length < data.length * 0.6);
  });

  test("emits Huffman-compressed literals (type 2) and interops", () => {
    const data = huffmanLiteralsPayload(400);
    const frame = compressStrong(data);
    const litTypes = compressedBlockLiteralTypes(frame);
    assert.ok(
      litTypes.includes(2),
      `expected Huffman literals type 2, got ${JSON.stringify(litTypes)}`,
    );
    assertInterop(frame, data, "Strong Huffman");
  });
});

describe("compressUltra", () => {
  for (const { name, data } of CASES) {
    test(`round-trip ${name} (${data.length} B)`, () => {
      assertInterop(compressUltra(data), data, `Ultra ${name}`);
    });
  }

  test("emits content checksum (4 trailing digest bytes)", () => {
    const data = bytes("checksum ultra ".repeat(200));
    const frame = compressUltra(data);
    // Frame content checksum is always on for our encoders; mismatch when
    // the last 4 bytes are flipped proves they are a live digest.
    const broken = new Uint8Array(frame);
    const last = broken.length - 1;
    broken[last] = ((broken[last] ?? 0) ^ 0xff) & 0xff;
    assert.throws(() => decompress(broken));
    assertInterop(frame, data, "Ultra checksum frame");
  });

  // Ultra <= Strong on size is a ratio baseline, not correctness: it lives in
  // `pnpm bench:check` (scripts/bench_check.ts).
  test("round-trips the mixed corpus", () => {
    const data = mixedCorpus(80_000);
    assertInterop(compressStrong(data), data, "mixed Strong");
    assertInterop(compressUltra(data), data, "mixed Ultra");
  });

  test("repetitive data shrinks and interops", () => {
    const data = bytes("ultra-compress-me ".repeat(800));
    const frame = compressUltra(data);
    assert.ok(frame.length < data.length * 0.15);
    assertInterop(frame, data, "Ultra shrink");
  });
});

describe("dist subpaths and Fast isolation", () => {
  test("shipped matcher policies stay on their measured hill-climb points", () => {
    assert.deepEqual(
      {
        chainLimit: FAST_CONFIG.chainLimit,
        hashBits: FAST_CONFIG.hashBits,
        patience: FAST_CONFIG.patience,
        preferRepOffsets: FAST_CONFIG.preferRepOffsets,
        probeReps: FAST_CONFIG.probeReps,
        rowBits: FAST_CONFIG.rowBits,
        searchSkipShift: FAST_CONFIG.searchSkipShift,
      },
      {
        chainLimit: 4,
        hashBits: 17,
        patience: 4,
        preferRepOffsets: true,
        probeReps: true,
        rowBits: 2,
        searchSkipShift: 8,
      },
    );
    assert.deepEqual(
      {
        chainLimit: STRONG_CONFIG.chainLimit,
        hashBits: STRONG_CONFIG.hashBits,
        patience: STRONG_CONFIG.patience,
        probeReps: STRONG_CONFIG.probeReps,
        searchSkipShift: STRONG_CONFIG.searchSkipShift,
      },
      {
        chainLimit: 20,
        hashBits: 17,
        patience: 4,
        probeReps: true,
        searchSkipShift: 0,
      },
    );
    assert.deepEqual(
      {
        chainLimit: ULTRA_CONFIG.chainLimit,
        patience: ULTRA_CONFIG.patience,
        probeReps: ULTRA_CONFIG.probeReps,
        searchSkipShift: ULTRA_CONFIG.searchSkipShift,
      },
      {
        chainLimit: 24,
        patience: 2,
        probeReps: true,
        searchSkipShift: 0,
      },
    );
  });

  test("package subpath entries export compress/decompress", () => {
    const sample = bytes("subpath smoke");
    assertBytesEqual(decompressSubpath(compressFast(sample)), sample);
    assertBytesEqual(decompressSubpath(compressStrong(sample)), sample);
    assertBytesEqual(decompressSubpath(compressUltra(sample)), sample);
    assert.equal(typeof compressFast, "function");
    assert.equal(typeof compressStrong, "function");
    assert.equal(typeof compressUltra, "function");
    assert.equal(typeof decompressSubpath, "function");
    assert.equal(typeof decompressStreamSubpath, "function");
    assert.equal(decompressStreamSubpath, root.decompressStream);
    assert.equal(typeof CompressFast, "function");
    assert.equal(typeof CompressStrong, "function");
    assert.equal(typeof compressFastStream, "function");
    assert.equal(typeof compressStrongStream, "function");
  });

  test("compressFast dist graph has no Huffman or custom-FSE markers", () => {
    const entry = readFileSync(join(DIST_DIR, "compressFast.js"), "utf8");
    const sharedNames = readdirSync(DIST_DIR).filter(
      (name) => name.startsWith("shared-") && name.endsWith(".js"),
    );
    assert.ok(sharedNames.length > 0, "expected shared-*.js chunk(s)");
    const chunks = [entry, ...sharedNames.map((n) => readFileSync(join(DIST_DIR, n), "utf8"))];
    const forbidden = [
      "maxNumBits",
      "tryEncodeHuffmanLiterals",
      "writeDirectWeightHeader",
      "buildHuffmanTable",
      "encodeLiteralsWithHuffman",
      // Strong/Ultra-only sequence tables; Fast always uses the predefined ones.
      "selectSequenceTable",
      "writeTableDescription",
      "normalizeCounts",
    ];
    for (const src of chunks) {
      for (const marker of forbidden) {
        assert.ok(
          !src.includes(marker),
          `Fast/shared dist must not contain Strong-only marker ${marker}`,
        );
      }
    }
    // Quality packing chunk (when present) should still carry Huffman fields.
    const qualityChunks = readdirSync(DIST_DIR).filter(
      (name) =>
        (name.startsWith("l3-") || name.startsWith("literals-huffman-")) && name.endsWith(".js"),
    );
    assert.ok(qualityChunks.length > 0, "expected quality Huffman chunk");
    const qSrc = readFileSync(join(DIST_DIR, qualityChunks[0] ?? ""), "utf8");
    assert.ok(qSrc.includes("maxNumBits"), "expected quality chunk to retain Huffman maxNumBits");
  });

  test("compressUltra is a separate entry (tree-shake surface)", () => {
    assert.ok(readdirSync(DIST_DIR).includes("compressUltra.js"), "dist/compressUltra.js missing");
    const ultraEntry = readFileSync(join(DIST_DIR, "compressUltra.js"), "utf8");
    const l3Entry = readFileSync(join(DIST_DIR, "compressStrong.js"), "utf8");
    // Distinct product entries — not a shared multi-level compress(level).
    assert.notEqual(ultraEntry, l3Entry);
    assert.ok(ultraEntry.includes("compressUltra") || ultraEntry.length > 0, "ultra entry empty");
  });
});

describe("Fast vs Strong vs Ultra distinction", () => {
  test("Fast and Strong both round-trip mixed corpus", () => {
    const data = mixedCorpus(80_000);
    const f1 = compressFast(data);
    const f3 = compressStrong(data);
    assertInterop(f1, data, "mixed Fast");
    assertInterop(f3, data, "mixed Strong");
    // Fast (shallow chain, raw 8-bit match pricing) can beat Strong on some
    // shapes; Strong still wins on expanded synthetic *totals*. Do not pin
    // per-payload Strong < Fast here.
    assert.ok(f1.length < data.length, "Fast should shrink mixed");
    assert.ok(f3.length < data.length, "Strong should shrink mixed");
  });

  test("Fast and Strong both round-trip rep-friendly corpus", () => {
    const data = repFriendly(60_000);
    const f1 = compressFast(data);
    const f3 = compressStrong(data);
    assertInterop(f1, data, "rep Fast");
    assertInterop(f3, data, "rep Strong");
    assert.ok(f1.length < data.length * 0.1, "Fast should crush rep-friendly");
    // Strong must not lose badly to Fast on short-period phrase reuse
    // (patience-1 first-hit-final used to leave Strong ~20× larger while
    // still clearing a loose 0.2× raw gate).
    assert.ok(
      f3.length <= Math.max(f1.length * 2, 200),
      `Strong ${f3.length} should stay within ~2× Fast ${f1.length} on rep-friendly`,
    );
  });

  // Size baselines (Ultra <= Strong, Ultra < 1%) live in `pnpm bench:check`.
  test("Strong and Ultra round-trip the rep-friendly corpus", () => {
    const data = repFriendly(60_000);
    assertInterop(compressStrong(data), data, "rep Strong");
    assertInterop(compressUltra(data), data, "rep Ultra");
  });
});

describe("decode path still accepts zrip", () => {
  test("zrip L1 frame decompresses", () => {
    const data = bytes("decode path ".repeat(100));
    assertBytesEqual(decompress(zripCompress(data, 1)), data);
  });
});

function jsonLines(n: number): string {
  const lines: Array<string> = [];
  for (let i = 0; i < n; i++) {
    lines.push(
      JSON.stringify({
        id: i,
        user: `user_${i % 20}`,
        action: ["click", "view", "scroll", "type"][i % 4],
      }),
    );
  }
  return lines.join("\n");
}

function binaryRamp(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = i & 0xff;
  return out;
}

function mixedCorpus(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let i = 0;
  let seq = 0;
  while (i < n) {
    const phrase = encoder.encode(`token-${seq % 17}-payload `);
    const unique = encoder.encode(`U${seq.toString(16)}:${(seq * 31) & 0xff}|`);
    const chunk = seq % 3 === 0 ? unique : phrase;
    const take = Math.min(chunk.length, n - i);
    out.set(chunk.subarray(0, take), i);
    i += take;
    seq++;
  }
  return out;
}

function repFriendly(n: number): Uint8Array {
  const a = encoder.encode("ALPHA_BLOCK_");
  const b = encoder.encode("BETA_SEGMENT_");
  const c = encoder.encode("GAMMA_CHUNK_");
  const out = new Uint8Array(n);
  let i = 0;
  let k = 0;
  while (i < n) {
    const phrase = k % 3 === 0 ? a : k % 3 === 1 ? b : c;
    const pick = k % 5 === 0 ? phrase : k % 5 === 1 ? a : phrase;
    const take = Math.min(pick.length, n - i);
    out.set(pick.subarray(0, take), i);
    i += take;
    k++;
  }
  return out;
}
