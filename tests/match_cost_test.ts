/**
 * Match cost model: L3 prices literals at the block's entropy, so a sequence
 * has to save more bits than it costs. This is what keeps short far matches out
 * of the parse on literal-heavy data, and what lets a block end up with zero
 * sequences (a valid, literals-only compressed block).
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { decompress as zripDecompress } from "@paddor/zrip";
import { compressFast } from "../dist/compressFast.js";
import { compressStrong } from "../dist/compressStrong.js";
import { decompress } from "../dist/decompress.js";
import { lowEntropy, mixedCorpus } from "./helpers/corpus.ts";
import { frameHeaderSize } from "./helpers/frame.ts";
import { ensureZrip } from "./helpers/zrip_init.ts";
import { hasZstdCli, zstdDecompress } from "./helpers/zstd_cli.ts";

type BlockInfo = {
  blockType: number;
  litType: number;
  numSequences: number;
};

/** Walk a frame and report each block's shape. */
function blocks(frame: Uint8Array): Array<BlockInfo> {
  let pos = frameHeaderSize(frame);
  const out: Array<BlockInfo> = [];
  while (pos + 3 <= frame.length) {
    const h = (frame[pos] ?? 0) | ((frame[pos + 1] ?? 0) << 8) | ((frame[pos + 2] ?? 0) << 16);
    const last = (h & 1) === 1;
    const blockType = (h >>> 1) & 3;
    const size = h >>> 3;
    pos += 3;
    if (blockType !== 2) {
      out.push({ blockType, litType: -1, numSequences: -1 });
    } else {
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
      out.push({ blockType, litType, numSequences: ns });
    }
    pos += size;
    if (last) break;
  }
  return out;
}

function assertRoundTrips(frame: Uint8Array, data: Uint8Array, label: string): void {
  assert.deepEqual(decompress(frame), data, `${label} wzstd`);
  assert.deepEqual(zripDecompress(frame), data, `${label} zrip`);
  if (hasZstdCli()) {
    assert.deepEqual(zstdDecompress(frame), data, `${label} zstd-cli`);
  }
}

before(async () => {
  await ensureZrip();
});

describe("match cost model", () => {
  test("literal-heavy data drops matches that cost more than they save", () => {
    // 13-symbol noise: 4-byte matches exist by chance everywhere, but at these
    // distances a sequence costs more bits than the ~3.7 bits/byte the bytes
    // would take as Huffman literals.
    const data = lowEntropy(50_000);
    const frame = compressStrong(data);
    assertRoundTrips(frame, data, "low-entropy");

    const info = blocks(frame);
    assert.equal(info.length, 1, "expected a single block");
    const only = info[0];
    assert.ok(only, "missing block");
    assert.equal(only.blockType, 2, "expected a compressed block");
    assert.equal(only.litType, 2, "expected Huffman literals");
    assert.ok(
      only.numSequences < 200,
      `expected the parse to reject chance matches, got ${only.numSequences} sequences`,
    );

    // Order-0 entropy is the floor a Huffman literals section can reach.
    const freq = new Uint32Array(256);
    for (const b of data) freq[b] = (freq[b] ?? 0) + 1;
    let bits = 0;
    for (const f of freq) {
      if (f > 0) bits += f * Math.log2(data.length / f);
    }
    const floor = bits / 8;
    assert.ok(
      frame.length < floor * 1.1,
      `expected within 10% of the entropy floor ${Math.round(floor)}, got ${frame.length}`,
    );
  });

  test("a block with no worthwhile match still compresses via literals", () => {
    // Every byte is drawn from a skewed alphabet with no repeats to exploit,
    // so the only win available is the literals section itself.
    let s = 0x9e3779b9;
    const data = new Uint8Array(4_000);
    for (let i = 0; i < data.length; i++) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      const r = s % 1000;
      data[i] = r < 700 ? 0x41 : r < 900 ? 0x42 : 0x43 + (r % 20);
    }
    const frame = compressStrong(data);
    assertRoundTrips(frame, data, "literals-only");
    assert.ok(
      frame.length < data.length,
      `expected compression, got ${frame.length} from ${data.length}`,
    );
    for (const b of blocks(frame)) {
      if (b.blockType === 2) {
        assert.equal(b.litType, 2, "expected Huffman literals");
      }
    }
  });

  test("highly repetitive data still takes its matches", () => {
    // The cost model must not suppress genuinely profitable matches.
    const data = new TextEncoder().encode("compress-me-please ".repeat(400));
    const frame = compressStrong(data);
    assertRoundTrips(frame, data, "repetitive");
    assert.ok(frame.length < 100, `expected long matches to survive scoring, got ${frame.length}`);
  });

  test("Fast and Strong both round-trip mixed content and shrink it", () => {
    // Fast prices literals at a flat 8 bits; Strong uses order-0 entropy, so
    // on some mixed sizes Fast's parse can be smaller. Both must still
    // round-trip and beat the raw input.
    for (const n of [1_024, 40_000, 200_000]) {
      const data = mixedCorpus(n);
      const f1 = compressFast(data);
      const f3 = compressStrong(data);
      assertRoundTrips(f1, data, `mixed-${n} L1`);
      assertRoundTrips(f3, data, `mixed-${n} L3`);
      assert.ok(f1.length < data.length, `Fast (${f1.length}) should shrink mixed-${n}`);
      assert.ok(f3.length < data.length, `Strong (${f3.length}) should shrink mixed-${n}`);
    }
  });

  test("L1 prices literals raw and keeps its greedy parse", () => {
    // L1 never Huffman-codes literals, so its cost model must value them at 8
    // bits — pricing them lower would drop matches L1 should still take.
    const data = mixedCorpus(40_000);
    const frame = compressFast(data);
    assertRoundTrips(frame, data, "L1 mixed");
    const seqs = blocks(frame).reduce((acc, b) => acc + Math.max(0, b.numSequences), 0);
    assert.ok(seqs > 500, `expected L1 to keep emitting matches, got ${seqs}`);
  });
});
