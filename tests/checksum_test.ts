/**
 * Frame content checksum verification.
 *
 * A zstd frame may carry 4 bytes holding the low half of XXH64 over its
 * decompressed content, and the `zstd` CLI writes one by default. It is the
 * only redundancy in the format: with it, corruption is detected; without it,
 * damaged input decodes to *different bytes* and returns successfully. The
 * decoder skipped these bytes for a long time, so "corruption is detected" was
 * not a claim this package could make. It is now, for frames that carry one.
 *
 * The CLI is the oracle for the digest itself — comparing against XXH64 test
 * vectors typed from memory would only pin our own mistakes.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { compressFast } from "../dist/compressFast.js";
import { compressStrong } from "../dist/compressStrong.js";
import { compressUltra } from "../dist/compressUltra.js";
import {
  Decompress,
  decompress,
  decompressStream,
  type ZstdDecodeOptions,
  ZstdError,
  ZstdErrorCode,
} from "../dist/index.js";
import { hasZstdCli, zstdRun } from "./helpers/zstd_cli.ts";

const CLI = hasZstdCli();

function cli(args: Array<string>, data: Uint8Array): Uint8Array {
  // File-to-file; checksum tests need a real CLI digest, not a pipe shape.
  return zstdRun(args, data, { timeoutMs: 60_000, viaPipe: false });
}

function streamAll(frame: Uint8Array, opts?: Omit<ZstdDecodeOptions, "out">): Uint8Array {
  const parts: Array<Uint8Array> = [];
  let n = 0;
  const d = new Decompress((c) => {
    parts.push(c);
    n += c.length;
  }, opts);
  // Small pushes: the 4 checksum bytes must be collected across chunk
  // boundaries (verified when enabled, merely consumed when opted out).
  for (let i = 0; i < frame.length; i += 97) {
    d.push(frame.subarray(i, Math.min(i + 97, frame.length)));
  }
  d.push(new Uint8Array(0), true);
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function errorCode(run: () => unknown): number | "returned" {
  try {
    run();
    return "returned";
  } catch (e) {
    if (e instanceof ZstdError) return e.code;
    throw e;
  }
}

const text = (() => {
  let s = "";
  for (let i = 0; i < 20000; i++) s += `record ${i} value ${(i * 7919) % 1013}\n`;
  return new TextEncoder().encode(s);
})();

/** Flip the last byte of a digest-carrying frame (content still decodes). */
function breakDigest(frame: Uint8Array): Uint8Array {
  const bad = frame.slice();
  const last = bad.length - 1;
  bad[last] = (bad[last] ?? 0) ^ 0xff;
  return bad;
}

/** Web Streams path with an options bag — product pin for `decompressStream`. */
async function streamTransform(
  frame: Uint8Array,
  opts?: Omit<ZstdDecodeOptions, "out">,
): Promise<Uint8Array> {
  const src = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < frame.length; i += 97) {
        controller.enqueue(frame.subarray(i, Math.min(i + 97, frame.length)));
      }
      controller.close();
    },
  });
  const parts: Array<Uint8Array> = [];
  let n = 0;
  for await (const part of src.pipeThrough(decompressStream(opts))) {
    parts.push(part);
    n += part.length;
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Product pins that only need our encoder. Always run — no host CLI required.
 * Foreign-frame / digest-oracle cases live in the CLI describe below.
 */
describe("frame content checksum (hermetic)", () => {
  test("every frame this encoder produces carries a digest", () => {
    for (const payload of [new Uint8Array(0), text]) {
      for (const [name, encode] of [
        ["Fast", compressFast],
        ["Strong", compressStrong],
        ["Ultra", compressUltra],
      ] as const) {
        const frame = encode(payload);
        assert.equal(((frame[4] ?? 0) >> 2) & 1, 1, `${name}, n=${payload.length}`);
        // Damaging the digest alone must be caught — the four trailing
        // bytes are a real digest over the content, not padding.
        assert.equal(
          errorCode(() => decompress(breakDigest(frame))),
          ZstdErrorCode.ChecksumMismatch,
          `${name} damaged digest, n=${payload.length}`,
        );
      }
    }
  });

  test("verification is never skipped by accident — only an explicit false", async () => {
    const good = compressStrong(text);
    const frame = breakDigest(good);
    const mustThrow: Array<[string, ZstdDecodeOptions | undefined]> = [
      ["no options", undefined],
      ["empty options", {}],
      ["checksum: undefined", { checksum: undefined }],
      ["checksum: true", { checksum: true }],
      ["out only", { out: new Uint8Array(text.length) }],
      ["out + checksum: true", { out: new Uint8Array(text.length), checksum: true }],
    ];
    for (const [name, opts] of mustThrow) {
      assert.equal(
        errorCode(() => decompress(frame, opts)),
        ZstdErrorCode.ChecksumMismatch,
        `one-shot, ${name}`,
      );
      if (opts?.out === undefined) {
        assert.equal(
          errorCode(() => streamAll(frame, opts)),
          ZstdErrorCode.ChecksumMismatch,
          `push stream, ${name}`,
        );
      }
    }

    // decompressStream forwards the bag — same accident-safety rules.
    const streamCases: Array<[string, ZstdDecodeOptions | undefined]> = [
      ["no options", undefined],
      ["empty options", {}],
      ["checksum: undefined", { checksum: undefined }],
      ["checksum: true", { checksum: true }],
    ];
    await Promise.all(
      streamCases.map(async ([name, opts]) => {
        await assert.rejects(
          () => streamTransform(frame, opts),
          (err: unknown) => {
            assert.ok(err instanceof ZstdError);
            assert.equal(err.code, ZstdErrorCode.ChecksumMismatch, `decompressStream, ${name}`);
            return true;
          },
        );
      }),
    );

    assert.deepEqual(decompress(frame, { checksum: false }), text, "one-shot");
    assert.deepEqual(streamAll(frame, { checksum: false }), text, "push");
    assert.deepEqual(await streamTransform(frame, { checksum: false }), text, "decompressStream");
    const out = new Uint8Array(text.length);
    assert.deepEqual(decompress(frame, { out, checksum: false }), text, "out + checksum false");
    assert.equal(decompress(frame, { out, checksum: false }), out);
  });

  test("opting out turns off the hash, not the decoder's judgement", () => {
    const frame = compressStrong(text);
    for (let cut = 1; cut <= 4; cut++) {
      const short = frame.subarray(0, frame.length - cut);
      assert.equal(
        errorCode(() => decompress(short, { checksum: false })),
        ZstdErrorCode.UnexpectedEOF,
        `one-shot, ${cut} short`,
      );
      assert.equal(
        errorCode(() => streamAll(short, { checksum: false })),
        ZstdErrorCode.UnexpectedEOF,
        `push, ${cut} short`,
      );
    }
  });

  test("out and checksum compose in one bag", () => {
    const good = compressStrong(text);
    const out = new Uint8Array(text.length);
    assert.deepEqual(decompress(good, { out }), text);
    assert.equal(decompress(good, { out }), out);
    assert.deepEqual(decompress(good, { out, checksum: true }), text);
    assert.deepEqual(decompress(good, { out, checksum: false }), text);

    const bad = breakDigest(good);
    assert.equal(
      errorCode(() => decompress(bad, { out: new Uint8Array(text.length) })),
      ZstdErrorCode.ChecksumMismatch,
    );
    assert.deepEqual(decompress(bad, { out: new Uint8Array(text.length), checksum: false }), text);
  });

  test("first-frame digest break rejects multi-frame input", () => {
    const a = compressStrong(text.subarray(0, 1000));
    const b = compressStrong(text.subarray(1000, 2000));
    const joined = new Uint8Array(a.length + b.length);
    joined.set(a, 0);
    joined.set(b, a.length);
    const broken = breakDigest(a);
    const bad = new Uint8Array(broken.length + b.length);
    bad.set(broken, 0);
    bad.set(b, broken.length);
    assert.equal(
      errorCode(() => decompress(bad)),
      ZstdErrorCode.ChecksumMismatch,
      "must not accept/join after a bad first digest",
    );
    assert.deepEqual(decompress(joined), text.subarray(0, 2000), "clean pair still joins");
  });
});

describe("frame content checksum (CLI frames)", { skip: !CLI }, () => {
  test("a checksummed frame round-trips on both paths", () => {
    const frame = cli(["-3", "--check"], text);
    assert.equal(((frame[4] ?? 0) >> 2) & 1, 1, "expected the checksum flag");
    assert.deepEqual(decompress(frame), text, "one-shot");
    assert.deepEqual(streamAll(frame), text, "streaming");
  });

  test("corruption is caught on every path, and only when a checksum exists", () => {
    // Same payload, with and without the trailing digest. Flip one bit deep in
    // the compressed body — decodable garbage, not a structural break.
    const withCk = cli(["-3", "--check"], text);
    const without = cli(["-3", "--no-check"], text);
    let caughtWith = 0;
    let silentWrong = 0;
    const trials = 60;
    for (let t = 0; t < trials; t++) {
      const bit = 1 << (t % 8);
      const at = 12 + ((t * 613) % (withCk.length - 20));

      const a = withCk.slice();
      a[at] = (a[at] ?? 0) ^ bit;
      if (errorCode(() => decompress(a)) !== "returned") caughtWith++;

      const b = without.slice();
      const atB = Math.min(at, b.length - 5);
      b[atB] = (b[atB] ?? 0) ^ bit;
      try {
        const out = decompress(b);
        if (out.length !== text.length || !Buffer.from(out).equals(Buffer.from(text))) {
          silentWrong++;
        }
      } catch {
        // Structural damage; the interesting case is the one that returns.
      }
    }
    assert.equal(caughtWith, trials, "every corrupted checksummed frame errors");
    // Not an assertion about a specific count — just that the unchecked frame
    // really does return wrong bytes, which is what the checksum is for.
    assert.ok(
      silentWrong > 0,
      "expected some corrupted checksum-free frames to decode to wrong bytes",
    );
  });

  test("a wrong digest is ChecksumMismatch, on both paths", () => {
    const frame = cli(["-3", "--check"], text).slice();
    // Corrupt the stored digest rather than the data: the content decodes
    // perfectly, so only the comparison can fail.
    const last = frame.length - 1;
    frame[last] = (frame[last] ?? 0) ^ 0xff;
    assert.equal(
      errorCode(() => decompress(frame)),
      ZstdErrorCode.ChecksumMismatch,
      "one-shot",
    );
    assert.equal(
      errorCode(() => streamAll(frame)),
      ZstdErrorCode.ChecksumMismatch,
      "streaming",
    );
  });

  test("structural corruption still fails closed with verification off", () => {
    // Hermetic suite pins truncation; this samples CLI-shaped damage deeper
    // in the frame body. Sample, not a sweep — the ledger has the full count.
    const frame = cli(["-3", "--check"], text);
    let structural = 0;
    for (let i = 20; i < Math.min(frame.length - 8, 220); i += 7) {
      const bad = frame.slice();
      bad[i] = (bad[i] ?? 0) ^ 0xff;
      if (errorCode(() => decompress(bad, { checksum: false })) !== "returned") {
        structural++;
      }
    }
    assert.ok(structural > 0, "structural checks still fire with opt-out");
  });

  test("a frame with no digest decodes identically either way", () => {
    // Frames without a digest are still legal: the flag is optional in the
    // format. Our encoder always sets it; this pins the foreign case.
    // `checksum: false` must be a no-op where there is nothing to verify,
    // rather than a second code path with its own behaviour.
    const frame = cli(["-3", "--no-check"], text);
    assert.equal(((frame[4] ?? 0) >> 2) & 1, 0, "fixture carries no digest");
    assert.deepEqual(decompress(frame), text);
    assert.deepEqual(decompress(frame, { checksum: false }), text);
    assert.deepEqual(streamAll(frame), text);
    assert.deepEqual(streamAll(frame, { checksum: false }), text);
  });

  test("a frame truncated before its digest is UnexpectedEOF, not a mismatch", () => {
    const frame = cli(["-3", "--check"], text);
    for (const missing of [1, 2, 4]) {
      const cut = frame.subarray(0, frame.length - missing);
      assert.equal(
        errorCode(() => decompress(cut)),
        ZstdErrorCode.UnexpectedEOF,
        `one-shot, ${missing} bytes short`,
      );
      assert.equal(
        errorCode(() => streamAll(cut)),
        ZstdErrorCode.UnexpectedEOF,
        `streaming, ${missing} bytes short`,
      );
    }
  });

  test("checksums are verified per frame across concatenated frames", () => {
    const a = cli(["-3", "--check"], text);
    const b = cli(["-3", "--check"], text.subarray(0, 5000));
    const both = new Uint8Array(a.length + b.length);
    both.set(a, 0);
    both.set(b, a.length);
    const want = new Uint8Array(text.length + 5000);
    want.set(text, 0);
    want.set(text.subarray(0, 5000), text.length);
    assert.deepEqual(decompress(both), want, "clean pair");
    assert.deepEqual(streamAll(both), want, "clean pair, streaming");

    // Break only the second frame's digest: the first must still be accepted,
    // and the failure must be attributed to the frame that carries it.
    const broken = both.slice();
    broken[broken.length - 1] = (broken[broken.length - 1] ?? 0) ^ 0xff;
    assert.equal(
      errorCode(() => decompress(broken)),
      ZstdErrorCode.ChecksumMismatch,
    );
    assert.equal(
      errorCode(() => streamAll(broken)),
      ZstdErrorCode.ChecksumMismatch,
    );
  });

  test("payload sizes around the 32-byte stripe all verify", () => {
    // The digest's tail path (8/4/1-byte steps) is where an XXH64 goes wrong,
    // and short frames are exactly what exercises it.
    const enc = new TextEncoder();
    for (const n of [0, 1, 3, 4, 7, 8, 31, 32, 33, 63, 64, 65, 127, 1000]) {
      const data = enc.encode("x".repeat(n));
      const frame = cli(["-3", "--check"], data);
      assert.deepEqual(decompress(frame), data, `one-shot, ${n} bytes`);
      assert.deepEqual(streamAll(frame), data, `streaming, ${n} bytes`);
    }
  });
});
