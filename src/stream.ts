/**
 * Web Streams adapter for the decoder.
 *
 * `TransformStream` is a host API, not part of ES2022 — the language target
 * says nothing about whether it exists. It is present on every runtime this
 * package targets (Node 18+, Deno, Bun, Workers, browsers), but it is
 * referenced *lazily* here, inside the factory, so importing the barrel on a
 * runtime without it still works. Never turn this into
 * `class X extends TransformStream`: that evaluates the global at module load
 * and would break the import for everyone else.
 *
 * Worth knowing: `DecompressionStream` does not support zstd on any current
 * runtime (gzip/deflate/deflate-raw only), and Node's own zstd lives in
 * `node:zlib`, which does not exist off Node. This adapter is the portable way
 * to put zstd in a stream pipeline.
 */
import { Decompress, type ZstdDecodeOptions } from "./decompress.js";

export {
  type ZstdDecodeOptions,
  ZstdError,
  ZstdErrorCode,
  type ZstdErrorCodeValue,
} from "./decompress.js";

/**
 * A `TransformStream` that decompresses a zstd byte stream.
 *
 * Each decoded block is enqueued as it is produced, so neither the compressed
 * input nor the decompressed output is ever fully resident — this is the way
 * past the ~4 GiB single-`Uint8Array` ceiling that one-shot `decompress` has.
 *
 * Truncated input rejects the stream with a {@link ZstdError} at flush, since
 * a stream that ends mid-frame cannot be distinguished from one that is merely
 * incomplete until it closes.
 *
 * ```ts
 * import { decompressStream } from "wzstd";
 *
 * const res = await fetch(url);
 * const plain = res.body.pipeThrough(decompressStream());
 * ```
 *
 * Fast and Strong have compress counterparts (`compressFastStream`,
 * `compressStrongStream`) on their own modules. Ultra stays one-shot. Those
 * factories emit real blocks as input arrives — they are not buffer-until-flush
 * wrappers around the one-shot encoders.
 *
 * @param opts Decode options; see {@link ZstdDecodeOptions}. Content checksums
 *             are verified unless an explicit `{ checksum: false }` says
 *             otherwise, and output is capped at 64 MiB unless `maxSize`
 *             says otherwise.
 */
export function decompressStream(
  opts?: Omit<ZstdDecodeOptions, "out">,
): TransformStream<Uint8Array, Uint8Array> {
  // Constructed here, not in `start`, so invalid options (`maxSize: -1`)
  // throw at the call like the other entry points.
  const dec = new Decompress(undefined, opts);
  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      // Blocks handed to `ondata` are freshly allocated by the decoder, never
      // views into its window, so enqueuing them transfers ownership safely.
      dec.ondata = (chunk) => {
        if (chunk.length > 0) controller.enqueue(chunk);
      };
    },
    transform(chunk) {
      dec.push(chunk);
    },
    flush() {
      // Empty final push: closes the last frame and raises UnexpectedEOF if
      // the stream ended mid-frame.
      dec.push(new Uint8Array(0), true);
    },
  });
}
