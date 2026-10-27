/**
 * Perf and size regression checks — not correctness. `pnpm test` stays
 * deterministic and timing-free; anything here can flake on a loaded machine,
 * so thresholds are generous (several times the measured value) and the
 * script is run on purpose, not in CI.
 *
 *   pnpm bench:check
 *
 * Each check prints its measurement next to its limit and the script exits
 * non-zero if any fails.
 */
import { compressStrong } from "../dist/compressStrong.js";
import { compressUltra } from "../dist/compressUltra.js";
import { Decompress, decompress, ZstdError } from "../dist/decompress.js";
import { mixedCorpus, repFriendly } from "../tests/helpers/corpus.ts";

let failed = 0;
function check(name: string, value: number, limit: number, unit: string): void {
  const ok = value <= limit;
  if (!ok) failed++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}: ${value.toFixed(unit === "ms" ? 2 : 4)} ${unit} (limit ${limit})`,
  );
}

/** Best of three, in ms — the floor is the least noisy single number. */
function bestMs(run: () => void): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    run();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

const cat = (...parts: Array<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const blockHeader = (last: boolean, type: number, size: number): Uint8Array => {
  const h = (last ? 1 : 0) | (type << 1) | (size << 3);
  return new Uint8Array([h & 255, (h >> 8) & 255, (h >> 16) & 255]);
};
const WINDOWED = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 7 << 3]);

// ---- size baselines (moved from tests/compress_test.ts) --------------------
// Ultra is experimental; these record that it has not regressed below Strong,
// which is the condition under which it stays frozen (HANDOFF.md).
{
  const mixed = mixedCorpus(80_000);
  check(
    "Ultra / Strong size, mixed-80k",
    compressUltra(mixed).length / compressStrong(mixed).length,
    1,
    "x",
  );
  const rep = repFriendly(60_000);
  check(
    "Ultra / Strong size, rep-friendly-60k",
    compressUltra(rep).length / compressStrong(rep).length,
    1,
    "x",
  );
  check("Ultra ratio, rep-friendly-60k", compressUltra(rep).length / rep.length, 0.01, "");
}

// ---- hostile-input decode cost ---------------------------------------------
{
  // 400000 empty compressed blocks, 2 MB in, nothing out. The streaming path
  // used to allocate 128 KiB per block: ~800 ms. Now ~40 ms.
  const n = 400_000;
  const empty = cat(blockHeader(false, 2, 2), new Uint8Array([0, 0]));
  const frame = new Uint8Array(WINDOWED.length + n * empty.length + 3);
  frame.set(WINDOWED);
  for (let i = 0; i < n; i++) frame.set(empty, WINDOWED.length + i * empty.length);
  frame.set(blockHeader(true, 0, 0), frame.length - 3);
  check(
    "stream, 2 MB of empty compressed blocks",
    bestMs(() => new Decompress().push(frame, true)),
    250,
    "ms",
  );
  check(
    "one-shot, same",
    bestMs(() => void decompress(frame)),
    250,
    "ms",
  );
}
{
  // 20000 maximum-length matches in one 40 KB block: fails at the second
  // sequence now (~2 ms); ran 2.3 s of dead copies before the per-sequence
  // bound.
  const n = 20_000;
  const body = cat(
    new Uint8Array([0, (n >> 8) + 0x80, n & 255, 0x54, 0, 0, 52]),
    new Uint8Array(2 * n),
    new Uint8Array([1]),
  );
  const frame = cat(
    WINDOWED,
    blockHeader(false, 0, 8),
    new Uint8Array(8).fill(97),
    blockHeader(true, 2, body.length),
    body,
  );
  const run = () => {
    try {
      decompress(frame);
    } catch (e) {
      if (!(e instanceof ZstdError)) throw e;
    }
  };
  check("one-shot, 20000 max-length matches", bestMs(run), 50, "ms");
}

if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
