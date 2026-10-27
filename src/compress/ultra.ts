/**
 * Ultra-band encoder: larger window + secondary long-hash, still one-shot greedy.
 * Targets better ratio than Strong without multi-arm / optimal-parse tax.
 *
 * Reuses shared packing (Huffman literals, custom FSE). Own package entry so
 * Fast never pulls this module; Strong stays long-hash-free for encode speed.
 */

import { selectSequenceTable } from "./fse-tables.js";
import { encodeLiteralsWithHuffman } from "./literals-huffman.js";
import { encodeFrame, type MatcherConfig, type MatchStats, withMatchStats } from "./shared.js";

/**
 * Ultra match window — 8 MiB (stock zstd level 19 territory).
 * Strong stays at 1 MiB; this is the main long-range lever on multi-megabyte
 * structured data.
 */
const ULTRA_WINDOW = 8 * 1024 * 1024;

/**
 * Shipped Ultra matcher: one greedy pass.
 *
 * Strong's primary search (nullPatience 24, pure greedy), plus:
 * - 8 MiB window (legalises matches past Strong's 1 MiB)
 * - secondary 8-byte long-hash with lim4 (short chain) — Ultra's main ratio lever
 *
 * Deliberately **not** multi-arm, optimal DP, or binary-tree: those cost multi‑×
 * encode for a few points once long-hash is on. Long-hash is not on Strong:
 * lim4 costs ~33% Strong encode for ~0.5 pts of synthetic total.
 */
export const ULTRA_CONFIG: MatcherConfig = {
  chainLimit: 24,
  // Long-hash is measured against this primary post-hit budget.
  patience: 2,
  nullPatience: 24,
  lazyDepth: 0,
  preferRepOffsets: true,
  huffmanLiterals: true,
  offsetSurcharge16: 72,
  offsetSurchargeFrom: 3,
  windowSize: ULTRA_WINDOW,
  hashBits: 15,
  rowBits: 5,
  // Explicit rep probes. Long-hash does not substitute; required for
  // Ultra ≤ Strong on mixed.
  probeReps: true,
  longHashBits: 17,
  // lim4 ≈ 1.5× Strong encode; lim8 ≈ 1.6× for ~1 pt more size. Product: lim4.
  longChainLimit: 4,
  primaryHashBytes: 4,
  longHashOnlyIfShort: false,
  optimalParse: false,
  binaryTree: false,
  searchSkipShift: 0,
};

/**
 * Compress in the ultra quality band (stronger ratio than {@link compressStrong}).
 * One-shot only — writes Frame_Content_Size and a content checksum. Prefer
 * Strong when throughput matters more, or {@link CompressStrong} to stream.
 */
export function compressUltra(data: Uint8Array): Uint8Array {
  return encodeFrame(data, ULTRA_CONFIG, encodeLiteralsWithHuffman, selectSequenceTable);
}

/**
 * Ultra encode under an explicit matcher config. Config-sweep entry — not a
 * public product surface.
 */
export function compressUltraWithConfig(data: Uint8Array, config: MatcherConfig): Uint8Array {
  return encodeFrame(data, config, encodeLiteralsWithHuffman, selectSequenceTable);
}

export type { MatcherConfig, MatchStats };
export { withMatchStats };
