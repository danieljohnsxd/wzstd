/**
 * Strong encoder: hash chain + Huffman + prefer-rep scoring + explicit rep probes.
 * Imports Huffman (keep out of the Fast module graph).
 */

import type { ZstdStreamHandler } from "../decompress.js";
import { selectSequenceTable } from "./fse-tables.js";
import { encodeLiteralsWithHuffman } from "./literals-huffman.js";
import {
  DEFAULT_ROW_BITS,
  EncodeStream,
  encodeFrame,
  WINDOW_SIZE,
  type MatcherConfig,
  type MatchStats,
  withMatchStats,
} from "./shared.js";

/** Shipped Strong matcher policy. */
export const STRONG_CONFIG: MatcherConfig = {
  // Depth 20 + patience 4: enough post-hit walk that first-hit-final does not
  // fire, shallow enough that the tail is not fruitless. Orthogonal to
  // nullPatience 24 / lazyDepth 0.
  chainLimit: 20,
  // Post-hit budget. `sinceImprove` also ticks on the improving iteration, so
  // patience 1 = first positive chain hit wins. Four is the budget at this depth.
  patience: 4,
  // Pre-hit budget. 48 saturates at the same size; 12 gives the ratio back.
  nullPatience: 24,
  // Pure greedy. Orthogonal to the patience pair.
  lazyDepth: 0,
  preferRepOffsets: true,
  huffmanLiterals: true,
  offsetSurcharge16: 72,
  offsetSurchargeFrom: 3,
  windowSize: WINDOW_SIZE,
  // 17-bit table. rowBits stays 5 so chainLimit 20 is not capped; the
  // contiguous ring does not activate (`slots < hashSize × row`). Shrinking
  // chain or row to force the ring blows up mixed-*.
  hashBits: 17,
  rowBits: DEFAULT_ROW_BITS,
  // The 4-byte chain only surfaces a rep when the hash collides with it.
  probeReps: true,
  // Long-hash stays Ultra-only. Not a substitute for post-hit patience.
  longHashBits: 0,
  longChainLimit: 0,
  primaryHashBytes: 4,
  longHashOnlyIfShort: false,
  optimalParse: false,
  binaryTree: false,
  searchSkipShift: 0,
};

/**
 * Compress with the Strong strategy (default quality path).
 *
 * Hash chain (17-bit), pure greedy (lazyDepth 0), explicit rep probes,
 * Huffman literals when smaller than raw. Prefer {@link compressFast} when
 * encode speed matters most.
 *
 * One-shot: writes Frame_Content_Size and a content checksum. For a push or
 * `pipeThrough` stream, use {@link CompressStrong} / {@link compressStrongStream}.
 */
export function compressStrong(data: Uint8Array): Uint8Array {
  return encodeFrame(data, STRONG_CONFIG, encodeLiteralsWithHuffman, selectSequenceTable);
}

/**
 * Strong encode under an explicit matcher config. Config-sweep entry — not a
 * public product surface; shape may change with the matcher.
 */
export function compressStrongWithConfig(data: Uint8Array, config: MatcherConfig): Uint8Array {
  return encodeFrame(data, config, encodeLiteralsWithHuffman, selectSequenceTable);
}

/**
 * Push-based Strong encoder. One instance is one frame.
 *
 * Same framing as {@link CompressFast}: no FCS, 1 MiB window, checksum always
 * on. Huffman and custom FSE still apply per block.
 *
 * ```ts
 * const enc = new CompressStrong((chunk) => sink(chunk));
 * enc.push(part);
 * enc.push(new Uint8Array(0), true);
 * ```
 *
 * Prefer {@link compressStrongStream} when composing with `pipeThrough`.
 */
export class CompressStrong {
  private readonly inner: EncodeStream;

  constructor(ondata?: ZstdStreamHandler) {
    this.inner = new EncodeStream(
      STRONG_CONFIG,
      encodeLiteralsWithHuffman,
      ondata,
      selectSequenceTable,
    );
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
 * A `TransformStream` that compresses with {@link CompressStrong}.
 *
 * ```ts
 * readable.pipeThrough(compressStrongStream());
 * ```
 *
 * `TransformStream` is referenced lazily inside the factory so importing this
 * module still works where the host API is absent. Never `extends` it.
 */
export function compressStrongStream(): TransformStream<Uint8Array, Uint8Array> {
  let enc: CompressStrong | undefined;
  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      enc = new CompressStrong((chunk) => {
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

export type { MatcherConfig, MatchStats };
export { withMatchStats };
