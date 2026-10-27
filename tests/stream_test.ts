/**
 * Push and TransformStream encode/decode.
 *
 * Exercises the surfaces the way a caller would: arbitrary chunk boundaries,
 * `pipeThrough` composition, early block emit, and failure as a stream
 * rejection rather than a throw. One-shot framing is pinned here too so a
 * streaming change cannot silently drop FCS or the digest from `compress*`.
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { decompress as zripDecompress } from "@paddor/zrip";
import { ZstdError, ZstdErrorCode } from "../dist/decompress.js";
import { CompressFast, compressFast, compressFastStream } from "../dist/compressFast.js";
import { CompressStrong, compressStrong, compressStrongStream } from "../dist/compressStrong.js";
import { compressUltra } from "../dist/compressUltra.js";
import { Decompress, decompress, decompressStream } from "../dist/index.js";
import * as compressUltraMod from "../dist/compressUltra.js";
import { huffmanLiteralsPayload } from "./helpers/corpus.ts";
import { frameHeaderSize, walkBlocks } from "./helpers/frame.ts";
import { ensureZrip } from "./helpers/zrip_init.ts";
import { hasZstdCli, zstdCompress, zstdDecompress } from "./helpers/zstd_cli.ts";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

const WINDOW_1MIB = 1024 * 1024;
const BLOCK_MAX = 128 * 1024;
/** 1 MiB power-of-two window descriptor: exponent 10, mantissa 0. */
const WINDOW_DESC_1MIB = 10 << 3;

function payload(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const unit = bytes('{"id":0,"name":"alpha","v":123456}\n');
  for (let i = 0; i < n; i += unit.length) {
    out.set(unit.subarray(0, Math.min(unit.length, n - i)), i);
  }
  return out;
}

/** Feed `frame` through the transform in `chunk`-sized pieces, collect output. */
async function runStream(frame: Uint8Array, chunk: number): Promise<Uint8Array> {
  const src = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < frame.length; i += chunk) {
        controller.enqueue(frame.subarray(i, Math.min(i + chunk, frame.length)));
      }
      controller.close();
    },
  });
  const parts: Array<Uint8Array> = [];
  let total = 0;
  for await (const part of src.pipeThrough(decompressStream())) {
    parts.push(part);
    total += part.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function concatParts(parts: ReadonlyArray<Uint8Array>): Uint8Array {
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

type Ctor = new (ondata?: (data: Uint8Array, final?: boolean) => unknown) => {
  push(chunk: Uint8Array, final?: boolean): void;
};

function collectPush(Ctor: Ctor, src: Uint8Array, chunk: number): Uint8Array {
  const parts: Array<Uint8Array> = [];
  const enc = new Ctor((data) => {
    if (data.length > 0) parts.push(data.slice());
  });
  if (src.length === 0 || chunk <= 0 || chunk >= src.length) {
    enc.push(src, true);
  } else {
    for (let i = 0; i < src.length; i += chunk) {
      const end = Math.min(i + chunk, src.length);
      enc.push(src.subarray(i, end), end === src.length);
    }
  }
  return concatParts(parts);
}

async function runCompressStream(
  factory: () => TransformStream<Uint8Array, Uint8Array>,
  src: Uint8Array,
  chunk: number,
): Promise<Uint8Array> {
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      if (src.length === 0) {
        controller.close();
        return;
      }
      for (let i = 0; i < src.length; i += chunk) {
        controller.enqueue(src.subarray(i, Math.min(i + chunk, src.length)));
      }
      controller.close();
    },
  });
  const parts: Array<Uint8Array> = [];
  for await (const part of input.pipeThrough(factory())) {
    parts.push(part);
  }
  return concatParts(parts);
}

function assertStreamingHeader(frame: Uint8Array): void {
  assert.deepEqual([...frame.subarray(0, 4)], [0x28, 0xb5, 0x2f, 0xfd], "magic");
  const fd = frame[4] ?? 0;
  assert.equal(fd >> 6, 0, "FCS flag must be 00");
  assert.equal((fd >> 5) & 1, 0, "must not be single-segment");
  assert.equal(fd & 4, 4, "checksum flag");
  assert.equal(fd & 3, 0, "no dictionary");
  assert.equal(frame[5], WINDOW_DESC_1MIB, "1 MiB window descriptor");
  assert.equal(frameHeaderSize(frame), 6);
}

function hasFcs(frame: Uint8Array): boolean {
  const flg = frame[4] ?? 0;
  return flg >> 6 !== 0 || ((flg >> 5) & 1) !== 0;
}

function hasChecksumFlag(frame: Uint8Array): boolean {
  return ((frame[4] ?? 0) & 4) === 4;
}

function skippableFrame(user: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + user.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x184d2a50, true);
  dv.setUint32(4, user.length, true);
  out.set(user, 8);
  return out;
}

function joinFrames(...parts: Array<Uint8Array>): Uint8Array {
  return concatParts(parts);
}

/** Literals_Block_Type for each compressed block. Type 2 = Huffman literals. */
function compressedBlockLiteralTypes(frame: Uint8Array): Array<number> {
  const litTypes: Array<number> = [];
  for (const b of walkBlocks(frame)) {
    if (b.type !== 2) continue;
    const hdr = frame[b.pos + 3];
    assert.ok(hdr !== undefined, "missing literals header");
    litTypes.push(hdr & 3);
  }
  return litTypes;
}

function collectDecompressPush(frame: Uint8Array, chunk: number): Uint8Array {
  const parts: Array<Uint8Array> = [];
  const dec = new Decompress((data) => {
    if (data.length > 0) parts.push(data.slice());
  });
  if (frame.length === 0 || chunk <= 0 || chunk >= frame.length) {
    dec.push(frame, true);
  } else {
    for (let i = 0; i < frame.length; i += chunk) {
      const end = Math.min(i + chunk, frame.length);
      dec.push(frame.subarray(i, end), end === frame.length);
    }
  }
  return concatParts(parts);
}

async function pipeEncodeDecode(
  factory: () => TransformStream<Uint8Array, Uint8Array>,
  src: Uint8Array,
  chunk: number,
): Promise<Uint8Array> {
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      if (src.length === 0) {
        controller.close();
        return;
      }
      for (let i = 0; i < src.length; i += chunk) {
        controller.enqueue(src.subarray(i, Math.min(i + chunk, src.length)));
      }
      controller.close();
    },
  });
  const parts: Array<Uint8Array> = [];
  for await (const part of input.pipeThrough(factory()).pipeThrough(decompressStream())) {
    parts.push(part);
  }
  return concatParts(parts);
}

function assertStreamingFrame(frame: Uint8Array, src: Uint8Array, label: string): void {
  assertStreamingHeader(frame);
  const blocks = walkBlocks(frame);
  assert.ok(blocks.length > 0, `${label}: no blocks`);
  assert.equal(blocks[blocks.length - 1]?.last, true, `${label}: last block`);
  // Checksum is 4 bytes after the last block.
  const last = blocks[blocks.length - 1];
  if (last === undefined) return;
  const after = last.pos + 3 + (last.type === 1 ? 1 : last.size);
  assert.equal(frame.length, after + 4, `${label}: checksum tail`);
  assert.deepEqual(decompress(frame), src, `${label} wzstd`);
  assert.deepEqual(zripDecompress(frame), src, `${label} zrip`);
  if (hasZstdCli()) {
    assert.deepEqual(zstdDecompress(frame), src, `${label} zstd-cli`);
  }
}

describe("decompressStream", () => {
  test("matches one-shot decompress across chunk sizes", async () => {
    const src = payload(400_000);
    const frame = compressStrong(src);
    // 1-byte chunks split every header and bitstream field; huge chunks take
    // the whole-frame path. Both must land on the same bytes.
    for (const chunk of [1, 7, 64, 1024, 65_536, frame.length * 2]) {
      // oxlint-disable-next-line no-await-in-loop -- chunk sizes run in sequence
      assert.deepEqual(await runStream(frame, chunk), src, `chunk=${chunk}`);
    }
  });

  test("handles frames with no content size", { skip: !hasZstdCli() }, () => {
    // `zstd` reading a pipe omits FCS — the shape a streaming producer emits,
    // and the one a stream consumer is most likely to meet.
    const src = payload(300_000);
    const frame = zstdCompress(src, 3);
    return runStream(frame, 4096).then((out) => {
      assert.deepEqual(out, src);
    });
  });

  test("multi-frame input concatenates", async () => {
    const a = payload(50_000);
    const b = bytes("second frame ".repeat(500));
    const fa = compressStrong(a);
    const fb = compressStrong(b);
    const joined = new Uint8Array(fa.length + fb.length);
    joined.set(fa, 0);
    joined.set(fb, fa.length);
    const expected = new Uint8Array(a.length + b.length);
    expected.set(a, 0);
    expected.set(b, a.length);
    assert.deepEqual(await runStream(joined, 1000), expected);
  });

  test("empty input yields empty output", async () => {
    const frame = compressStrong(new Uint8Array(0));
    assert.deepEqual(await runStream(frame, 8), new Uint8Array(0));
  });

  test("truncated input rejects the stream", async () => {
    const frame = compressStrong(payload(100_000));
    await assert.rejects(
      () => runStream(frame.subarray(0, frame.length - 40), 512),
      (err: unknown) => err instanceof ZstdError,
    );
  });

  test("corrupt input fails as ZstdError, never as anything else", async () => {
    // Our frames carry a content checksum and verification is on by default,
    // so most of these trials reject. The contract under test is the error
    // *type* on the reject path — a caller catching ZstdError should never
    // be surprised by a RangeError from the wide bitstream reads. (Frames
    // with no digest can still return wrong bytes as success; that path is
    // covered in checksum_test, not here.)
    const src = payload(100_000);
    const frame = compressStrong(src);
    let seed = 24_601;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
    let rejected = 0;
    let decodedDifferently = 0;
    for (let trial = 0; trial < 60; trial++) {
      const bad = frame.slice();
      for (let k = 0; k < 4; k++) {
        const at = 20 + Math.floor(rnd() * (bad.length - 20));
        bad[at] = Math.floor(rnd() * 256);
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- trials run in sequence
        const out = await runStream(bad, 512);
        if (out.length !== src.length) decodedDifferently++;
      } catch (err) {
        assert.ok(
          err instanceof ZstdError,
          `expected ZstdError, got ${err instanceof Error ? err.constructor.name : typeof err}: ${String(err)}`,
        );
        rejected++;
      }
    }
    // Sanity: the corruption is doing something, not silently no-oping.
    assert.ok(rejected + decodedDifferently > 0, "corruption had no observable effect");
  });

  test("output blocks are owned, not views into decoder state", async () => {
    // If a block were a view into the sliding window, a later block would
    // mutate an already-enqueued chunk and the joined result would be wrong.
    const src = payload(600_000);
    const out = await runStream(compressStrong(src), 8192);
    assert.deepEqual(out, src);
    assert.deepEqual(decompress(compressStrong(src)), src);
  });

  test("skippable frames are skipped on the TransformStream path", async () => {
    const src = payload(20_000);
    const frame = compressStrong(src);
    const skip = skippableFrame(bytes("meta"));
    assert.deepEqual(await runStream(joinFrames(skip, frame, skip), 64), src);
  });
});

describe("Decompress push", () => {
  test("matches one-shot and TransformStream on a streaming Fast frame", async () => {
    const src = payload(180_000);
    const frame = collectPush(CompressFast, src, 4096);
    assert.equal(hasFcs(frame), false);
    const oneShot = decompress(frame);
    for (const chunk of [1, 17, 4096, frame.length]) {
      assert.deepEqual(collectDecompressPush(frame, chunk), oneShot, `push chunk=${chunk}`);
    }
    assert.deepEqual(await runStream(frame, 333), oneShot);
  });

  test("concatenates data frames and ignores skippable ones", () => {
    const a = payload(8_000);
    const b = payload(9_000);
    const fa = collectPush(CompressFast, a, 1024);
    const fb = collectPush(CompressStrong, b, 1024);
    const skip = skippableFrame(bytes("seek-table"));
    const joined = joinFrames(skip, fa, skip, fb);
    const expected = joinFrames(a, b);
    assert.deepEqual(collectDecompressPush(joined, 100), expected);
    assert.deepEqual(decompress(joined), expected);
  });

  test("empty non-final pushes do not change the result", () => {
    const src = payload(12_000);
    const frame = compressFast(src);
    const parts: Array<Uint8Array> = [];
    const dec = new Decompress((data) => {
      if (data.length > 0) parts.push(data.slice());
    });
    dec.push(new Uint8Array(0));
    dec.push(frame.subarray(0, 40));
    dec.push(new Uint8Array(0));
    dec.push(frame.subarray(40));
    dec.push(new Uint8Array(0), true);
    assert.deepEqual(concatParts(parts), src);
  });

  test("ondata can be bound after construct", () => {
    const src = payload(4_000);
    const frame = compressStrong(src);
    const parts: Array<Uint8Array> = [];
    const dec = new Decompress();
    dec.ondata = (data) => {
      if (data.length > 0) parts.push(data.slice());
    };
    dec.push(frame, true);
    assert.deepEqual(concatParts(parts), src);
  });
});

describe("compressFast / compressStrong streams", () => {
  before(async () => {
    await ensureZrip();
  });

  const tiers = [
    ["Fast", CompressFast, compressFastStream],
    ["Strong", CompressStrong, compressStrongStream],
  ] as const;

  for (const [name, Ctor, factory] of tiers) {
    test(`${name} push matches decode across chunk sizes`, () => {
      const src = payload(400_000);
      for (const chunk of [1, 7, 64, 1024, 65_536, src.length * 2]) {
        const frame = collectPush(Ctor, src, chunk);
        assertStreamingFrame(frame, src, `${name} push chunk=${chunk}`);
      }
    });

    test(`${name} TransformStream matches push`, async () => {
      const src = payload(300_000);
      const viaPush = collectPush(Ctor, src, 4096);
      const viaStream = await runCompressStream(factory, src, 4096);
      assert.deepEqual(decompress(viaStream), src);
      assert.deepEqual(viaStream, viaPush);
    });

    test(`${name} empty input is a checksummed empty frame`, () => {
      const frame = collectPush(Ctor, new Uint8Array(0), 8);
      assertStreamingFrame(frame, new Uint8Array(0), `${name} empty`);
    });

    test(`${name} compactifies past the 1 MiB window`, () => {
      // Larger than the match window so EncodeStream must drop history and
      // rebuild the hash chain. Decode still has to round-trip.
      const src = payload(WINDOW_1MIB + 200_000);
      const frame = collectPush(Ctor, src, 50_000);
      assertStreamingFrame(frame, src, `${name} >window`);
    });

    test(`${name} emits blocks before flush`, () => {
      const src = payload(BLOCKISH);
      const parts: Array<Uint8Array> = [];
      const enc = new Ctor((data: Uint8Array) => {
        if (data.length > 0) parts.push(data.slice());
      });
      enc.push(src.subarray(0, 200_000));
      assert.ok(parts.length > 0, `${name}: header + first block should leave before flush`);
      enc.push(src.subarray(200_000), true);
      assertStreamingFrame(concatParts(parts), src, `${name} early emit`);
    });

    test(`${name} push after final throws`, () => {
      const enc = new Ctor();
      enc.push(bytes("ok"), true);
      assert.throws(() => enc.push(bytes("more")), TypeError);
    });
  }

  test("a match that starts on a 128 KiB block seam is taken", () => {
    // Distinct bytes, then copy 32 bytes from the end of block 0 onto the
    // start of block 1. If insertThrough hashed leftover allocation tail at
    // the seam, those 32 bytes stay literals and the frame balloons.
    const src = new Uint8Array(BLOCK_MAX + 64);
    for (let i = 0; i < src.length; i++) src[i] = (Math.imul(i + 17, 1103515245) >>> 24) & 0xff;
    src.set(src.subarray(BLOCK_MAX - 32, BLOCK_MAX), BLOCK_MAX);
    const streamed = collectPush(CompressFast, src, BLOCK_MAX);
    const oneshot = compressFast(src);
    assert.deepEqual(decompress(streamed), src);
    // Streaming header is 6 bytes, one-shot at this size is 9. A missed
    // 32-byte match costs far more than that.
    assert.ok(
      streamed.length <= oneshot.length + 16,
      `streaming ${streamed.length} vs one-shot ${oneshot.length}`,
    );
  });

  test("a single large push stays bounded and still compactifies", () => {
    const src = payload(WINDOW_1MIB + 400_000);
    const frame = collectPush(CompressFast, src, src.length);
    assertStreamingFrame(frame, src, "Fast single 1.4 MiB push");
  });

  test("a match that only lives in retained history after compact is taken", () => {
    // Block 8 crosses the window and rebuilds the chain; block 9 must still
    // see a 32-byte copy from just before the 1 MiB mark.
    const src = new Uint8Array(WINDOW_1MIB + BLOCK_MAX + 64);
    for (let i = 0; i < src.length; i++) src[i] = (Math.imul(i + 3, 1103515245) >>> 24) & 0xff;
    src.set(src.subarray(WINDOW_1MIB - 32, WINDOW_1MIB), WINDOW_1MIB + BLOCK_MAX);
    const streamed = collectPush(CompressFast, src, BLOCK_MAX);
    const oneshot = compressFast(src);
    assert.deepEqual(decompress(streamed), src);
    assert.ok(
      streamed.length <= oneshot.length + 24,
      `streaming ${streamed.length} vs one-shot ${oneshot.length}`,
    );
  });

  test("last-chunk final and empty-final produce the same frame", () => {
    const src = payload(50_000);
    for (const Ctor of [CompressFast, CompressStrong]) {
      const viaLast = collectPush(Ctor, src, src.length);
      const parts: Array<Uint8Array> = [];
      const enc = new Ctor((data: Uint8Array) => {
        if (data.length > 0) parts.push(data.slice());
      });
      enc.push(src);
      enc.push(new Uint8Array(0), true);
      assert.deepEqual(concatParts(parts), viaLast, `${Ctor.name} final shape`);
    }
  });

  test("empty non-final pushes do not change the frame", () => {
    const src = payload(20_000);
    const parts: Array<Uint8Array> = [];
    const enc = new CompressFast((data: Uint8Array) => {
      if (data.length > 0) parts.push(data.slice());
    });
    enc.push(new Uint8Array(0));
    enc.push(src.subarray(0, 3_000));
    enc.push(new Uint8Array(0));
    enc.push(src.subarray(3_000), true);
    assertStreamingFrame(concatParts(parts), src, "Fast empty mid-push");
  });

  test("ondata can be bound after construct", () => {
    const src = payload(8_000);
    const parts: Array<Uint8Array> = [];
    const enc = new CompressStrong();
    enc.ondata = (data) => {
      if (data.length > 0) parts.push(data.slice());
    };
    enc.push(src, true);
    assertStreamingFrame(concatParts(parts), src, "Strong late ondata");
  });

  test("tiny, RLE, and incompressible payloads stream", () => {
    const random = new Uint8Array(8_000);
    for (let i = 0; i < random.length; i++) {
      random[i] = (Math.imul(i + 19, 1103515245) >>> 24) & 0xff;
    }
    const cases: Array<[string, Uint8Array]> = [
      ["1 byte", new Uint8Array([0x61])],
      ["3 bytes", bytes("ok!")],
      ["all zeros", new Uint8Array(50_000)],
      ["incompressible", random],
    ];
    for (const [label, src] of cases) {
      assertStreamingFrame(collectPush(CompressFast, src, 64), src, `Fast ${label}`);
      assertStreamingFrame(collectPush(CompressStrong, src, 64), src, `Strong ${label}`);
    }
  });

  test("Strong streaming still emits Huffman literals", () => {
    const src = huffmanLiteralsPayload(800);
    const frame = collectPush(CompressStrong, src, 200);
    const litTypes = compressedBlockLiteralTypes(frame);
    assert.ok(litTypes.includes(2), `expected Huffman type 2, got ${JSON.stringify(litTypes)}`);
    assertStreamingFrame(frame, src, "Strong Huffman stream");
  });

  test("a flipped streaming digest is ChecksumMismatch on every decode path", async () => {
    const src = payload(30_000);
    const frame = collectPush(CompressFast, src, 4096);
    assert.equal(hasChecksumFlag(frame), true);
    const bad = frame.slice();
    const last = bad.length - 1;
    bad[last] = (bad[last] ?? 0) ^ 0xff;
    const isMismatch = (err: unknown): boolean =>
      err instanceof ZstdError && err.code === ZstdErrorCode.ChecksumMismatch;
    assert.throws(() => decompress(bad), isMismatch);
    assert.throws(() => collectDecompressPush(bad, 97), isMismatch);
    await assert.rejects(() => runStream(bad, 97), isMismatch);
    assert.deepEqual(decompress(bad, { checksum: false }), src);
  });

  test("TransformStream empty and 1-byte chunks match push", async () => {
    const empty = await runCompressStream(compressFastStream, new Uint8Array(0), 8);
    assertStreamingFrame(empty, new Uint8Array(0), "Fast stream empty");
    const src = payload(6_000);
    const viaPush = collectPush(CompressStrong, src, 1);
    const viaStream = await runCompressStream(compressStrongStream, src, 1);
    assert.deepEqual(viaStream, viaPush);
    assertStreamingFrame(viaStream, src, "Strong 1-byte TransformStream");
  });

  test("pipeThrough compress then decompress recovers the payload", async () => {
    const src = payload(80_000);
    assert.deepEqual(await pipeEncodeDecode(compressFastStream, src, 777), src);
    assert.deepEqual(await pipeEncodeDecode(compressStrongStream, src, 777), src);
    assert.deepEqual(
      await pipeEncodeDecode(compressFastStream, new Uint8Array(0), 8),
      new Uint8Array(0),
    );
  });
});

describe("one-shot framing is unchanged", () => {
  test("one-shot still writes FCS + checksum; streaming still omits FCS", () => {
    const src = payload(40_000);
    for (const [name, frame] of [
      ["Fast", compressFast(src)],
      ["Strong", compressStrong(src)],
      ["Ultra", compressUltra(src)],
    ] as const) {
      assert.equal(hasFcs(frame), true, `${name} one-shot FCS`);
      assert.equal(hasChecksumFlag(frame), true, `${name} one-shot checksum`);
      assert.deepEqual(decompress(frame), src, `${name} one-shot round-trip`);
    }
    for (const [name, Ctor] of [
      ["Fast", CompressFast],
      ["Strong", CompressStrong],
    ] as const) {
      const frame = collectPush(Ctor, src, 4096);
      assert.equal(hasFcs(frame), false, `${name} stream FCS`);
      assert.equal(hasChecksumFlag(frame), true, `${name} stream checksum`);
      assert.deepEqual(decompress(frame), src, `${name} stream via one-shot decode`);
    }
  });

  test("Ultra has no streaming export", () => {
    assert.equal("CompressUltra" in compressUltraMod, false);
    assert.equal("compressUltraStream" in compressUltraMod, false);
    assert.equal(typeof compressUltra, "function");
  });
});

/** Two compressed blocks (128 KiB each) plus slack, so a mid-payload flush is impossible. */
const BLOCKISH = 128 * 1024 * 2 + 50_000;
