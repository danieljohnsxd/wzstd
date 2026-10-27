/**
 * Custom FSE tables for the sequence section (Strong/Ultra only).
 *
 * The predefined LL/ML/OF distributions are a fixed compromise; on real data
 * they cost several bits per sequence more than the code entropy. This module
 * normalizes the block's own code counts, writes the table description the
 * decoder reads back, and picks whichever Compression_Mode is cheapest.
 *
 * The normalization, table description, and accuracy-log helpers are also used
 * by the Huffman weight header, which is the same FSE machinery over a
 * different alphabet.
 *
 * Keep this out of the Fast import graph — Fast always uses the predefined tables.
 */

import { buildFseDecodeTable, type FseDecodeTable } from "./fse.js";

/** Accuracy_Log is stored as a 4-bit biased field, so 5 is the floor. */
const MIN_TABLE_LOG = 5;

/**
 * Compression_Mode: 0 predefined, 2 FSE_Compressed.
 *
 * RLE (mode 1) is deliberately absent — a custom table over a single symbol
 * gives that symbol every slot, which already costs zero bits per sequence, and
 * its description is a couple of bytes. Mode 2 subsumes it.
 */
export type SequenceCodeTable = {
  mode: 0 | 2;
  table: FseDecodeTable;
  /** Table description bytes emitted before the sequence bitstream. */
  description: Uint8Array;
};

const NO_DESCRIPTION = new Uint8Array(0);

function highBit(value: number): number {
  return 31 - Math.clz32(value);
}

/**
 * Spread `1 << tableLog` slots over the present symbols in proportion to their
 * counts, giving every present symbol at least one slot and handing the
 * leftovers to the largest fractional parts. Returns null when the table cannot
 * hold every present symbol.
 *
 * Unlike zstd this never emits the "less than one" (-1) probability: a uniform
 * minimum of one slot is a hair less precise but far easier to keep correct,
 * and the decoder accepts either.
 */
export function normalizeCounts(
  counts: Uint32Array,
  total: number,
  maxSymbol: number,
  tableLog: number,
): Array<number> | null {
  const tableSize = 1 << tableLog;
  const norm: Array<number> = Array.from({ length: maxSymbol + 1 }, () => 0);
  const fraction = new Float64Array(maxSymbol + 1);
  const present: Array<number> = [];
  let assigned = 0;

  for (let s = 0; s <= maxSymbol; s++) {
    const c = counts[s] ?? 0;
    if (c === 0) continue;
    const exact = (c * tableSize) / total;
    const floor = Math.floor(exact);
    const slots = floor < 1 ? 1 : floor;
    norm[s] = slots;
    fraction[s] = exact - floor;
    assigned += slots;
    present.push(s);
  }
  if (present.length === 0 || present.length > tableSize) return null;

  if (assigned < tableSize) {
    // Total shortfall is under one slot per symbol, so a single pass over the
    // symbols sorted by fractional part covers it.
    present.sort((a, b) => (fraction[b] ?? 0) - (fraction[a] ?? 0));
    for (let i = 0; assigned < tableSize; i++) {
      const s = present[i % present.length] ?? 0;
      norm[s] = (norm[s] ?? 0) + 1;
      assigned++;
    }
  }
  while (assigned > tableSize) {
    // The minimum-one floor can overshoot; reclaim from the widest symbol,
    // where one slot costs the least precision.
    let widest = -1;
    let widestSlots = 1;
    for (let s = 0; s <= maxSymbol; s++) {
      const v = norm[s] ?? 0;
      if (v > widestSlots) {
        widestSlots = v;
        widest = s;
      }
    }
    if (widest < 0) return null;
    norm[widest] = widestSlots - 1;
    assigned--;
  }
  return norm;
}

/**
 * Serialize a normalized distribution the way the decoder's table reader parses
 * it: a 4-bit biased accuracy log, then per-symbol values in a shrinking
 * bit-width driven by how much probability is still unassigned, with runs of
 * absent symbols folded into 2-bit repeat flags.
 */
export function writeTableDescription(
  normalized: ReadonlyArray<number>,
  maxSymbol: number,
  tableLog: number,
): Uint8Array | null {
  const tableSize = 1 << tableLog;
  const out: Array<number> = [];
  let bitStream = 0;
  let bitCount = 0;

  bitStream |= (tableLog - MIN_TABLE_LOG) << bitCount;
  bitCount += 4;

  // One extra unit of headroom keeps the final value distinguishable, matching
  // the decoder's `remaining > 0` termination.
  let remaining = tableSize + 1;
  let threshold = tableSize;
  let nbBits = tableLog + 1;
  let symbol = 0;
  let previousIsZero = false;

  while (symbol <= maxSymbol && remaining > 1) {
    if (previousIsZero) {
      let start = symbol;
      while (symbol <= maxSymbol && (normalized[symbol] ?? 0) === 0) symbol++;
      if (symbol > maxSymbol) break;
      // Eight consecutive "3" flags (24 symbols) fill a whole 16-bit flush.
      while (symbol >= start + 24) {
        start += 24;
        bitStream |= 0xffff << bitCount;
        out.push(bitStream & 0xff, (bitStream >>> 8) & 0xff);
        bitStream >>>= 16;
      }
      while (symbol >= start + 3) {
        start += 3;
        bitStream |= 3 << bitCount;
        bitCount += 2;
      }
      bitStream |= (symbol - start) << bitCount;
      bitCount += 2;
      if (bitCount > 16) {
        out.push(bitStream & 0xff, (bitStream >>> 8) & 0xff);
        bitStream >>>= 16;
        bitCount -= 16;
      }
    }

    const count = normalized[symbol] ?? 0;
    symbol++;
    const max = 2 * threshold - 1 - remaining;
    remaining -= count < 0 ? -count : count;
    let value = count + 1;
    if (value >= threshold) value += max;
    bitStream |= value << bitCount;
    bitCount += nbBits;
    // Values below `max` are unambiguous one bit short.
    if (value < max) bitCount -= 1;
    previousIsZero = value === 1;
    if (remaining < 1) return null;
    while (remaining < threshold) {
      nbBits--;
      threshold >>= 1;
    }
    if (bitCount > 16) {
      out.push(bitStream & 0xff, (bitStream >>> 8) & 0xff);
      bitStream >>>= 16;
      bitCount -= 16;
    }
  }
  // Every slot must be accounted for, or the decoder will reject the table.
  if (remaining !== 1) return null;

  out.push(bitStream & 0xff, (bitStream >>> 8) & 0xff);
  return new Uint8Array(out.slice(0, out.length - 2 + ((bitCount + 7) >> 3)));
}

/**
 * Approximate cost of coding `counts` against a table that gives each symbol
 * `slots` of `1 << tableLog`. An FSE symbol costs about tableLog - log2(slots)
 * bits, which is close enough to rank the candidate modes.
 */
function estimateBits(
  counts: Uint32Array,
  slots: ArrayLike<number>,
  tableLog: number,
  maxSymbol: number,
): number {
  let bits = 0;
  for (let s = 0; s <= maxSymbol; s++) {
    const c = counts[s] ?? 0;
    if (c === 0) continue;
    const n = slots[s] ?? 0;
    // The table cannot represent this symbol at all.
    if (n <= 0) return Number.POSITIVE_INFINITY;
    bits += c * (tableLog - Math.log2(n));
  }
  return bits;
}

/**
 * Total bits a mode costs for one stream: its description, the initial state
 * field (Accuracy_Log wide), and one state transition per sequence *after the
 * first*. The last sequence needs no transition, which is the whole cost of a
 * stream holding a single sequence — there the fixed parts decide.
 */
function modeCostBits(
  descriptionBytes: number,
  tableLog: number,
  symbolBits: number,
  numSequences: number,
): number {
  const transitionShare = numSequences > 1 ? (numSequences - 1) / numSequences : 0;
  return descriptionBytes * 8 + tableLog + symbolBits * transitionShare;
}

/** Slots per symbol in an existing decode table (recovers its distribution). */
function slotCounts(table: FseDecodeTable, maxSymbol: number): Uint32Array {
  const out = new Uint32Array(maxSymbol + 1);
  for (let i = 0; i < table.length; i++) {
    const sym = table.symbol[i] ?? 0;
    if (sym <= maxSymbol) out[sym] = (out[sym] ?? 0) + 1;
  }
  return out;
}

/**
 * Accuracy log for this code stream, following zstd's heuristic: fine enough to
 * separate the symbols, coarse enough that the table description does not
 * outweigh what it saves on a short sequence run.
 */
export function chooseTableLog(
  numSequences: number,
  maxSymbol: number,
  presentCount: number,
  maxTableLog: number,
): number {
  let tableLog = maxTableLog;
  const fromSize = highBit(Math.max(2, numSequences) - 1) - 2;
  if (fromSize < tableLog) tableLog = fromSize;
  const minBits = Math.min(
    highBit(Math.max(1, numSequences)) + 1,
    highBit(Math.max(1, maxSymbol)) + 2,
  );
  if (minBits > tableLog) tableLog = minBits;
  // Every present symbol needs at least one slot.
  while (1 << tableLog < presentCount && tableLog < maxTableLog) tableLog++;
  if (tableLog < MIN_TABLE_LOG) tableLog = MIN_TABLE_LOG;
  if (tableLog > maxTableLog) tableLog = maxTableLog;
  return tableLog;
}

/**
 * Pick the cheapest Compression_Mode for one code stream.
 *
 * Falls back to the predefined table on anything unexpected, so a stream this
 * module cannot improve still encodes exactly as it did before.
 */
export function selectSequenceTable(
  codes: Uint8Array,
  maxSymbolValue: number,
  maxTableLog: number,
  predefined: FseDecodeTable,
): SequenceCodeTable {
  const predefinedChoice: SequenceCodeTable = {
    mode: 0,
    table: predefined,
    description: NO_DESCRIPTION,
  };
  const numSequences = codes.length;
  if (numSequences === 0) return predefinedChoice;

  const counts = new Uint32Array(maxSymbolValue + 1);
  let maxSymbol = 0;
  let present = 0;
  for (let i = 0; i < numSequences; i++) {
    const c = codes[i] ?? 0;
    if (c > maxSymbolValue) return predefinedChoice;
    if ((counts[c] ?? 0) === 0) present++;
    counts[c] = (counts[c] ?? 0) + 1;
    if (c > maxSymbol) maxSymbol = c;
  }

  // Both modes are priced: on a short sequence run the table description can
  // easily cost more than the predefined table's state bits.
  const predefinedBits = modeCostBits(
    0,
    predefined.tableLog,
    estimateBits(counts, slotCounts(predefined, maxSymbol), predefined.tableLog, maxSymbol),
    numSequences,
  );

  const tableLog = chooseTableLog(numSequences, maxSymbol, present, maxTableLog);
  const normalized = normalizeCounts(counts, numSequences, maxSymbol, tableLog);
  if (!normalized) return predefinedChoice;
  const description = writeTableDescription(normalized, maxSymbol, tableLog);
  if (!description) return predefinedChoice;

  // normalizeCounts never emits -1, so the distribution is the slot count.
  const customBits = modeCostBits(
    description.length,
    tableLog,
    estimateBits(counts, normalized, tableLog, maxSymbol),
    numSequences,
  );
  if (!(customBits < predefinedBits)) return predefinedChoice;

  return {
    mode: 2,
    table: buildFseDecodeTable(normalized, tableLog),
    description,
  };
}
