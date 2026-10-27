/**
 * gzip via `node:zlib` (always present on Node).
 *
 * Host C zlib — a ceiling for pure-JS gzip (fflate), not a peer of wzstd.
 * Default level 6 matches fflate's default so ratio/speed are like-for-like on
 * the gzip side.
 *
 * Node-only by construction. Never import this from `src/`.
 */
import zlib from "node:zlib";

/**
 * Compress with node:zlib gzip. `level` is zlib's 0–9 (default 6).
 */
export function nodeGzipCompress(data: Uint8Array, level = 6): Uint8Array {
  return new Uint8Array(zlib.gzipSync(data, { level }));
}
