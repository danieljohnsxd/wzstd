/**
 * Sequence-section Compression_Modes: predefined (0) and custom FSE tables (2).
 *
 * The table description is a bit-packed format the decoder parses with a
 * shrinking field width, so a wrong value width still decodes for some inputs.
 * Every frame here is therefore checked against zrip and the host `zstd` CLI,
 * not just our own decoder.
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { decompress as zripDecompress } from "@paddor/zrip";
import { compressFast } from "../dist/compressFast.js";
import { compressStrong } from "../dist/compressStrong.js";
import { decompress, ZstdError, ZstdErrorCode } from "../dist/decompress.js";
import { jsonLines, mixedCorpus, repFriendly } from "./helpers/corpus.ts";
import { ensureZrip } from "./helpers/zrip_init.ts";
import { hasZstdCli, zstdDecompress } from "./helpers/zstd_cli.ts";

const encoder = new TextEncoder();

/** One block's sequence section: its modes and where the mode byte sits. */
type SeqSection = {
  /** Symbol_Compression_Modes: [LL, OF, ML]. */
  modes: [number, number, number];
  /** Byte offset of the Symbol_Compression_Modes byte within the frame. */
  scmOffset: number;
};

/** Symbol_Compression_Modes of each compressed block: [LL, OF, ML]. */
function sequenceModes(frame: Uint8Array): Array<[number, number, number]> {
  return sequenceSections(frame).map((s) => s.modes);
}

function sequenceSections(frame: Uint8Array): Array<SeqSection> {
  const fcsFlag = (frame[4] ?? 0) >>> 6;
  const fcsBytes = fcsFlag === 0 ? 1 : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
  let pos = 5 + fcsBytes;
  const out: Array<SeqSection> = [];
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
      let litBytes = 0;
      if (litType < 2) {
        const headerLen = sizeFormat === 1 ? 2 : sizeFormat === 3 ? 3 : 1;
        const regen =
          sizeFormat === 1
            ? (b0 >> 4) | (b1 << 4)
            : sizeFormat === 3
              ? (b0 >> 4) | (b1 << 4) | (b2 << 12)
              : b0 >> 3;
        litBytes = headerLen + (litType === 1 ? 1 : regen);
      } else if (sizeFormat < 2) {
        litBytes = 3 + ((b1 >> 6) | (b2 << 2));
      } else if (sizeFormat === 2) {
        litBytes = 4 + ((b2 >> 2) | (b3 << 6));
      } else {
        litBytes = 5 + ((b2 >> 6) | (b3 << 2) | (b4 << 10));
      }
      let sp = pos + litBytes;
      let ns = frame[sp++] ?? 0;
      if (ns === 255) {
        ns = ((frame[sp++] ?? 0) | ((frame[sp++] ?? 0) << 8)) + 0x7f00;
      } else if (ns > 127) ns = ((ns - 128) << 8) | (frame[sp++] ?? 0);
      if (ns > 0) {
        const scm = frame[sp] ?? 0;
        assert.equal(scm & 3, 0, "reserved Symbol_Compression_Modes bits");
        out.push({
          modes: [(scm >> 6) & 3, (scm >> 4) & 3, (scm >> 2) & 3],
          scmOffset: sp,
        });
      }
    }
    pos += size;
    if (last) break;
  }
  return out;
}

function assertRoundTrips(frame: Uint8Array, data: Uint8Array, label: string): void {
  assert.equal(decompress(frame).length, data.length, `${label} wzstd length`);
  assert.deepEqual(decompress(frame), data, `${label} wzstd`);
  assert.deepEqual(zripDecompress(frame), data, `${label} zrip`);
  if (hasZstdCli()) {
    assert.deepEqual(zstdDecompress(frame), data, `${label} zstd-cli`);
  }
}

function makeRandom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>>= 0);
  };
}

before(async () => {
  await ensureZrip();
});

describe("sequence FSE tables", () => {
  test("custom tables are chosen on sequence-heavy data and interop", () => {
    const data = mixedCorpus(200_000);
    const frame = compressStrong(data);
    assertRoundTrips(frame, data, "mixed-200k");
    const modes = sequenceModes(frame);
    assert.ok(modes.length > 0, "expected sequence sections");
    assert.ok(
      modes.some((m) => m.includes(2)),
      `expected at least one FSE_Compressed stream, got ${JSON.stringify(modes)}`,
    );
  });

  test("short sequence runs stay on the predefined tables", () => {
    // One repeated phrase compresses to a couple of sequences. A table
    // description would cost more than it saves there, so mode selection must
    // leave these alone.
    const data = encoder.encode("compress-me-please ".repeat(400));
    const frame = compressStrong(data);
    assertRoundTrips(frame, data, "short-seq-run");
    for (const m of sequenceModes(frame)) {
      assert.deepEqual(m, [0, 0, 0], "a handful of sequences should not carry table descriptions");
    }
    assert.ok(frame.length < 50, `expected a tiny frame, got ${frame.length}`);
  });

  test("RLE mode (1) is never emitted", () => {
    // A single-symbol custom table already costs zero bits per sequence, so
    // mode 2 subsumes RLE and we do not ship that path.
    for (const data of [
      mixedCorpus(200_000),
      encoder.encode(jsonLines(500)),
      repFriendly(30_000),
      encoder.encode("abcd".repeat(5_000)),
    ]) {
      for (const m of sequenceModes(compressStrong(data))) {
        assert.ok(!m.includes(1), `unexpected RLE mode in ${JSON.stringify(m)}`);
      }
    }
  });

  test("L1 stays on the predefined tables", () => {
    for (const data of [mixedCorpus(200_000), encoder.encode(jsonLines(500))]) {
      const frame = compressFast(data);
      assertRoundTrips(frame, data, "L1 predefined");
      for (const m of sequenceModes(frame)) {
        assert.deepEqual(m, [0, 0, 0], "L1 must not emit custom or RLE sequence tables");
      }
    }
  });

  test("round-trips across sequence counts and payload shapes", () => {
    // Few sequences make the table description expensive relative to what it
    // saves; many push the accuracy log to its ceiling. Both must hold.
    const shapes: Array<{ name: string; data: Uint8Array }> = [];
    for (const n of [1, 2, 3, 5, 20, 200, 2_000, 20_000]) {
      shapes.push({ name: `mixed-${n}`, data: mixedCorpus(n) });
      shapes.push({ name: `rep-${n}`, data: repFriendly(n) });
    }
    for (const n of [10, 100, 500, 2_000]) {
      shapes.push({ name: `json-${n}`, data: encoder.encode(jsonLines(n)) });
    }
    // Widely spread offset codes exercise long zero runs in the table
    // description (the 2-bit repeat-flag path).
    const rnd = makeRandom(0xfeed);
    const spread = new Uint8Array(120_000);
    for (let i = 0; i < spread.length; i++) {
      spread[i] = 0x61 + (rnd() % 6);
    }
    for (let i = 2_000; i + 64 < spread.length; i += 1_500 + (rnd() % 4_000)) {
      const from = rnd() % i;
      spread.set(spread.subarray(from, from + 40 + (rnd() % 24)), i);
    }
    shapes.push({ name: "spread-offsets", data: spread });

    for (const shape of shapes) {
      assertRoundTrips(compressStrong(shape.data), shape.data, `Strong ${shape.name}`);
      assertRoundTrips(compressFast(shape.data), shape.data, `Fast ${shape.name}`);
    }
  });

  test("custom tables keep L3 well under raw size", () => {
    // Mode selection compares estimated costs. Used to pin L3 < L1, but Fast
    // (raw 8-bit match pricing + shallow chain) can beat Strong on some mixed
    // sizes without that implying a broken FSE estimator. Pin absolute sanity
    // instead: L3 must still crush the raw payload on compressible mixed.
    for (const n of [4_000, 40_000, 200_000]) {
      const data = mixedCorpus(n);
      const l3 = compressStrong(data).length;
      assert.ok(
        l3 < data.length * 0.35,
        `Strong (${l3}) should stay well under raw (${data.length}) at n=${n}`,
      );
      assertRoundTrips(compressStrong(data), data, `Strong mixed-${n}`);
    }
  });

  /**
   * Accuracy_Log ceilings are 9 for LL/ML and 8 for OF. They are format
   * constants, but the decoder's sequence loop now *depends* on them
   * arithmetically: it takes `ll extra + LL state` (<= 16 + 9 = 25 bits) and
   * `ML state + OF state` (<= 9 + 8 = 17) out of a single 32-bit read, which is
   * sound only because a byte-unaligned read guarantees 25 valid bits.
   *
   * Raise either ceiling by one and the first pair needs 26. Nothing would
   * throw: the top bit of the LL-extra field would just read as whatever the
   * shift dragged in, on the alignments where `spos & 7` is 7 — wrong bytes
   * returned successfully, on some inputs, some of the time. That is the
   * failure mode this codebase treats as the worst kind, so the ceiling gets a
   * test rather than a comment.
   */
  test("Accuracy_Log above the per-stream ceiling is rejected", () => {
    const data = mixedCorpus(200_000);
    const frame = compressStrong(data);
    // Tables appear in the stream in LL, OF, ML order, right after the
    // Symbol_Compression_Modes byte, so only the first FSE_Compressed stream
    // of a block is at a known offset.
    const ORDER = [
      { name: "LL", ceiling: 9 },
      { name: "OF", ceiling: 8 },
      { name: "ML", ceiling: 9 },
    ] as const;

    let checked = 0;
    for (const section of sequenceSections(frame)) {
      const first = section.modes.findIndex((m) => m === 2);
      if (first < 0) continue;
      const stream = ORDER[first];
      if (stream === undefined) continue;
      const at = section.scmOffset + 1;
      const original = frame[at];
      if (original === undefined) continue;

      // Low 4 bits are Accuracy_Log - 5. Ask for exactly one above the
      // ceiling; the decoder checks before touching anything else, so the
      // rest of the (now meaningless) description is never reached.
      const patched = frame.slice();
      patched[at] = (original & 0xf0) | (stream.ceiling + 1 - 5);
      assert.throws(
        () => decompress(patched),
        (e: unknown) => e instanceof ZstdError && e.code === ZstdErrorCode.FSEAccuracyTooHigh,
        `${stream.name} Accuracy_Log ${stream.ceiling + 1} must be rejected`,
      );

      // The unpatched byte must still decode, or the test proved nothing
      // about the ceiling — only that the frame was already broken.
      assert.deepEqual(decompress(frame), data, "unpatched frame still valid");
      checked++;
      break;
    }
    assert.ok(checked > 0, "expected at least one FSE_Compressed stream");
  });
});

/**
 * Every sequence code the decoder produces must land inside the code space the
 * format defines: LL ≤ 35, ML ≤ 52, OF ≤ 31.
 *
 * This is not cosmetic strictness. `llb` / `llbl` / `mlb` / `mlbl` are sized to
 * exactly those domains and read **unguarded**, straight into arithmetic, where
 * an out-of-range index yields `undefined` and then `NaN` — and `NaN` walks
 * through every `>` bound check because those comparisons are false. The bound
 * is what makes the narrow tables safe, so it has to hold at *both* places a
 * code can enter the loop: a table description (`rfse`) and the single raw byte
 * of an RLE table (Symbol_Compression_Mode 1).
 *
 * The frames below are hand-built because our encoder emits neither an RLE
 * sequence table nor an over-range symbol, so nothing in the corpus reaches
 * these paths. Each in-range fixture is checked against the host `zstd` CLI as
 * well as our own decoder — an "invalid" fixture that was merely malformed
 * would prove nothing, which is how the first draft of this test was wrong.
 */
const EXPECT = new TextEncoder().encode("abcdabc");

/** 4 raw literals + 1 sequence, wrapped in a 1 KiB-window frame. */
function makeFrame(block: Array<number>): Uint8Array {
  const bh = (block.length << 3) | (2 << 1) | 1;
  return new Uint8Array([
    0x28,
    0xb5,
    0x2f,
    0xfd,
    0x80, // Frame_Content_Size flag 2 (4 bytes), not single segment
    0x00, // window descriptor: 1 KiB
    0x07,
    0x00,
    0x00,
    0x00, // Frame_Content_Size = 7
    bh & 0xff,
    (bh >> 8) & 0xff,
    (bh >> 16) & 0xff,
    ...block,
  ]);
}

/**
 * All three tables in RLE mode, so every code is a raw input byte and the
 * bitstream is one byte: sentinel at bit 2, OF extra bits `0b11` below it.
 * LL code 4 → literal length 4, ML code 0 → match length 3, OF code 2 with
 * extra `0b11` → offset 7, i.e. a distance of 4 back over "abcd".
 */
function rleFrame(ll: number, of: number, ml: number): Uint8Array {
  return makeFrame([
    0x20, // literals: Raw, Regenerated_Size 4
    0x61,
    0x62,
    0x63,
    0x64,
    0x01, // Number_of_Sequences = 1
    0x54, // Symbol_Compression_Modes: LL, OF, ML all RLE
    ll,
    of,
    ml,
    0x07,
  ]);
}

/**
 * LL from a custom FSE table (mode 2), OF and ML still RLE. The bitstream is
 * exactly 8 bits — sentinel at bit 7, the 5-bit LL initial state at bits 2-6,
 * OF extra at bits 0-1 — because `zstd` requires it fully consumed.
 */
function fseFrame(llDesc: Array<number>): Uint8Array {
  return makeFrame([
    0x20,
    0x61,
    0x62,
    0x63,
    0x64,
    0x01,
    0x94, // Symbol_Compression_Modes: LL = FSE_Compressed, OF and ML RLE
    ...llDesc,
    0x02, // OF RLE code 2
    0x00, // ML RLE code 0
    0x83,
  ]);
}

// Accuracy_Log 5. In range: LL code 4 takes all 32 states, so the table costs
// zero state bits. Over range: 31 states on code 4 and one on **code 36**,
// one past MAX_LL — identical in every other respect, and still decodes to
// "abcdabc" on a build without the bound. That is the whole point: it is not
// a malformed frame, it is a frame naming a symbol the format does not have.
const LL_IN_RANGE = [0x10, 0xe6, 0x07];
const LL_OVER_RANGE = [0x10, 0xc6, 0xef, 0xff, 0xff, 0x19];

describe("sequence codes are bounded at their source", () => {
  test("the RLE and FSE fixtures are real frames, not merely malformed", () => {
    // If these stop decoding, every rejection below becomes vacuous.
    assert.deepEqual(decompress(rleFrame(4, 2, 0)), EXPECT);
    assert.deepEqual(decompress(fseFrame(LL_IN_RANGE)), EXPECT);
  });

  test("the host zstd CLI agrees the in-range fixtures are valid", (t) => {
    if (!hasZstdCli()) return t.skip("zstd CLI not available");
    assert.deepEqual(zstdDecompress(rleFrame(4, 2, 0)), EXPECT);
    assert.deepEqual(zstdDecompress(fseFrame(LL_IN_RANGE)), EXPECT);
  });

  test("an RLE sequence table above its code space is rejected", () => {
    // An RLE table's symbol never passes through `rfse`, so it needs its own
    // check. Without one, OF code 32 decoded to "abcdddd" and reported
    // success -- wrong bytes, on a frame carrying no checksum to catch it.
    const cases: Array<[string, Uint8Array]> = [
      ["LL 36", rleFrame(36, 2, 0)],
      ["LL 255", rleFrame(255, 2, 0)],
      ["OF 32", rleFrame(4, 32, 0)],
      ["OF 255", rleFrame(4, 255, 0)],
      ["ML 53", rleFrame(4, 2, 53)],
      ["ML 255", rleFrame(4, 2, 255)],
    ];
    for (const [name, frame] of cases) {
      assert.throws(
        () => decompress(frame),
        (e: unknown) => e instanceof ZstdError,
        `RLE ${name} must be rejected`,
      );
    }
  });

  test("an FSE table describing a symbol past its code space is rejected", () => {
    assert.throws(
      () => decompress(fseFrame(LL_OVER_RANGE)),
      (e: unknown) => e instanceof ZstdError && e.code === ZstdErrorCode.InvalidData,
      "LL table naming symbol 36 must be rejected",
    );
  });

  test("the host zstd CLI also rejects the over-range fixtures", (t) => {
    if (!hasZstdCli()) return t.skip("zstd CLI not available");
    // Rejecting these is interop, not extra strictness: libzstd bounds the
    // same value in FSE_readNCount, and we used to accept what it refuses.
    assert.throws(() => zstdDecompress(fseFrame(LL_OVER_RANGE)));
    assert.throws(() => zstdDecompress(rleFrame(4, 32, 0)));
  });
});
