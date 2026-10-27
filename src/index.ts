/**
 * wzstd — pure TypeScript Zstandard codec (ES2022 ESM).
 *
 * The root export is **decode-only**. Encoders live on their own subpaths so
 * an unbundled `import { decompress } from "wzstd"` never evaluates a matcher:
 * - `wzstd/compressFast`   — {@link compressFast} / `CompressFast` / `compressFastStream`
 * - `wzstd/compressStrong` — `compressStrong` / `CompressStrong` / `compressStrongStream`
 * - `wzstd/compressUltra`  — `compressUltra` (one-shot only)
 *
 * Decode, here and on `wzstd/decompress`:
 * - {@link decompress} — one-shot (−8…19 frames; ultra 20–22 decodes too)
 * - {@link Decompress} — streaming decode (push-based)
 * - {@link decompressStream} — streaming decode as a `TransformStream` (root only)
 */

export {
  Decompress,
  decompress,
  type ZstdDecodeOptions,
  ZstdError,
  ZstdErrorCode,
  type ZstdErrorCodeValue,
  type ZstdStreamHandler,
} from "./decompress.js";

export { decompressStream } from "./stream.js";
