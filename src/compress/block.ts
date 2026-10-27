/**
 * Multi-sequence compressed block packing: literals + predefined-FSE sequences.
 * Literals encoding is injected so Fast never imports Huffman.
 */

import { encodeReverseBitstream, ReverseBitWriter } from "./bitstream.js";
import type { SequenceCodeTable } from "./fse-tables.js";
import { getPredefinedFseTables, buildStatePath, type FseDecodeTable } from "./fse.js";

export type Sequence = {
  literalsLength: number;
  /**
   * Encoded offset_value:
   * - 1..3: repeat-offset codes
   * - ≥4: distance + 3
   */
  offset: number;
  matchLength: number;
};

/** Builds a literals section (raw/RLE and optionally Huffman). */
export type LiteralsEncoder = (literals: Uint8Array) => Uint8Array;

/**
 * Chooses the Compression_Mode for one sequence code stream. Injected so the
 * custom-table machinery stays out of the Fast module graph.
 */
export type SequenceTableSelector = (
  codes: Uint8Array,
  maxSymbolValue: number,
  maxTableLog: number,
  predefined: FseDecodeTable,
) => SequenceCodeTable;

/** Max Accuracy_Log the format allows per code stream. */
const LL_MAX_TABLE_LOG = 9;
const OF_MAX_TABLE_LOG = 8;
const ML_MAX_TABLE_LOG = 9;
/** Highest code value each stream can carry. */
const LL_MAX_SYMBOL = 35;
const OF_MAX_SYMBOL = 28;
const ML_MAX_SYMBOL = 52;

/** Fast's policy: always the predefined tables, no description bytes. */
export const usePredefinedTables: SequenceTableSelector = (
  _codes,
  _maxSymbolValue,
  _maxTableLog,
  predefined,
) => ({ mode: 0, table: predefined, description: EMPTY_DESCRIPTION });

const EMPTY_DESCRIPTION = new Uint8Array(0);

const LL_BASELINE = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256,
  512, 1024, 2048, 4096, 8192, 16384, 32768, 65536,
] as const;
const LL_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12,
  13, 14, 15, 16,
] as const;
const ML_BASELINE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
  29, 30, 31, 32, 33, 34, 35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051,
  4099, 8195, 16387, 32771, 65539,
] as const;
const ML_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
  1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
] as const;

/**
 * Write LL/ML/OF code + extra bits into parallel arrays (no per-seq objects).
 * Returns false only if the offset code exceeds the format max (28).
 */
function encodeSeqCodes(
  litLen: number,
  matchLen: number,
  offsetValue: number,
  llCodes: Uint8Array,
  llExtraN: Uint8Array,
  llExtraV: Uint32Array,
  mlCodes: Uint8Array,
  mlExtraN: Uint8Array,
  mlExtraV: Uint32Array,
  ofCodes: Uint8Array,
  ofExtraN: Uint8Array,
  ofExtraV: Uint32Array,
  i: number,
): boolean {
  // Literal length code
  if (litLen <= 15) {
    llCodes[i] = litLen;
    llExtraN[i] = 0;
    llExtraV[i] = 0;
  } else {
    let llCode = 35;
    let llN = 16;
    let llExtra = Math.max(0, litLen - 65536);
    for (let code = 16; code < LL_BASELINE.length; code++) {
      const base = LL_BASELINE[code] ?? 0;
      const n = LL_BITS[code] ?? 0;
      if (litLen >= base && litLen < base + (1 << n)) {
        llCode = code;
        llN = n;
        llExtra = litLen - base;
        break;
      }
    }
    llCodes[i] = llCode;
    llExtraN[i] = llN;
    llExtraV[i] = llExtra;
  }

  // Match length code (full match length; codes 0..31 → lengths 3..34, 0 extra).
  if (matchLen < 3) {
    mlCodes[i] = 0;
    mlExtraN[i] = 0;
    mlExtraV[i] = 0;
  } else if (matchLen <= 34) {
    mlCodes[i] = matchLen - 3;
    mlExtraN[i] = 0;
    mlExtraV[i] = 0;
  } else {
    let mlCode = 52;
    let mlN = 16;
    let mlExtra = Math.max(0, matchLen - 65539);
    // Code 32+ carry extra bits (35–36, 37–38, …).
    for (let code = 32; code < ML_BASELINE.length; code++) {
      const base = ML_BASELINE[code] ?? 0;
      const n = ML_BITS[code] ?? 0;
      if (matchLen >= base && matchLen < base + (1 << n)) {
        mlCode = code;
        mlN = n;
        mlExtra = matchLen - base;
        break;
      }
    }
    mlCodes[i] = mlCode;
    mlExtraN[i] = mlN;
    mlExtraV[i] = mlExtra;
  }

  // Offset code
  if (offsetValue < 1) {
    ofCodes[i] = 0;
    ofExtraN[i] = 0;
    ofExtraV[i] = 0;
    return true;
  }
  const ofCode = 31 - Math.clz32(offsetValue);
  if (ofCode > 28) return false;
  ofCodes[i] = ofCode;
  ofExtraN[i] = ofCode;
  ofExtraV[i] = offsetValue - (1 << ofCode);
  return true;
}

function writeBlockHeader(last: boolean, blockType: 0 | 1 | 2, size: number): Uint8Array {
  const header = (last ? 1 : 0) | (blockType << 1) | (size << 3);
  return new Uint8Array([header & 0xff, (header >>> 8) & 0xff, (header >>> 16) & 0xff]);
}

export function writeRawBlock(
  data: Uint8Array,
  start: number,
  size: number,
  last: boolean,
): Uint8Array {
  const header = writeBlockHeader(last, 0, size);
  const out = new Uint8Array(3 + size);
  out.set(header, 0);
  if (size > 0) out.set(data.subarray(start, start + size), 3);
  return out;
}

export function writeRLEBlock(value: number, size: number, last: boolean): Uint8Array {
  const header = writeBlockHeader(last, 1, size);
  return new Uint8Array([header[0] ?? 0, header[1] ?? 0, header[2] ?? 0, value & 0xff]);
}

function encodeNumSequences(n: number): Uint8Array | null {
  if (n < 0 || n > 0xffff + 0x7f00) return null;
  if (n < 128) return new Uint8Array([n & 0xff]);
  if (n < 0x7f00) {
    return new Uint8Array([(((n >>> 8) & 0x7f) + 0x80) & 0xff, n & 0xff]);
  }
  const v = n - 0x7f00;
  return new Uint8Array([0xff, v & 0xff, (v >>> 8) & 0xff]);
}

function buildSequenceSection(
  sequences: ReadonlyArray<Sequence>,
  selectTables: SequenceTableSelector,
): Uint8Array | null {
  if (sequences.length === 0) return new Uint8Array([0]);
  const n = sequences.length;
  const llCodes = new Uint8Array(n);
  const llExtraN = new Uint8Array(n);
  const llExtraV = new Uint32Array(n);
  const mlCodes = new Uint8Array(n);
  const mlExtraN = new Uint8Array(n);
  const mlExtraV = new Uint32Array(n);
  const ofCodes = new Uint8Array(n);
  const ofExtraN = new Uint8Array(n);
  const ofExtraV = new Uint32Array(n);

  for (let i = 0; i < n; i++) {
    const seq = sequences[i];
    if (!seq) return null;
    if (
      !encodeSeqCodes(
        seq.literalsLength,
        seq.matchLength,
        seq.offset,
        llCodes,
        llExtraN,
        llExtraV,
        mlCodes,
        mlExtraN,
        mlExtraV,
        ofCodes,
        ofExtraN,
        ofExtraV,
        i,
      )
    ) {
      return null;
    }
  }

  const predefined = getPredefinedFseTables();
  const llSel = selectTables(llCodes, LL_MAX_SYMBOL, LL_MAX_TABLE_LOG, predefined.ll);
  const ofSel = selectTables(ofCodes, OF_MAX_SYMBOL, OF_MAX_TABLE_LOG, predefined.of);
  const mlSel = selectTables(mlCodes, ML_MAX_SYMBOL, ML_MAX_TABLE_LOG, predefined.ml);
  const ll = llSel.table;
  const of = ofSel.table;
  const ml = mlSel.table;
  const llPath = buildStatePath(llCodes, ll);
  const ofPath = buildStatePath(ofCodes, of);
  const mlPath = buildStatePath(mlCodes, ml);
  if (!llPath || !ofPath || !mlPath) return null;

  const fieldCount = 3 + n * 3 + Math.max(0, n - 1) * 3;
  const counts = new Uint8Array(fieldCount);
  const values = new Uint32Array(fieldCount);
  let p = 0;
  // Initial states are read LL, OF, ML; an RLE table has table log 0, so its
  // state field is zero bits wide and contributes nothing.
  counts[p] = ll.tableLog;
  values[p++] = llPath.states[0] ?? 0;
  counts[p] = of.tableLog;
  values[p++] = ofPath.states[0] ?? 0;
  counts[p] = ml.tableLog;
  values[p++] = mlPath.states[0] ?? 0;

  for (let i = 0; i < n; i++) {
    counts[p] = ofExtraN[i] ?? 0;
    values[p++] = ofExtraV[i] ?? 0;
    counts[p] = mlExtraN[i] ?? 0;
    values[p++] = mlExtraV[i] ?? 0;
    counts[p] = llExtraN[i] ?? 0;
    values[p++] = llExtraV[i] ?? 0;
    if (i !== n - 1) {
      const llState = llPath.states[i] ?? 0;
      const mlState = mlPath.states[i] ?? 0;
      const ofState = ofPath.states[i] ?? 0;
      counts[p] = ll.numBits[llState] ?? 0;
      values[p++] = llPath.updateBits[i] ?? 0;
      counts[p] = ml.numBits[mlState] ?? 0;
      values[p++] = mlPath.updateBits[i] ?? 0;
      counts[p] = of.numBits[ofState] ?? 0;
      values[p++] = ofPath.updateBits[i] ?? 0;
    }
  }

  const bitstream = encodeReverseBitstream(
    counts.subarray(0, p),
    values.subarray(0, p),
    new ReverseBitWriter(),
  );
  const numBytes = encodeNumSequences(n);
  if (!numBytes) return null;
  // Symbol_Compression_Modes: LL bits 6-7, OF bits 4-5, ML bits 2-3, low two
  // bits reserved zero. Descriptions follow in that same order.
  const modes = (llSel.mode << 6) | (ofSel.mode << 4) | (mlSel.mode << 2);
  const descLen = llSel.description.length + ofSel.description.length + mlSel.description.length;
  const out = new Uint8Array(numBytes.length + 1 + descLen + bitstream.length);
  out.set(numBytes, 0);
  let q = numBytes.length;
  out[q++] = modes;
  out.set(llSel.description, q);
  q += llSel.description.length;
  out.set(ofSel.description, q);
  q += ofSel.description.length;
  out.set(mlSel.description, q);
  q += mlSel.description.length;
  out.set(bitstream, q);
  return out;
}

/**
 * Build a compressed block (type 2). Returns null if packing fails.
 */
export function writeCompressedBlock(
  literals: Uint8Array,
  sequences: ReadonlyArray<Sequence>,
  last: boolean,
  encodeLiterals: LiteralsEncoder,
  selectTables: SequenceTableSelector,
): Uint8Array | null {
  const litSection = encodeLiterals(literals);
  const seqSection = buildSequenceSection(sequences, selectTables);
  if (!seqSection) return null;
  const payloadLen = litSection.length + seqSection.length;
  if (payloadLen > 128 * 1024) return null;
  const out = new Uint8Array(3 + payloadLen);
  out.set(writeBlockHeader(last, 2, payloadLen), 0);
  out.set(litSection, 3);
  out.set(seqSection, 3 + litSection.length);
  return out;
}
