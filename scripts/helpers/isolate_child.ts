/**
 * The other half of `isolate.ts`: one process, one implementation.
 *
 * Invoked as `node isolate_child.ts <job.json> <out.json>`. It reads the staged
 * blob, times its one subject over the picked items, and writes the rates back
 * as JSON. It prints nothing on stdout — the parent gives it none.
 *
 * The timing loop lives here rather than in the harnesses so every isolated
 * measurement is the same loop: two warmup calls, then `trials` batches sized up
 * until each runs at least `targetMs`, reported as the median.
 *
 * Modules are loaded lazily, per subject. Importing zrip pulls a WASM instance
 * into the heap and `node:zlib` pulls libzstd; neither belongs in the process
 * that is meant to be measuring pure JS alone.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { type IsolateItem, type IsolateJob, STREAM_CHUNK, type SubjectId } from "./isolate.ts";

const [jobPath, outPath] = process.argv.slice(2);
if (jobPath === undefined || outPath === undefined) {
  throw new Error("usage: isolate_child.ts <job.json> <out.json>");
}

function readJob(path: string): IsolateJob {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("job is not an object");
  }
  // The job is written by `isolate.ts` one process ago, not by a user, so this
  // is a shape assertion rather than validation of untrusted input.
  const job = parsed as Partial<IsolateJob>;
  if (
    job.subject === undefined ||
    job.blobPath === undefined ||
    job.items === undefined ||
    job.pick === undefined ||
    job.targetMs === undefined ||
    job.trials === undefined
  ) {
    throw new Error("job is missing fields");
  }
  return {
    subject: job.subject,
    blobPath: job.blobPath,
    items: job.items,
    pick: job.pick,
    targetMs: job.targetMs,
    trials: job.trials,
  };
}

/** Resolve one subject to a callable, importing only what that subject needs. */
async function subjectFn(id: SubjectId): Promise<(d: Uint8Array) => void> {
  switch (id) {
    case "wzstd": {
      const { decompress } = await import("../../dist/decompress.js");
      // Bench payloads are our own and `--extra` files can exceed the 64 MiB
      // default cap; the cap costs nothing to check, so lifting it changes no
      // timing.
      return (f) => void decompress(f, { maxSize: Infinity });
    }
    case "wzstd-noverify": {
      // The opt-out path. Measured as its own subject rather than a flag on
      // `wzstd`, so the verifying column can never accidentally be this one.
      const { decompress } = await import("../../dist/decompress.js");
      return (f) => void decompress(f, { checksum: false, maxSize: Infinity });
    }
    case "wzstd-stream": {
      const { Decompress } = await import("../../dist/decompress.js");
      return (f) => {
        const d = new Decompress(() => {}, { maxSize: Infinity });
        for (let i = 0; i < f.length; i += STREAM_CHUNK) {
          const end = Math.min(i + STREAM_CHUNK, f.length);
          d.push(f.subarray(i, end), end >= f.length);
        }
      };
    }
    case "fzstd": {
      const { decompress } = await import("fzstd");
      return (f) => void decompress(f);
    }
    case "zrip": {
      const { ensureZrip } = await import("../../tests/helpers/zrip_init.ts");
      await ensureZrip();
      const { decompress } = await import("@paddor/zrip");
      return (f) => void decompress(f);
    }
    case "node-zlib": {
      const { nodeZstdDecompress } = await import("../../tests/helpers/node_zstd.ts");
      return (f) => void nodeZstdDecompress(f);
    }
    case "wzstd-fast": {
      const { compressFast } = await import("../../dist/compressFast.js");
      return (d) => void compressFast(d);
    }
    case "wzstd-strong": {
      const { compressStrong } = await import("../../dist/compressStrong.js");
      return (d) => void compressStrong(d);
    }
    case "wzstd-ultra": {
      const { compressUltra } = await import("../../dist/compressUltra.js");
      return (d) => void compressUltra(d);
    }
    case "fflate-gzip": {
      // Pure-JS GZIP peer. Default level (6); cross-format ratio/speed context
      // only — not a zstd ceiling and not imported into wzstd-only child runs.
      const { gzipSync } = await import("fflate");
      return (d) => void gzipSync(d);
    }
    case "node-gzip": {
      // Host C zlib gzip, level 6 — ceiling for fflate, not a wzstd peer.
      const { nodeGzipCompress } = await import("../../tests/helpers/node_gzip.ts");
      return (d) => void nodeGzipCompress(d, 6);
    }
    case "zrip-1":
    case "zrip-3": {
      const { ensureZrip } = await import("../../tests/helpers/zrip_init.ts");
      await ensureZrip();
      const { compress } = await import("@paddor/zrip");
      const level = id === "zrip-1" ? 1 : 3;
      return (d) => void compress(d, level);
    }
    case "node-zlib-fast8":
    case "node-zlib-3":
    case "node-zlib-19": {
      const { nodeZstdCompress } = await import("../../tests/helpers/node_zstd.ts");
      // Checksum stays at the API default (off) for the encode subjects, as
      // it was when these ran in-process — turning it on here would move the
      // encode numbers for a reason unrelated to the change under test.
      const level = id === "node-zlib-fast8" ? -8 : id === "node-zlib-3" ? 3 : 19;
      return (d) => void nodeZstdCompress(d, level);
    }
  }
}

/**
 * Median MB/s of `bytes` over repeated timed runs, after a warmup.
 *
 * **Calibrate once, then measure.** The batch size is ramped until one batch
 * runs for `targetMs` — long enough that `performance.now()` granularity and
 * scheduler noise are rounding errors rather than the signal. That ramp used to
 * sit *inside* the trials loop, so every one of the `trials` samples rediscovered
 * the same iteration count from scratch and threw the search away. The waste is
 * worst exactly where the batch is largest: a payload whose decode is
 * sub-microsecond needs ~500k iterations to fill 150ms, and paid the ~300k-call
 * ramp to find that out five times over.
 *
 * The calibration batch is deliberately discarded rather than kept as a sample.
 * It is the first run at that size, so it carries the warmup cost that the real
 * samples should not.
 */
function rate(
  fn: (d: Uint8Array) => void,
  buf: Uint8Array,
  bytes: number,
  targetMs: number,
  trials: number,
): number {
  fn(buf);
  fn(buf);

  let iters = 1;
  for (;;) {
    const start = performance.now();
    for (let i = 0; i < iters; i++) fn(buf);
    const ms = performance.now() - start;
    if (ms >= targetMs || iters >= 1 << 20) break;
    iters *= ms < targetMs / 8 ? 8 : 2;
  }

  const rates: Array<number> = [];
  for (let t = 0; t < trials; t++) {
    const start = performance.now();
    for (let i = 0; i < iters; i++) fn(buf);
    const ms = performance.now() - start;
    rates.push((bytes * iters) / 1e6 / (ms / 1000));
  }
  rates.sort((a, b) => a - b);
  return rates[rates.length >> 1] ?? Number.NaN;
}

const job = readJob(jobPath);
const fn = await subjectFn(job.subject);
const blob = new Uint8Array(readFileSync(job.blobPath));

const rates: Array<number> = [];
for (const i of job.pick) {
  const item: IsolateItem | undefined = job.items[i];
  if (item === undefined) {
    rates.push(Number.NaN);
    continue;
  }
  // Copy rather than view the blob: a subarray of one big buffer keeps the
  // whole thing alive and shares a page with its neighbours, which is not the
  // memory shape any of these implementations sees in real use.
  const buf = blob.slice(item.off, item.off + item.len);
  rates.push(rate(fn, buf, item.bytes, job.targetMs, job.trials));
}

writeFileSync(outPath, JSON.stringify({ rates }));
