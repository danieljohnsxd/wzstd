/**
 * The encoder roster, shared by `bench_encode` and `bench_summary`.
 *
 * Both benches time the same implementations and only disagree about which ones
 * belong in the default set, so the list lives here rather than being written
 * twice and drifting. Each entry pairs the label and the `SubjectId` the child
 * process runs with the function this process calls for **sizes**, which are
 * deterministic and are never timed here.
 *
 * Opt-in dimensions, real flags rather than environment variables, so they
 * compose with the corpus flags and with each other:
 *
 * - **`--peers`** adds zrip and `node:zlib`. `bench_summary` always includes
 *   them (a summary without peers is not a summary); `bench_encode` does not,
 *   because their numbers do not move while you iterate on our matcher and
 *   timing them is most of the wall clock.
 * - **`--lvl19`** adds `node:zlib -19`. The ultra-band ratio ceiling for
 *   `compressUltra`; also useful for "how much ratio is left on the table"
 *   against Strong. It is the single most expensive peer row.
 * - **`--no-ultra`** drops `wzstd Ultra` (slow to time; fine when iterating on
 *   Fast/Strong only).
 *
 * **Always-on cross-format / host baselines** (Ultra can be dropped; these stay):
 *
 * - **fflate gzip** — pure-JS, default level 6. Peer of a different format.
 * - **node:zlib gzip** — host C zlib, level 6. Ceiling for fflate / gzip ratio.
 * - **node:zlib -3** — host C libzstd (when present). Ceiling for *our* format;
 *   how much of the Silesia gap is “zstd” vs “wzstd Strong.”
 *
 * Report pure-JS gzip, host gzip, and zstd ceilings in separate groups so a
 * native gzip win is not read as a zstd-format win.
 *
 * **`--peers`** still adds zrip (WASM) and the extra node:zlib zstd tiers
 * (fast8). **`--lvl19`** adds node:zlib -19. **No top-level zrip import.**
 */
import { gzipSync } from "fflate";
import { compressFast } from "../../dist/compressFast.js";
import { compressStrong } from "../../dist/compressStrong.js";
import { compressUltra } from "../../dist/compressUltra.js";
import { nodeGzipCompress } from "../../tests/helpers/node_gzip.ts";
import { hasNodeZstd, nodeZstdCompress } from "../../tests/helpers/node_zstd.ts";
import type { SubjectId } from "./isolate.ts";

export type Encoder = [label: string, subject: SubjectId, size: (d: Uint8Array) => Uint8Array];

/** Option fragment to merge into `selectCorpora`'s parser. */
export const ENCODER_OPTIONS = {
  peers: { type: "boolean", default: false },
  lvl19: { type: "boolean", default: false },
  "no-ultra": { type: "boolean", default: false },
} as const;

export type EncoderListOpts = {
  peers: boolean;
  lvl19: boolean;
  /** Drop `wzstd Ultra` from the roster. */
  noUltra?: boolean;
  /**
   * Required when `peers` is true. The caller lazy-imports `@paddor/zrip` so
   * this module never pulls WASM for a wzstd-only run.
   */
  zripCompress?: (d: Uint8Array, level: number) => Uint8Array;
};

/**
 * Table section for an encoder label. Keep pure-JS gzip, host gzip, and zstd
 * ceilings apart — conflating them invents the wrong product story.
 */
export function encoderGroup(label: string): string {
  if (label.startsWith("wzstd")) return "our levels";
  if (label.startsWith("fflate")) return "pure-js gzip";
  if (label.startsWith("node:zlib gzip")) return "host gzip";
  return "zstd ceilings";
}

/**
 * Always: Fast/Strong/(Ultra)/fflate/node-gzip/(node zstd -3).
 * `peers` adds zrip + node zstd fast8; `lvl19` adds node zstd -19.
 *
 * A missing `node:zlib` zstd is a skip, not a failure — it landed in Node 22.15
 * and `engines.node` is `>=22`. Host gzip is always available on Node.
 */
export function encoderList(opts: EncoderListOpts): Array<Encoder> {
  const list: Array<Encoder> = [
    ["wzstd Fast", "wzstd-fast", compressFast],
    ["wzstd Strong", "wzstd-strong", compressStrong],
  ];
  if (opts.noUltra !== true) {
    list.push(["wzstd Ultra", "wzstd-ultra", compressUltra]);
  }
  // Default level 6 on both pure-JS and host gzip — like-for-like gzip.
  list.push(["fflate gzip", "fflate-gzip", (d) => gzipSync(d)]);
  list.push(["node:zlib gzip", "node-gzip", (d) => nodeGzipCompress(d, 6)]);

  const nodeZstd = hasNodeZstd();
  // C zstd at level 3 is the always-on format ceiling for Strong.
  if (nodeZstd) {
    list.push(["node:zlib -3", "node-zlib-3", (d) => nodeZstdCompress(d, 3)]);
  }

  if (opts.peers) {
    const zrip = opts.zripCompress;
    if (zrip === undefined) {
      throw new Error(
        "encoderList({ peers: true }) needs zripCompress — lazy-import @paddor/zrip first",
      );
    }
    list.push(["zrip -1", "zrip-1", (d) => zrip(d, 1)]);
    list.push(["zrip -3", "zrip-3", (d) => zrip(d, 3)]);
    if (nodeZstd) {
      list.push(["node:zlib fast8", "node-zlib-fast8", (d) => nodeZstdCompress(d, -8)]);
    }
  }

  // Level 19 is the ultra-band ratio reference (and "how close is Strong?").
  if (opts.lvl19 && nodeZstd) {
    list.push(["node:zlib -19", "node-zlib-19", (d) => nodeZstdCompress(d, 19)]);
  }

  return list;
}

/** True when any entry needs the zrip WASM module initialised in this process. */
export const needsZrip = (list: Array<Encoder>): boolean =>
  list.some(([, subject]) => subject.startsWith("zrip"));
