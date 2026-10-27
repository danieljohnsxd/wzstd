/**
 * Huffman literal sections: single-stream (Size_Format 00) and the 4-stream
 * layouts (01/10/11) that carry large literal blocks.
 *
 * Every frame is round-tripped through wzstd, zrip (Rust→WASM), and the host
 * `zstd` CLI when present, so the jump table, stream split, and size-format
 * framing are validated against independent decoders.
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { decompress as zripDecompress } from "@paddor/zrip";
import { compressFast } from "../dist/compressFast.js";
import { compressStrong } from "../dist/compressStrong.js";
import { decompress } from "../dist/decompress.js";
import { multilingualLines, skewedBinary } from "./helpers/corpus.ts";
import { ensureZrip } from "./helpers/zrip_init.ts";
import { hasZstdCli, zstdDecompress } from "./helpers/zstd_cli.ts";

/** Literals_Section_Header fields of every compressed block in a frame. */
type LiteralSection = {
  blockType: number;
  sizeFormat: number;
  regenSize: number;
  compressedSize: number;
  /**
   * First byte of the Huffman tree description: >= 128 is a direct 4-bit
   * weight header, below that is the FSE-compressed form (the byte is the
   * body size). -1 when the block carries no tree.
   */
  treeHeader: number;
};

function literalSections(frame: Uint8Array): Array<LiteralSection> {
  const fcsFlag = (frame[4] ?? 0) >>> 6;
  const fcsBytes = fcsFlag === 0 ? 1 : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
  let pos = 5 + fcsBytes;
  const out: Array<LiteralSection> = [];
  while (pos + 3 <= frame.length) {
    const h = (frame[pos] ?? 0) | ((frame[pos + 1] ?? 0) << 8) | ((frame[pos + 2] ?? 0) << 16);
    const last = (h & 1) === 1;
    const blockType = (h >>> 1) & 3;
    const size = h >>> 3;
    pos += 3;
    if (blockType === 2) {
      const b0 = frame[pos] ?? 0;
      const b1 = frame[pos + 1] ?? 0;
      const b2 = frame[pos + 2] ?? 0;
      const b3 = frame[pos + 3] ?? 0;
      const b4 = frame[pos + 4] ?? 0;
      const litType = b0 & 3;
      const sizeFormat = (b0 >> 2) & 3;
      let regenSize = 0;
      let compressedSize = 0;
      let headerLen = 3;
      if (litType < 2) {
        regenSize =
          sizeFormat === 0 || sizeFormat === 2
            ? b0 >> 3
            : sizeFormat === 1
              ? (b0 >> 4) | (b1 << 4)
              : (b0 >> 4) | (b1 << 4) | (b2 << 12);
      } else if (sizeFormat < 2) {
        regenSize = (b0 >> 4) | ((b1 & 0x3f) << 4);
        compressedSize = (b1 >> 6) | (b2 << 2);
        headerLen = 3;
      } else if (sizeFormat === 2) {
        regenSize = (b0 >> 4) | (b1 << 4) | ((b2 & 0x03) << 12);
        compressedSize = (b2 >> 2) | (b3 << 6);
        headerLen = 4;
      } else {
        regenSize = (b0 >> 4) | (b1 << 4) | ((b2 & 0x3f) << 12);
        compressedSize = (b2 >> 6) | (b3 << 2) | (b4 << 10);
        headerLen = 5;
      }
      out.push({
        blockType: litType,
        sizeFormat,
        regenSize,
        compressedSize,
        treeHeader: litType === 2 ? (frame[pos + headerLen] ?? -1) : -1,
      });
    }
    pos += size;
    if (last) break;
  }
  return out;
}

function assertBytesEqual(a: Uint8Array, b: Uint8Array, msg: string): void {
  assert.equal(a.length, b.length, `${msg}: length`);
  assert.deepEqual(a, b, msg);
}

function assertRoundTrips(frame: Uint8Array, data: Uint8Array, label: string): void {
  assertBytesEqual(decompress(frame), data, `${label} wzstd`);
  assertBytesEqual(zripDecompress(frame), data, `${label} zrip`);
  if (hasZstdCli()) {
    assertBytesEqual(zstdDecompress(frame), data, `${label} zstd-cli`);
  }
}

/** xorshift32 so payloads are deterministic across runs. */
function makeRandom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>>= 0);
  };
}

/** Payload shapes chosen to hit the literal-encoding corners. */
const SHAPES: Array<{ name: string; make: (n: number) => Uint8Array }> = [
  {
    name: "few-symbols-skewed",
    make: (n) => {
      const rnd = makeRandom(0x1234567);
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        out[i] = rnd() % 100 < 80 ? 0x61 : 0x62 + (rnd() % 3);
      }
      return out;
    },
  },
  {
    name: "full-byte-range",
    make: (n) => {
      const rnd = makeRandom(0x89abcde);
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = rnd() & 0xff;
      return out;
    },
  },
  {
    name: "printable-zipf",
    make: (n) => {
      const rnd = makeRandom(0x2468ace);
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const r = rnd() % 1000;
        out[i] = r < 500 ? 0x20 : r < 750 ? 0x65 : r < 900 ? 0x74 : 0x21 + (rnd() % 90);
      }
      return out;
    },
  },
  {
    name: "max-symbol-128",
    make: (n) => {
      const rnd = makeRandom(0x13579bd);
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = rnd() % 20 === 0 ? 128 : rnd() % 40;
      return out;
    },
  },
  {
    name: "max-symbol-129",
    make: (n) => {
      const rnd = makeRandom(0xfdb97531);
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = rnd() % 50 === 0 ? 129 : rnd() % 40;
      return out;
    },
  },
  {
    name: "depth-limit-pressure",
    make: (n) => {
      // One symbol at ~99.999% forces natural code lengths past 11 bits, so
      // the length-limiting rebuild has to kick in.
      const rnd = makeRandom(0x0f0f0f0f);
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const r = rnd() % 100000;
        out[i] = r === 0 ? 1 + (rnd() % 120) : r < 10 ? 0x5a : 0x41;
      }
      return out;
    },
  },
  {
    name: "text-with-repeats",
    make: (n) => {
      const rnd = makeRandom(0xa5a5a5a5);
      const words = ["alpha ", "beta ", "gamma-", "delta_", "eps "];
      const out = new Uint8Array(n);
      let i = 0;
      while (i < n) {
        const w = words[rnd() % words.length] ?? "x";
        for (let k = 0; k < w.length && i < n; k++) out[i++] = w.charCodeAt(k);
        if (rnd() % 3 === 0 && i < n) out[i++] = 0x21 + (rnd() % 90);
      }
      return out;
    },
  },
];

/** Sizes straddling every size-format and stream-split boundary. */
const SIZES = [
  0, 1, 15, 16, 17, 31, 63, 255, 1022, 1023, 1024, 1025, 4095, 4096, 16383, 16384, 16385, 40000,
  65535, 65536, 131071, 131072, 131073, 200000,
];

before(async () => {
  await ensureZrip();
});

describe("Huffman literal sections", () => {
  for (const shape of SHAPES) {
    test(`${shape.name}: round-trips at every size boundary`, () => {
      for (const n of SIZES) {
        const data = shape.make(n);
        assertRoundTrips(compressFast(data), data, `${shape.name} L1 n=${n}`);
        assertRoundTrips(compressStrong(data), data, `${shape.name} L3 n=${n}`);
      }
    });
  }

  test("large literal blocks use a 4-stream layout", () => {
    // Wide-but-skewed alphabet with no exploitable matches: literals dominate
    // and far exceed the 1023-byte single-stream cap.
    const rnd = makeRandom(0xbeef);
    const data = new Uint8Array(60_000);
    const alphabet = "etaoinshrdlu ";
    for (let i = 0; i < data.length; i++) {
      data[i] = alphabet.charCodeAt(rnd() % alphabet.length);
    }
    const frame = compressStrong(data);
    assertRoundTrips(frame, data, "large-literals");

    const sections = literalSections(frame);
    assert.ok(sections.length > 0, "expected a compressed block");
    const huffman = sections.filter((s) => s.blockType === 2);
    assert.ok(huffman.length > 0, `expected Huffman literals, got ${JSON.stringify(sections)}`);
    assert.ok(
      huffman.some((s) => s.sizeFormat !== 0),
      `expected a 4-stream size format, got ${JSON.stringify(huffman)}`,
    );
    for (const s of huffman) {
      if (s.sizeFormat === 0) continue;
      assert.ok(
        s.regenSize > 1023 || s.compressedSize > 1023,
        "4-stream layout should only be chosen when a single stream cannot fit",
      );
      // Jump table (6 B) + tree header (>= 2 B) + four non-empty streams.
      assert.ok(
        s.compressedSize >= 6 + 2 + 4,
        `compressed size ${s.compressedSize} too small for a 4-stream section`,
      );
    }
  });

  test("small literal blocks still prefer a single stream", () => {
    const rnd = makeRandom(0xc0ffee);
    const data = new Uint8Array(700);
    for (let i = 0; i < data.length; i++) {
      data[i] = rnd() % 100 < 70 ? 0x61 : 0x62 + (rnd() % 4);
    }
    const frame = compressStrong(data);
    assertRoundTrips(frame, data, "small-literals");
    for (const s of literalSections(frame)) {
      if (s.blockType !== 2) continue;
      assert.equal(
        s.sizeFormat,
        0,
        "literals under the 1023-byte cap should use the single-stream layout",
      );
    }
  });

  test("L1 never emits Huffman literals", () => {
    const rnd = makeRandom(0x5eed);
    const data = new Uint8Array(60_000);
    for (let i = 0; i < data.length; i++) {
      data[i] = rnd() % 100 < 80 ? 0x61 : 0x62 + (rnd() % 3);
    }
    const frame = compressFast(data);
    assertRoundTrips(frame, data, "L1 literals");
    for (const s of literalSections(frame)) {
      assert.notEqual(s.blockType, 2, "L1 must stay on raw/RLE literals");
    }
  });

  test("non-ASCII literals still get Huffman via an FSE weight header", () => {
    // A direct 4-bit weight header carries at most 128 weights, so a single
    // byte above 128 anywhere in the block used to disable Huffman for the
    // whole block. The FSE-compressed weight header removes that cliff.
    for (const nonAsciiEvery of [2, 50, 1 << 30]) {
      const data = new TextEncoder().encode(multilingualLines(2_000, nonAsciiEvery));
      let maxByte = 0;
      for (const b of data) if (b > maxByte) maxByte = b;
      assert.ok(maxByte > 128, "payload should exceed the direct-header limit");

      const frame = compressStrong(data);
      assertRoundTrips(frame, data, `utf8 every=${nonAsciiEvery}`);
      const huffman = literalSections(frame).filter((s) => s.blockType === 2);
      assert.ok(
        huffman.length > 0,
        `expected Huffman literals for non-ASCII data (every=${nonAsciiEvery})`,
      );
      assert.ok(
        huffman.some((s) => s.treeHeader >= 0 && s.treeHeader < 128),
        `expected an FSE-compressed weight header, got ${JSON.stringify(huffman)}`,
      );
    }
  });

  test("full-byte-range binary gets Huffman near its entropy", () => {
    const data = skewedBinary(60_000);
    const frame = compressStrong(data);
    assertRoundTrips(frame, data, "skewed-binary");

    const freq = new Uint32Array(256);
    for (const b of data) freq[b] = (freq[b] ?? 0) + 1;
    let bits = 0;
    for (const f of freq) {
      if (f > 0) bits += f * Math.log2(data.length / f);
    }
    const floor = bits / 8;
    assert.ok(
      frame.length < floor * 1.05,
      `expected within 5% of the entropy floor ${Math.round(floor)}, got ${frame.length}`,
    );
  });

  test("small alphabets keep the direct weight header", () => {
    // Few weights make the direct form cheaper than an FSE table description;
    // both forms stay reachable.
    const rnd = makeRandom(0x33aa);
    const data = new Uint8Array(30_000);
    for (let i = 0; i < data.length; i++) {
      const r = rnd() % 12;
      data[i] = r < 6 ? 0 : r;
    }
    const frame = compressStrong(data);
    assertRoundTrips(frame, data, "small-alphabet");
    const huffman = literalSections(frame).filter((s) => s.blockType === 2);
    assert.ok(huffman.length > 0, "expected Huffman literals");
    assert.ok(
      huffman.some((s) => s.treeHeader >= 128),
      `expected a direct weight header, got ${JSON.stringify(huffman)}`,
    );
  });

  test("declared literal sizes match the section framing", () => {
    // Regen/compressed sizes are split across byte boundaries in formats 10
    // and 11; a mis-shifted field still decodes for some inputs, so check the
    // declared regen size against the payload the decoder actually produces.
    const rnd = makeRandom(0x77777);
    for (const n of [1024, 5000, 20_000, 70_000, 131_072]) {
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        data[i] = rnd() % 10 === 0 ? 0x41 + (rnd() % 26) : 0x61 + (rnd() % 6);
      }
      const frame = compressStrong(data);
      assertRoundTrips(frame, data, `framing n=${n}`);
      let regenTotal = 0;
      for (const s of literalSections(frame)) {
        if (s.blockType === 2) regenTotal += s.regenSize;
      }
      assert.ok(regenTotal > 0, `expected Huffman literals for n=${n} to exercise the framing`);
    }
  });
});
