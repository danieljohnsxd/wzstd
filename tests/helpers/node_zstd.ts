/**
 * zstd via `node:zlib` (Node 22.15+ / 24+).
 *
 * This is the same C libzstd the host CLI uses, but reached through a different
 * path, and that changes the frames: the one-shot buffer API knows the input
 * size up front, so it emits single-segment frames *with* Frame_Content_Size,
 * where `zstd` reading a pipe emits neither. Same encoder, different framing —
 * which is exactly the axis that hid a decoder bug before.
 *
 * It is also in-process, so it is far cheaper than spawning the CLI per case.
 *
 * Node-only by construction. Never import this from `src/`.
 */
import zlib from "node:zlib";

/**
 * The runtime check stays even though `@types/node` now types the zstd surface
 * (it is on the 24 line, matching the Node this repo runs). `engines.node` is
 * `>=22`, and zstd landed in 22.15 — so on an older 22 these are genuinely
 * absent at runtime while present in the types, and every consumer treats that
 * as skip rather than failure.
 */
export function hasNodeZstd(): boolean {
  return (
    typeof zlib.zstdCompressSync === "function" &&
    typeof zlib.zstdDecompressSync === "function" &&
    typeof zlib.constants.ZSTD_c_compressionLevel === "number"
  );
}

/**
 * Compress with node:zlib's zstd at `level` (negative levels allowed).
 *
 * `checksum` defaults to **false**, matching the API's own default — the
 * one-shot buffer API writes no content checksum, where the `zstd` CLI writes
 * one. That is a real difference and it is easy to miss: a decode benchmark
 * built on these frames measures nothing at all in its "verifies" column,
 * because there is nothing in the frame to verify. Pass `true` when the frames
 * are meant to exercise checksum verification.
 */
export function nodeZstdCompress(data: Uint8Array, level = 3, checksum = false): Uint8Array {
  if (!hasNodeZstd()) throw new Error("node:zlib zstd is unavailable");
  return new Uint8Array(
    zlib.zstdCompressSync(data, {
      params: {
        [zlib.constants.ZSTD_c_compressionLevel]: level,
        [zlib.constants.ZSTD_c_checksumFlag]: checksum ? 1 : 0,
      },
    }),
  );
}

export function nodeZstdDecompress(data: Uint8Array): Uint8Array {
  if (!hasNodeZstd()) throw new Error("node:zlib zstd is unavailable");
  return new Uint8Array(zlib.zstdDecompressSync(data));
}
