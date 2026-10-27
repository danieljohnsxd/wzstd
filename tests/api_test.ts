import assert from "node:assert/strict";
import { test } from "node:test";
import { Decompress, decompress, ZstdError, ZstdErrorCode } from "../dist/index.js";

/** Compressed "Ok" fixture (same bytes as simple_cases_test). */
const OK_COMPRESSED = new Uint8Array([
  0x28, 0xb5, 0x2f, 0xfd, 0x24, 0x02, 0x11, 0x00, 0x00, 0x4f, 0x6b, 0x64, 0x50, 0xa9, 0x5a,
]);

/** Compressed Lorem ipsum fixture (same bytes as simple_cases_test). */
const LOREM_COMPRESSED = new Uint8Array([
  0x28, 0xb5, 0x2f, 0xfd, 0x24, 0x84, 0xfd, 0x02, 0x00, 0x92, 0x07, 0x15, 0x13, 0x90, 0x07, 0x0c,
  0xc9, 0x6e, 0xbb, 0x5b, 0x93, 0x4c, 0x3e, 0x07, 0xb5, 0xe6, 0x59, 0xf1, 0x89, 0x6b, 0x52, 0xe9,
  0x83, 0xda, 0x40, 0xf8, 0x2d, 0xed, 0x1e, 0xa9, 0xcb, 0x01, 0x73, 0x2e, 0x97, 0x5d, 0xb9, 0x13,
  0x5b, 0x66, 0x79, 0xaf, 0x81, 0x66, 0xe0, 0x43, 0x50, 0xfb, 0x47, 0xfb, 0x21, 0xfc, 0x89, 0x59,
  0x0b, 0x3e, 0xb8, 0x8c, 0x4e, 0xc0, 0x9a, 0xad, 0x42, 0x15, 0x72, 0x6d, 0x26, 0x1e, 0x5a, 0xcc,
  0x39, 0xc1, 0x74, 0x72, 0xae, 0xbd, 0xa6, 0x65, 0xf1, 0xeb, 0x2d, 0xd4, 0x8f, 0x34, 0x01, 0x01,
  0x02, 0x00, 0x3e, 0x53, 0x53, 0xb3, 0xe6, 0x19, 0xb0, 0x58, 0x5b, 0x26,
]);

const LOREM_TEXT =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam nec sem urna. Morbi mollis, massa a convallis iaculis, mauris neque.";

function concatChunks(chunks: Array<Uint8Array>): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function streamDecompress(
  compressed: Uint8Array,
  chunkSize: number,
  finalEmpty = false,
): Uint8Array {
  const parts: Array<Uint8Array> = [];
  const dec = new Decompress((data, final) => {
    if (data.length > 0) parts.push(data.slice());
    if (final && data.length === 0) {
      // end-of-stream marker; no payload
    }
  });

  if (chunkSize <= 0 || chunkSize >= compressed.length) {
    if (finalEmpty) {
      dec.push(compressed);
      dec.push(new Uint8Array(0), true);
    } else {
      dec.push(compressed, true);
    }
  } else {
    for (let i = 0; i < compressed.length; i += chunkSize) {
      const end = Math.min(i + chunkSize, compressed.length);
      const slice = compressed.subarray(i, end);
      const isLast = end === compressed.length;
      if (isLast && !finalEmpty) {
        dec.push(slice, true);
      } else {
        dec.push(slice);
      }
    }
    if (finalEmpty) {
      dec.push(new Uint8Array(0), true);
    }
  }

  return concatChunks(parts);
}

function assertZstdError(err: unknown, code: number): asserts err is ZstdError {
  assert.ok(err instanceof ZstdError, "expected ZstdError instance");
  assert.equal(err.code, code, `expected ZstdErrorCode ${code}`);
}

test("streaming Decompress matches one-shot decompress (Ok, multi-chunk)", () => {
  const oneShot = decompress(OK_COMPRESSED);
  for (const chunkSize of [1, 2, 3, 5, 8]) {
    const streamed = streamDecompress(OK_COMPRESSED, chunkSize);
    assert.deepEqual(streamed, oneShot, `chunkSize=${chunkSize} should match one-shot`);
    assert.equal(new TextDecoder().decode(streamed), "Ok");
  }
});

test("streaming Decompress matches one-shot decompress (Lorem, multi-chunk)", () => {
  const oneShot = decompress(LOREM_COMPRESSED);
  for (const chunkSize of [1, 7, 16, 32]) {
    const streamed = streamDecompress(LOREM_COMPRESSED, chunkSize);
    assert.deepEqual(streamed, oneShot, `chunkSize=${chunkSize} should match one-shot`);
    assert.equal(new TextDecoder().decode(streamed), LOREM_TEXT);
  }
});

test("streaming final empty chunk after full push", () => {
  const oneShot = decompress(OK_COMPRESSED);
  const streamed = streamDecompress(OK_COMPRESSED, 4, true);
  assert.deepEqual(streamed, oneShot);
  assert.equal(new TextDecoder().decode(streamed), "Ok");
});

test("streaming final empty chunk with single full push then empty final", () => {
  const parts: Array<Uint8Array> = [];
  let sawFinalEmpty = false;
  const dec = new Decompress((data, final) => {
    if (data.length > 0) parts.push(data.slice());
    if (final === true && data.length === 0) sawFinalEmpty = true;
  });
  dec.push(LOREM_COMPRESSED);
  dec.push(new Uint8Array(0), true);

  const streamed = concatChunks(parts);
  const oneShot = decompress(LOREM_COMPRESSED);
  assert.deepEqual(streamed, oneShot);
  assert.equal(new TextDecoder().decode(streamed), LOREM_TEXT);
  assert.equal(sawFinalEmpty, true);
});

test("preallocated output buffer (exact size)", () => {
  const expected = decompress(OK_COMPRESSED);
  const buf = new Uint8Array(expected.length);
  const result = decompress(OK_COMPRESSED, { out: buf });
  assert.equal(result, buf, "should return the provided buffer");
  assert.deepEqual(result, expected);
  assert.equal(new TextDecoder().decode(result), "Ok");
});

test("bare TypedArray second argument is rejected", () => {
  // Second argument is always an options bag. A bare buffer is a misuse:
  // TypeScript rejects it, and untyped JS must not silently treat it as an
  // empty bag and allocate instead.
  const expected = decompress(OK_COMPRESSED);
  const buf = new Uint8Array(expected.length);
  assert.throws(
    () => {
      // @ts-expect-error — deliberately not an options bag
      decompress(OK_COMPRESSED, buf);
    },
    (err: unknown) => {
      assert.ok(err instanceof TypeError);
      assert.match(String(err), /\{ out \}/);
      return true;
    },
  );
});

test("preallocated output buffer (oversized)", () => {
  const expected = decompress(LOREM_COMPRESSED);
  const buf = new Uint8Array(expected.length + 64);
  const result = decompress(LOREM_COMPRESSED, { out: buf });
  assert.equal(result, buf, "should return the provided buffer");
  // Content is written at the start; trailing bytes may remain zeroed.
  assert.deepEqual(result.subarray(0, expected.length), expected);
  assert.equal(new TextDecoder().decode(result.subarray(0, expected.length)), LOREM_TEXT);
});

test("preallocated output buffer (undersized) throws InvalidData", () => {
  const expected = decompress(OK_COMPRESSED);
  assert.ok(expected.length > 1);
  const buf = new Uint8Array(expected.length - 1);
  assert.throws(
    () => {
      decompress(OK_COMPRESSED, { out: buf });
    },
    (err: unknown) => {
      assertZstdError(err, ZstdErrorCode.InvalidData);
      return true;
    },
  );
});

/**
 * A skippable frame: magic 0x184D2A5?, then a little-endian length and that
 * many bytes of user data. The seekable-zstd format appends one, and tools use
 * them for embedded metadata, so they are the common multi-frame shape in the
 * wild — much more common than genuinely concatenated data frames.
 */
function skippableFrame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x184d2a50, true);
  dv.setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}

function concat(...parts: Array<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

test("skippable frames are accepted, with and without an output buffer", () => {
  const expected = decompress(OK_COMPRESSED);
  const skip = skippableFrame(new Uint8Array([1, 2, 3, 4]));
  for (const [label, framed] of [
    ["trailing", concat(OK_COMPRESSED, skip)],
    ["leading", concat(skip, OK_COMPRESSED)],
    ["both", concat(skip, OK_COMPRESSED, skip)],
  ] as const) {
    assert.deepEqual(decompress(framed), expected, `${label}, auto-alloc`);
    // Skippable frames produce no output, so they cannot collide with the
    // caller buffer the way a second data frame would.
    assert.deepEqual(
      decompress(framed, { out: new Uint8Array(expected.length) }),
      expected,
      `${label}, caller buffer`,
    );
  }
});

test("preallocated buffer rejects multi-frame input", () => {
  const multi = new Uint8Array(OK_COMPRESSED.length + OK_COMPRESSED.length);
  multi.set(OK_COMPRESSED, 0);
  multi.set(OK_COMPRESSED, OK_COMPRESSED.length);
  const expected = decompress(OK_COMPRESSED);
  // Auto-alloc multi-frame still works.
  const auto = decompress(multi);
  assert.equal(auto.length, expected.length * 2);
  const buf = new Uint8Array(expected.length * 2);
  assert.throws(
    () => {
      decompress(multi, { out: buf });
    },
    (err: unknown) => {
      assertZstdError(err, ZstdErrorCode.InvalidData);
      return true;
    },
  );
});

test("wrong FCS throws InvalidData (one-shot and stream)", () => {
  // Clone Ok fixture and bump the 1-byte FCS (byte index 5) so it no longer matches.
  const bad = OK_COMPRESSED.slice();
  const fcs = bad[5] ?? 0;
  bad[5] = (fcs + 1) & 0xff;
  assert.throws(
    () => {
      decompress(bad);
    },
    (err: unknown) => {
      assertZstdError(err, ZstdErrorCode.InvalidData);
      return true;
    },
  );
  assert.throws(
    () => {
      const dec = new Decompress(() => {});
      dec.push(bad, true);
    },
    (err: unknown) => {
      assertZstdError(err, ZstdErrorCode.InvalidData);
      return true;
    },
  );
});

test("invalid data throws InvalidData", () => {
  const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0xff]);
  assert.throws(
    () => {
      decompress(garbage);
    },
    (err: unknown) => {
      assertZstdError(err, ZstdErrorCode.InvalidData);
      return true;
    },
  );
});

test("truncated frame throws UnexpectedEOF", () => {
  // Valid magic + partial header is not enough to finish a frame.
  const truncated = OK_COMPRESSED.subarray(0, 4);
  assert.throws(
    () => {
      decompress(truncated);
    },
    (err: unknown) => {
      assertZstdError(err, ZstdErrorCode.UnexpectedEOF);
      return true;
    },
  );
});

test("round-trip identity: Ok fixture length and TextDecoder", () => {
  const decompressed = decompress(OK_COMPRESSED);
  assert.equal(decompressed.length, 2);
  assert.deepEqual(decompressed, new Uint8Array([0x4f, 0x6b]));
  assert.equal(new TextDecoder().decode(decompressed), "Ok");
});

test("round-trip identity: Lorem fixture length and TextDecoder", () => {
  const decompressed = decompress(LOREM_COMPRESSED);
  assert.equal(decompressed.length, LOREM_TEXT.length);
  assert.equal(new TextDecoder().decode(decompressed), LOREM_TEXT);
});
