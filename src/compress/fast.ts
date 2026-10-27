/**
 * Fast encoder: shallow chain + greedy match finder.
 * Explicit rep probes and incompressible skip. No Huffman, no long-hash.
 */

import type { ZstdStreamHandler } from "../decompress.js";
import { encodeLiteralsRaw } from "./literals.js";
import { EncodeStream, encodeFrame, WINDOW_SIZE, type MatcherConfig } from "./shared.js";

/**
 * Shallow chain depth for Fast.
 *
 * The patience cutoffs below are derived from this rather than written as
 * literal `1`s, and that is load-bearing. A cutoff equal to the walk length can
 * never fire: the walk runs at most `chainLimit` times, and `sinceImprove`
 * reaches `chainLimit` exactly when the loop bound does. Spelling them `1`
 * would leave Fast holding the most aggressive cutoff the matcher accepts,
 * inert only by coincidence, and collapse output back to single-slot sizes.
 * Widening the chain here stays a pure search-depth change. Long-hash stays
 * Ultra-only.
 */
const FAST_CHAIN_LIMIT = 4;
/** Wider buckets reduce collision work; four slots exactly cover the walk. */
const FAST_HASH_BITS = 17;
const FAST_ROW_BITS = 2;

/** Shipped Fast matcher policy. */
export const FAST_CONFIG: MatcherConfig = {
  chainLimit: FAST_CHAIN_LIMIT,
  // Derived from chain depth — not Strong's patience curve. See block above.
  patience: FAST_CHAIN_LIMIT,
  nullPatience: FAST_CHAIN_LIMIT,
  lazyDepth: 0,
  preferRepOffsets: true,
  huffmanLiterals: false,
  offsetSurcharge16: 0,
  // Irrelevant at surcharge 0 — Fast charges distance nothing, because with raw
  // 8-bit literals a rejected match is pure loss. Kept explicit so Fast vs
  // Strong cost models stay side by side and neither is tuned globally.
  offsetSurchargeFrom: 0,
  windowSize: WINDOW_SIZE,
  // Four-slot row covers chainLimit 4 and keeps the contiguous layout compact.
  // 18/19 grow the head table and regress small synthetic payloads.
  hashBits: FAST_HASH_BITS,
  rowBits: FAST_ROW_BITS,
  // The 4-byte chain only surfaces a rep when the hash collides with it.
  probeReps: true,
  longHashBits: 0,
  longChainLimit: 0,
  primaryHashBytes: 4,
  longHashOnlyIfShort: false,
  optimalParse: false,
  binaryTree: false,
  // After a miss, step `((pos-anchor)>>8)+1`. Matches keep the step at 1.
  searchSkipShift: 8,
};

/**
 * Compress with the Fast strategy.
 *
 * Shallow hash chain (depth 4), greedy multi-sequence parse, explicit rep
 * probes, raw/RLE literals only. Prefer {@link compressStrong} when ratio
 * matters more than encode speed.
 *
 * One-shot: writes Frame_Content_Size and a content checksum. For a push or
 * `pipeThrough` stream, use {@link CompressFast} / {@link compressFastStream}.
 */
export function compressFast(data: Uint8Array): Uint8Array {
  return encodeFrame(data, FAST_CONFIG, encodeLiteralsRaw);
}

/**
 * Fast encode under an explicit matcher config. Config-sweep entry — not a
 * public product surface; shape may change with the matcher.
 */
export function compressFastWithConfig(data: Uint8Array, config: MatcherConfig): Uint8Array {
  return encodeFrame(data, config, encodeLiteralsRaw);
}

/**
 * Push-based Fast encoder. One instance is one frame.
 *
 * Emits a no-FCS, 1 MiB window, checksummed frame. Blocks leave as soon as
 * 128 KiB of input has arrived — this is not a buffer-until-flush wrapper
 * around {@link compressFast}.
 *
 * ```ts
 * const enc = new CompressFast((chunk) => sink(chunk));
 * enc.push(part);
 * enc.push(new Uint8Array(0), true);
 * ```
 *
 * Prefer {@link compressFastStream} when composing with `pipeThrough`.
 */
export class CompressFast {
  private readonly inner: EncodeStream;

  constructor(ondata?: ZstdStreamHandler) {
    this.inner = new EncodeStream(FAST_CONFIG, encodeLiteralsRaw, ondata);
  }

  get ondata(): ZstdStreamHandler {
    return this.inner.ondata;
  }

  set ondata(handler: ZstdStreamHandler) {
    this.inner.ondata = handler;
  }

  push(chunk: Uint8Array, final?: boolean): void {
    this.inner.push(chunk, final);
  }
}

/**
 * A `TransformStream` that compresses with {@link CompressFast}.
 *
 * ```ts
 * readable.pipeThrough(compressFastStream());
 * ```
 *
 * `TransformStream` is referenced lazily inside the factory so importing this
 * module still works where the host API is absent. Never `extends` it.
 */
export function compressFastStream(): TransformStream<Uint8Array, Uint8Array> {
  let enc: CompressFast | undefined;
  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      enc = new CompressFast((chunk) => {
        if (chunk.length > 0) controller.enqueue(chunk);
      });
    },
    transform(chunk) {
      enc?.push(chunk);
    },
    flush() {
      enc?.push(new Uint8Array(0), true);
    },
  });
}
