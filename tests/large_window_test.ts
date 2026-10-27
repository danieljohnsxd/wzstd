/**
 * Frames declaring a large window, and the ultra levels that produce them.
 *
 * The README used to claim a 2²⁵ backreference ceiling and exclude ultra 20–22.
 * Both were inherited from fzstd and neither matched the code. The limit is now
 * libzstd's default decoder limit, 2²⁷ = 128 MiB (`ZSTD_WINDOWLOG_LIMIT_DEFAULT`),
 * which is exactly what `--ultra -22` and `--long=27` declare, so those decode
 * and `--long=28` does not — the same answer the stock `zstd -d` gives.
 * Documented claims are tested here so they cannot drift in either direction.
 *
 * The second thing pinned here is memory. A frame's declared window is
 * attacker-controlled, and it can be enormous while the payload is tiny — the
 * streaming decoder used to allocate the whole declared window up front, so a
 * 27-byte frame reserved 129 MiB. It now grows toward the window as data
 * actually arrives.
 *
 * The third is that the declared window is a *number the frame chose*, so both
 * ends of its range have to be checked and both decode paths have to agree:
 * above the limit is a `WindowSizeTooLarge` rejection, and a window smaller
 * than the frame's own blocks is `InvalidData`, not silently truncated output.
 * Assertions here name the error code — an earlier `assert.throws()` passed on
 * an unrelated failure for a whole session.
 */
import assert from "node:assert/strict";
import { before as beforeAll, describe, test } from "node:test";
import { Decompress, decompress, ZstdError, ZstdErrorCode } from "../dist/index.js";
import { hasZstdCli, zstdRun } from "./helpers/zstd_cli.ts";

const CLI = hasZstdCli();

/**
 * Compress via the CLI with arbitrary flags, reading stdin (so no FCS).
 * Time-bounded through {@link zstdRun} — unbounded spawnSync is how this file
 * wedged the suite (stuck `zstd -19 --long=27`, worker never exits).
 */
function cli(args: Array<string>, data: Uint8Array): Uint8Array {
  // Must be a non-seekable stdin (`viaPipe`): if zstd knows the size it emits
  // single-segment with window = content size, and --long never shows up in
  // the frame header. Pipe mode uses `cat file | zstd` so Node never writes
  // multi-MB to spawnSync stdin (the old deadlock).
  return zstdRun(args, data, { timeoutMs: 120_000, viaPipe: true });
}

/**
 * Window_Size declared by a frame, or undefined when single-segment.
 *
 * `2 **` and `/ 8`, not `1 <<` and `>> 3` — the exponent field reaches
 * Window_Log 41, and a 32-bit shift wraps. The decoder had this bug.
 */
function declaredWindow(frame: Uint8Array): number | undefined {
  const flg = frame[4] ?? 0;
  if ((flg >> 5) & 1) return undefined;
  const wd = frame[5] ?? 0;
  const base = 2 ** (10 + (wd >> 3));
  return base + (base / 8) * (wd & 7);
}

/**
 * The `ZstdError` code `run` raises, or "decoded" if it returns.
 *
 * Anything that is not a `ZstdError` propagates: a raw `RangeError` out of the
 * decoder is itself a defect, and swallowing it here would hide one.
 */
function code(run: () => void): number | "decoded" {
  try {
    run();
    return "decoded";
  } catch (e) {
    if (e instanceof ZstdError) return e.code;
    throw e;
  }
}

/** The error code both decode paths raise for `frame`, or "decoded". */
function bothPaths(frame: Uint8Array): {
  oneShot: number | "decoded";
  stream: number | "decoded";
} {
  return {
    oneShot: code(() => void decompress(frame)),
    stream: code(() => void streamAll(frame)),
  };
}

const payload = new TextEncoder().encode("large window probe ".repeat(5000));

function streamAll(frame: Uint8Array): Uint8Array {
  const parts: Array<Uint8Array> = [];
  let n = 0;
  const d = new Decompress((c) => {
    parts.push(c);
    n += c.length;
  });
  // Small pushes so the window logic runs across chunk boundaries.
  for (let i = 0; i < frame.length; i += 997) {
    d.push(frame.subarray(i, Math.min(i + 997, frame.length)));
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

describe("large declared windows", { skip: !CLI }, () => {
  /**
   * Shared `-19 --long=27` frame. Most tests only need a real large-window
   * header to forge; re-running the CLI for each was ~8 identical compresses
   * and multiplied the surface for a wedged child.
   */
  let long27: Uint8Array = new Uint8Array(0);

  beforeAll(() => {
    // One shared compress for every test that only forges the header.
    long27 = cli(["-19", "--long=27"], payload);
  });

  const cases: Array<{ name: string; args: Array<string> }> = [
    { name: "-19 --long=26 (64 MiB)", args: ["-19", "--long=26"] },
    { name: "-19 --long=27 (128 MiB)", args: ["-19", "--long=27"] },
    { name: "--ultra -22", args: ["--ultra", "-22"] },
    { name: "--ultra -22 --long=27", args: ["--ultra", "-22", "--long=27"] },
  ];

  for (const { name, args } of cases) {
    test(`${name} decodes, one-shot and streaming`, () => {
      // Reuse the cached frame when the args match the shared compress.
      const frame =
        args.length === 2 && args[0] === "-19" && args[1] === "--long=27"
          ? long27
          : cli(args, payload);
      const ws = declaredWindow(frame);
      assert.ok(
        ws !== undefined && ws > 2 ** 25,
        `expected a window above 2^25, got ${String(ws)}`,
      );
      assert.deepEqual(decompress(frame), payload, "one-shot");
      assert.deepEqual(streamAll(frame), payload, "streaming");
    });
  }

  test("a tiny frame with a huge window does not allocate the window", () => {
    // Regression guard: this allocated ~129 MiB for a 27-byte frame.
    const frame = long27;
    assert.ok(frame.length < 5000, "expected a small frame");
    const before = process.memoryUsage().arrayBuffers;
    const out = streamAll(frame);
    const grew = process.memoryUsage().arrayBuffers - before;
    assert.deepEqual(out, payload);
    assert.ok(
      grew < 16 * 1024 * 1024,
      `streaming allocated ${Math.round(grew / 1048576)} MB for a ${frame.length}-byte frame`,
    );
  });

  // Every descriptor above 2^27 is past the 128 MiB limit — Window_Log 27
  // with any non-zero mantissa, and Window_Log 28 or above — so the largest
  // legal declaration is Window_Log 27, mantissa 0. Forge the descriptors.
  //
  // These asserted only "one-shot throws" once, and passed for the wrong
  // reason — `1 << (10 + exponent)` wrapped, so the limit check never ran and
  // the failure came from an undersized block buffer further in. Window_Log 31
  // wrapped *negative* and slipped past the check entirely: one-shot reported
  // InvalidData, streaming threw a raw `RangeError` from `new Uint8Array(-n)`,
  // and Window_Log 41 wrapped down to a 512-byte window and streamed 512 bytes
  // of an untruncated frame with no error at all. Assert the code, on both
  // paths, or this cannot fail.
  for (const [descriptor, name] of [
    [(17 << 3) | 1, "27 mantissa 1"],
    [18 << 3, "28"],
    [(20 << 3) | 7, "30 mantissa 7"],
    [21 << 3, "31"],
    [22 << 3, "32"],
    [31 << 3, "41"],
  ] as const) {
    test(`window above the decoder limit (Window_Log ${name}) is rejected`, () => {
      const frame = long27.slice();
      frame[5] = descriptor;
      assert.deepEqual(bothPaths(frame), {
        oneShot: ZstdErrorCode.WindowSizeTooLarge,
        stream: ZstdErrorCode.WindowSizeTooLarge,
      });
    });
  }

  test("the largest legal window (Window_Log 27, mantissa 0) still decodes", () => {
    // The other half of the same bug: over-rejecting is as wrong as
    // over-accepting, and a 128 MiB declared window must still cost only
    // what the payload does.
    const frame = long27.slice();
    frame[5] = 17 << 3;
    assert.equal(declaredWindow(frame), 2 ** 27);
    const before = process.memoryUsage().arrayBuffers;
    assert.deepEqual(decompress(frame), payload, "one-shot");
    assert.deepEqual(streamAll(frame), payload, "streaming");
    const grew = process.memoryUsage().arrayBuffers - before;
    assert.ok(grew < 16 * 1024 * 1024, `allocated ${grew} bytes`);
  });

  test("a block that regenerates past the declared window is rejected", () => {
    // Block_Maximum_Size is min(128 KiB, Window_Size). Shrinking the window
    // of a frame whose blocks are larger makes it malformed; `zstd -d` says
    // "Destination buffer is too small".
    //
    // Streaming used to size its block buffer at Block_Maximum_Size, let the
    // overflowing writes fall off the end of the Uint8Array — silently, as JS
    // does — and report success with the output truncated to the declared
    // window. A 95000-byte payload came back as 1024 bytes, no error.
    for (const exponent of [0, 1, 4]) {
      const frame = long27.slice();
      frame[5] = exponent << 3;
      assert.deepEqual(
        bothPaths(frame),
        {
          oneShot: ZstdErrorCode.InvalidData,
          stream: ZstdErrorCode.InvalidData,
        },
        `Window_Log ${10 + exponent}`,
      );
    }
  });
});
