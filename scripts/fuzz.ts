/**
 * Seeded randomized differential fuzz for the codec, against `node:zlib`'s
 * libzstd. Complements `tests/unguarded_reads_test.ts` (exhaustive byte-flip /
 * truncation over fixed fixtures) with fresh inputs every run.
 *
 * ```
 *   pnpm fuzz                       # 300 iterations, random seed
 *   pnpm fuzz --iters 5000
 *   pnpm fuzz --seed 12345 --start 41   # replay a reported failure
 * ```
 *
 * Every iteration checks three things:
 *   1. Our Fast / Strong / Ultra frames decode to the input in `node:zlib` and
 *      in our own one-shot + streaming decoders.
 *   2. A `node:zlib` frame at a random level (−8…19, checksum on or off)
 *      decodes to the input in our decoder.
 *   3. A randomly mutated frame (byte flips, truncation, insertions) either
 *      throws `ZstdError` or returns the original bytes — never any other
 *      exception, never wrong bytes — and the streaming decoder gives the same
 *      verdict as one-shot.
 *
 * Failures print the `--seed` / `--start` pair that replays them and write the
 * offending input under `.tmp/fuzz/`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { compressFast } from "../dist/compressFast.js";
import { compressStrong } from "../dist/compressStrong.js";
import { compressUltra } from "../dist/compressUltra.js";
import { Decompress, decompress, ZstdError } from "../dist/decompress.js";
import { hasNodeZstd, nodeZstdCompress, nodeZstdDecompress } from "../tests/helpers/node_zstd.ts";

// ---- args ------------------------------------------------------------------

const argv = process.argv.slice(2);
function flag(name: string, dflt: number): number {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = Number(argv[i + 1]);
  if (!Number.isFinite(v)) throw new Error(`--${name} needs a number`);
  return v;
}
const ITERS = flag("iters", 300);
const SEED = flag("seed", (Date.now() ^ (process.pid << 8)) >>> 0);
const START = flag("start", 0);

if (!hasNodeZstd()) {
  throw new Error("node:zlib zstd is unavailable on this Node; fuzz needs it as the oracle");
}

// ---- PRNG (mulberry32, seeded per iteration so --start replays exactly) -----

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r: () => number, lo: number, hi: number): number =>
  lo + Math.floor(r() * (hi - lo + 1));

// ---- input generators -------------------------------------------------------

type Gen = (r: () => number, n: number) => Uint8Array;

const gens: Array<[string, Gen]> = [
  [
    "random",
    (r, n) => {
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) b[i] = int(r, 0, 255);
      return b;
    },
  ],
  [
    "low-entropy",
    (r, n) => {
      const alphabet = int(r, 2, 8);
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) b[i] = int(r, 0, alphabet - 1);
      return b;
    },
  ],
  [
    "repeats",
    (r, n) => {
      const unit = new Uint8Array(int(r, 1, 300));
      for (let i = 0; i < unit.length; i++) unit[i] = int(r, 0, 255);
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        b[i] = r() < 0.02 ? int(r, 0, 255) : (unit[i % unit.length] ?? 0);
      }
      return b;
    },
  ],
  [
    "text",
    (r, n) => {
      const words = ["alpha", "beta", "gamma", "delta", "zstd", "{", "}", ":", ",", "\n", " "];
      let s = "";
      while (s.length < n) {
        s += words[int(r, 0, words.length - 1)] ?? "";
        if (r() < 0.1) s += String(int(r, 0, 99999));
      }
      return new TextEncoder().encode(s.slice(0, n));
    },
  ],
  [
    "ramp",
    (r, n) => {
      const step = int(r, 1, 7);
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) b[i] = (i * step) & 0xff;
      return b;
    },
  ],
  [
    "long-range",
    (r, n) => {
      const b = new Uint8Array(n);
      const seg = int(r, 4096, 65536);
      for (let i = 0; i < n; i++) b[i] = i < seg ? int(r, 0, 255) : (b[i - seg] ?? 0);
      return b;
    },
  ],
];

// ---- decode harness ---------------------------------------------------------

type Verdict = { kind: "ok"; bytes: Uint8Array } | { kind: "zstd-error" };

function oneShot(frame: Uint8Array): Verdict {
  try {
    return { kind: "ok", bytes: decompress(frame) };
  } catch (e) {
    if (e instanceof ZstdError) return { kind: "zstd-error" };
    throw e;
  }
}

function streamed(frame: Uint8Array, r: () => number): Verdict {
  const parts: Array<Uint8Array> = [];
  try {
    const dec = new Decompress((chunk) => {
      parts.push(chunk);
    });
    let off = 0;
    while (off < frame.length) {
      const len = Math.min(int(r, 1, 4096), frame.length - off);
      dec.push(frame.subarray(off, off + len));
      off += len;
    }
    dec.push(new Uint8Array(0), true);
  } catch (e) {
    if (e instanceof ZstdError) return { kind: "zstd-error" };
    throw e;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return { kind: "ok", bytes: out };
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function mutate(frame: Uint8Array, r: () => number): [string, Uint8Array] {
  const mode = int(r, 0, 3);
  if (mode === 0 || frame.length === 0) {
    const out = frame.slice();
    const flips = int(r, 1, 4);
    for (let i = 0; i < flips && out.length > 0; i++) {
      const at = int(r, 0, out.length - 1);
      out[at] = (out[at] ?? 0) ^ (1 << int(r, 0, 7));
    }
    return [`flip×${flips}`, out];
  }
  if (mode === 1) {
    // Never to 0: an empty input is zero frames, which decodes to nothing by design.
    const at = int(r, 1, frame.length - 1);
    return [`truncate@${at}`, frame.slice(0, at)];
  }
  if (mode === 2) {
    const at = int(r, 0, frame.length);
    const n = int(r, 1, 16);
    const out = new Uint8Array(frame.length + n);
    out.set(frame.subarray(0, at), 0);
    for (let i = 0; i < n; i++) out[at + i] = int(r, 0, 255);
    out.set(frame.subarray(at), at + n);
    return [`insert${n}@${at}`, out];
  }
  const at = int(r, 0, frame.length - 1);
  const out = frame.slice();
  out[at] = int(r, 0, 255);
  return [`overwrite@${at}`, out];
}

// ---- main loop --------------------------------------------------------------

class FuzzFailure extends Error {
  readonly input: Uint8Array;
  readonly frame: Uint8Array;
  constructor(message: string, input: Uint8Array, frame: Uint8Array) {
    super(message);
    this.input = input;
    this.frame = frame;
  }
}

function check(cond: boolean, msg: string, input: Uint8Array, frame: Uint8Array): void {
  if (!cond) throw new FuzzFailure(msg, input, frame);
}

/** A random element of a non-empty array. */
function pick<T>(xs: readonly T[], r: () => number): T {
  const x = xs[int(r, 0, xs.length - 1)];
  if (x === undefined) throw new Error("pick from empty array");
  return x;
}

function iteration(i: number): string {
  const r = rng((SEED + i * 0x9e3779b9) >>> 0);
  const [genName, gen] = pick(gens, r);
  const size = r() < 0.15 ? int(r, 0, 64) : int(r, 0, 1 << int(r, 8, 19));
  const data = gen(r, size);

  // 1. our encoders → libzstd and ourselves
  const encoders: Array<[string, (d: Uint8Array) => Uint8Array]> = [
    ["fast", compressFast],
    ["strong", compressStrong],
  ];
  if (size <= 1 << 17) encoders.push(["ultra", compressUltra]);
  const frames: Array<[string, Uint8Array]> = [];
  for (const [name, enc] of encoders) {
    const frame = enc(data);
    frames.push([name, frame]);
    check(same(nodeZstdDecompress(frame), data), `${name}: libzstd disagrees`, data, frame);
    const v1 = oneShot(frame);
    check(v1.kind === "ok" && same(v1.bytes, data), `${name}: own one-shot decode`, data, frame);
    const v2 = streamed(frame, r);
    check(v2.kind === "ok" && same(v2.bytes, data), `${name}: own streaming decode`, data, frame);
  }

  // 2. libzstd → us. Only the checksummed frame joins the mutation pool: a
  //    frame without a digest can legitimately decode a flipped literal byte
  //    to wrong output, and that is the format, not a bug.
  const level = int(r, -8, 19);
  const ref = nodeZstdCompress(data, level, true);
  frames.push([`zlib${level}`, ref]);
  for (const f of [ref, nodeZstdCompress(data, level, false)]) {
    const v = oneShot(f);
    check(v.kind === "ok" && same(v.bytes, data), `libzstd level ${level}: own decode`, data, f);
  }

  // 3. mutations of a checksummed frame never escape
  const [fname, base] = pick(frames, r);
  const [how, bad] = mutate(base, r);
  const a = oneShot(bad);
  const b = streamed(bad, r);
  check(
    a.kind === "zstd-error" || same(a.bytes, data),
    `${fname} ${how}: one-shot returned wrong bytes without throwing`,
    data,
    bad,
  );
  check(
    a.kind === b.kind && (a.kind === "zstd-error" || b.kind !== "ok" || same(a.bytes, b.bytes)),
    `${fname} ${how}: one-shot and streaming disagree`,
    data,
    bad,
  );
  return `${genName}/${size}B ${fname} ${how}`;
}

const t0 = performance.now();
let last = "";
for (let i = START; i < START + ITERS; i++) {
  try {
    last = iteration(i);
  } catch (e) {
    const dir = ".tmp/fuzz";
    mkdirSync(dir, { recursive: true });
    if (e instanceof FuzzFailure) {
      writeFileSync(`${dir}/${SEED}-${i}.input`, e.input);
      writeFileSync(`${dir}/${SEED}-${i}.frame`, e.frame);
    }
    console.error(`FAIL at iteration ${i}: ${e instanceof Error ? e.message : String(e)}`);
    console.error(`replay: pnpm fuzz --seed ${SEED} --start ${i} --iters 1`);
    console.error(`inputs: ${dir}/${SEED}-${i}.{input,frame}`);
    process.exitCode = 1;
    throw e;
  }
}
const secs = ((performance.now() - t0) / 1000).toFixed(1);
console.log(
  `fuzz ok: ${ITERS} iterations from --seed ${SEED} --start ${START} in ${secs}s (last: ${last})`,
);
