/**
 * Huffman tree + reverse-bitstream encode for zstd literal sections.
 *
 * Fail-closed: returns null unless the tree is representable with a direct
 * 4-bit weight header, the Kraft sum closes exactly, and the decoder's table
 * fill reproduces a code for every present symbol. Callers must fall back to
 * raw/RLE.
 */

import { encodeReverseBitstream, ReverseBitWriter } from "./bitstream.js";
import { chooseTableLog, normalizeCounts, writeTableDescription } from "./fse-tables.js";
import { buildFseDecodeTable, buildStatePath } from "./fse.js";

/** Format cap on Huffman code length (and therefore on weight values). */
const MAX_CODE_BITS = 11;
/** Direct 4-bit weight headers carry at most 128 weights (header byte 127+n). */
const MAX_DIRECT_WEIGHTS = 128;
/** Weight headers are FSE-coded at accuracy log 6 or less. */
const WEIGHT_MAX_TABLE_LOG = 6;
/** An FSE weight header declares its own size in one byte, so it must fit. */
const MAX_FSE_WEIGHT_HEADER = 127;
/** Below this a tree description never pays for itself. */
const MIN_LITERALS = 16;
/** Jump table for the 4-stream layout: three u16 stream sizes. */
const JUMP_TABLE_SIZE = 6;

export type HuffmanTable = {
  maxNumBits: number;
  codeBySymbol: Int32Array;
  numBitsBySymbol: Uint8Array;
};

/**
 * Canonical Huffman code lengths via the two-queue method: one sort, then a
 * linear merge (internal nodes come out in non-decreasing weight order, so two
 * cursors replace a heap). `depths[s]` is 0 for absent symbols.
 * Returns null when fewer than two symbols are present.
 */
function buildHuffmanDepths(freq: Uint32Array): Uint8Array | null {
  const symbolCount = freq.length;
  const order: Array<number> = [];
  for (let s = 0; s < symbolCount; s++) {
    if ((freq[s] ?? 0) > 0) order.push(s);
  }
  const n = order.length;
  if (n < 2) return null;
  order.sort((a, b) => {
    const fa = freq[a] ?? 0;
    const fb = freq[b] ?? 0;
    return fa !== fb ? fa - fb : a - b;
  });

  // Nodes 0..n-1 are leaves in ascending weight; n..2n-2 are internal nodes in
  // creation order, which is also ascending weight.
  const total = 2 * n - 1;
  const weight = new Float64Array(total);
  const left = new Int32Array(total);
  const right = new Int32Array(total);
  for (let i = 0; i < n; i++) weight[i] = freq[order[i] ?? 0] ?? 0;

  let leaf = 0;
  let internal = n;
  for (let next = n; next < total; next++) {
    // Prefer the leaf queue on ties: fewer deep nodes, so the length limit
    // below is reached less often.
    let a = 0;
    if (leaf < n && (internal >= next || (weight[leaf] ?? 0) <= (weight[internal] ?? 0))) {
      a = leaf++;
    } else a = internal++;
    let b = 0;
    if (leaf < n && (internal >= next || (weight[leaf] ?? 0) <= (weight[internal] ?? 0))) {
      b = leaf++;
    } else b = internal++;
    weight[next] = (weight[a] ?? 0) + (weight[b] ?? 0);
    left[next] = a;
    right[next] = b;
  }

  // Every child index is below its parent's, so one descending pass over the
  // internal nodes assigns all depths after the root's implicit 0.
  const nodeDepth = new Int32Array(total);
  for (let i = total - 1; i >= n; i--) {
    const d = (nodeDepth[i] ?? 0) + 1;
    nodeDepth[left[i] ?? 0] = d;
    nodeDepth[right[i] ?? 0] = d;
  }
  const depths = new Uint8Array(symbolCount);
  for (let i = 0; i < n; i++) {
    const d = nodeDepth[i] ?? 0;
    depths[order[i] ?? 0] = d < 1 ? 1 : d;
  }
  return depths;
}

/**
 * Code lengths capped at {@link MAX_CODE_BITS}. Rebuilding on halved
 * frequencies flattens the tree; once every present symbol weighs 1 the tree is
 * at most ceil(log2 256) = 8 deep, so the loop always terminates.
 */
function buildLimitedDepths(freq: Uint32Array): { depths: Uint8Array; maxDepth: number } | null {
  const work = Uint32Array.from(freq);
  for (;;) {
    const depths = buildHuffmanDepths(work);
    if (!depths) return null;
    let maxDepth = 0;
    for (let s = 0; s < depths.length; s++) {
      const d = depths[s] ?? 0;
      if (d > maxDepth) maxDepth = d;
    }
    if (maxDepth <= 0) return null;
    if (maxDepth <= MAX_CODE_BITS) return { depths, maxDepth };
    let changed = false;
    for (let s = 0; s < work.length; s++) {
      const f = work[s] ?? 0;
      if (f > 1) {
        work[s] = (f + 1) >>> 1;
        changed = true;
      }
    }
    if (!changed) return null;
  }
}

/**
 * Build a Huffman table from literal frequencies.
 * Returns null if Huffman is not representable or unsafe to emit.
 */
export function buildHuffmanTable(literals: Uint8Array): {
  weights: Array<number>;
  table: HuffmanTable;
} | null {
  if (literals.length < MIN_LITERALS) return null;
  const freq = new Uint32Array(256);
  let maxSymbol = 0;
  for (let i = 0; i < literals.length; i++) {
    const b = literals[i] ?? 0;
    freq[b] = (freq[b] ?? 0) + 1;
    if (b > maxSymbol) maxSymbol = b;
  }
  let distinct = 0;
  for (let s = 0; s <= maxSymbol; s++) {
    if ((freq[s] ?? 0) > 0) distinct++;
  }
  if (distinct < 2) return null;
  // The weight header omits the last present symbol (the decoder infers it
  // from the Kraft remainder), so it carries exactly `maxSymbol` weights.
  if (maxSymbol < 1) return null;

  const limited = buildLimitedDepths(freq.subarray(0, maxSymbol + 1));
  if (!limited) return null;
  const { depths, maxDepth } = limited;

  const fullWeights = new Uint8Array(256);
  for (let s = 0; s <= maxSymbol; s++) {
    const d = depths[s] ?? 0;
    if (d > 0) fullWeights[s] = maxDepth + 1 - d;
  }

  // Kraft sum of 2^(w-1) over non-zero weights must close on the table size,
  // which is what lets the decoder infer the omitted last weight.
  let kraft = 0;
  for (let s = 0; s <= maxSymbol; s++) {
    const w = fullWeights[s] ?? 0;
    if (w > 0) kraft += 1 << (w - 1);
  }
  if (kraft !== 1 << maxDepth) return null;

  const weights: Array<number> = [];
  for (let i = 0; i < maxSymbol; i++) weights.push(fullWeights[i] ?? 0);

  // Mirror the decoder table fill (see decompress rhu).
  const numBitsBySymbol = new Uint8Array(256);
  const codeBySymbol = new Int32Array(256).fill(-1);
  const rankCount = new Uint32Array(MAX_CODE_BITS + 1);
  for (let s = 0; s <= maxSymbol; s++) {
    const w = fullWeights[s] ?? 0;
    const bits = w === 0 ? 0 : maxDepth + 1 - w;
    numBitsBySymbol[s] = bits;
    if (bits > 0) rankCount[bits] = (rankCount[bits] ?? 0) + 1;
  }

  const tableSize = 1 << maxDepth;
  const ri = new Uint32Array(MAX_CODE_BITS + 1);
  ri[maxDepth] = 0;
  for (let bits = maxDepth; bits > 0; bits--) {
    const start = ri[bits] ?? 0;
    const count = rankCount[bits] ?? 0;
    const span = 1 << (maxDepth - bits);
    ri[bits - 1] = start + count * span;
  }
  if ((ri[0] ?? 0) !== tableSize) return null;

  for (let s = 0; s <= maxSymbol; s++) {
    const bits = numBitsBySymbol[s] ?? 0;
    if (bits === 0) continue;
    const codeStart = ri[bits] ?? 0;
    const span = 1 << (maxDepth - bits);
    // Prefix code = high bits of the first table slot for this symbol.
    codeBySymbol[s] = codeStart >>> (maxDepth - bits);
    ri[bits] = codeStart + span;
  }

  for (let s = 0; s <= maxSymbol; s++) {
    if ((freq[s] ?? 0) > 0 && (codeBySymbol[s] ?? -1) < 0) return null;
  }

  return {
    weights,
    table: { maxNumBits: maxDepth, codeBySymbol, numBitsBySymbol },
  };
}

function writeDirectWeightHeader(weights: Array<number>): Uint8Array {
  const n = weights.length;
  const headerByte = 127 + n;
  const bodyLen = (n + 1) >> 1;
  const out = new Uint8Array(1 + bodyLen);
  out[0] = headerByte;
  // Decoder: Weight[0] = Byte >> 4, Weight[1] = Byte & 0xf
  for (let i = 0; i < n; i += 2) {
    const hi = weights[i] ?? 0;
    const lo = weights[i + 1] ?? 0;
    out[1 + (i >> 1)] = ((hi & 0xf) << 4) | (lo & 0xf);
  }
  return out;
}

/**
 * FSE-compressed weight header, used when there are too many weights for the
 * direct 4-bit form (a literal byte above 128 forces this).
 *
 * The decoder reads the weights from two interleaved FSE states: state 1 emits
 * the even-indexed weights, state 2 the odd-indexed ones, and their update bits
 * alternate. So the two subsequences are independent state chains that share a
 * table. Returns null whenever the header cannot be represented.
 */
function writeFseWeightHeader(weights: Array<number>): Uint8Array | null {
  const n = weights.length;
  if (n < 2) return null;

  const counts = new Uint32Array(MAX_CODE_BITS + 1);
  let maxWeight = 0;
  let present = 0;
  for (const w of weights) {
    if (w > MAX_CODE_BITS) return null;
    if ((counts[w] ?? 0) === 0) present++;
    counts[w] = (counts[w] ?? 0) + 1;
    if (w > maxWeight) maxWeight = w;
  }
  // A single weight value would give every state a zero-bit transition, and
  // the decoder's loop only terminates when a read consumes bits.
  if (present < 2) return null;

  const tableLog = chooseTableLog(n, maxWeight, present, WEIGHT_MAX_TABLE_LOG);
  const normalized = normalizeCounts(counts, n, maxWeight, tableLog);
  if (!normalized) return null;
  const description = writeTableDescription(normalized, maxWeight, tableLog);
  if (!description) return null;
  const table = buildFseDecodeTable(normalized, tableLog);

  const evenLength = (n + 1) >> 1;
  const oddLength = n >> 1;
  const even = new Uint8Array(evenLength);
  const odd = new Uint8Array(oddLength);
  for (let i = 0; i < n; i++) {
    if ((i & 1) === 0) even[i >> 1] = weights[i] ?? 0;
    else odd[i >> 1] = weights[i] ?? 0;
  }
  const evenPath = buildStatePath(even, table);
  const oddPath = buildStatePath(odd, table);
  if (!evenPath || !oddPath) return null;

  // Fields in decode order: both initial states, then update bits alternating
  // between the chains until each is exhausted.
  const fieldCount = n;
  const bitCounts = new Uint8Array(fieldCount);
  const bitValues = new Uint32Array(fieldCount);
  let p = 0;
  bitCounts[p] = tableLog;
  bitValues[p++] = evenPath.states[0] ?? 0;
  bitCounts[p] = tableLog;
  bitValues[p++] = oddPath.states[0] ?? 0;
  for (let i = 0; i < evenLength - 1 || i < oddLength - 1; i++) {
    if (i < evenLength - 1) {
      bitCounts[p] = table.numBits[evenPath.states[i] ?? 0] ?? 0;
      bitValues[p++] = evenPath.updateBits[i] ?? 0;
    }
    if (i < oddLength - 1) {
      bitCounts[p] = table.numBits[oddPath.states[i] ?? 0] ?? 0;
      bitValues[p++] = oddPath.updateBits[i] ?? 0;
    }
  }
  if (p !== fieldCount) return null;

  const stream = encodeReverseBitstream(bitCounts, bitValues);
  const bodyLength = description.length + stream.length;
  // The header byte carries the body size, which is what marks this form.
  if (bodyLength < 1 || bodyLength > MAX_FSE_WEIGHT_HEADER) return null;

  const out = new Uint8Array(1 + bodyLength);
  out[0] = bodyLength;
  out.set(description, 1);
  out.set(stream, 1 + description.length);
  return out;
}

/**
 * Huffman-code `literals[start..end)` into one reverse bitstream. The decoder
 * walks a stream from its last set bit backwards, so symbols go out in reverse
 * and the end marker lands on top.
 */
function encodeHuffmanStream(
  table: HuffmanTable,
  literals: Uint8Array,
  start: number,
  end: number,
  writer: ReverseBitWriter,
): Uint8Array | null {
  let bitLength = 1; // end marker
  for (let i = start; i < end; i++) {
    const sym = literals[i] ?? 0;
    const bits = table.numBitsBySymbol[sym] ?? 0;
    if (bits <= 0 || (table.codeBySymbol[sym] ?? -1) < 0) return null;
    bitLength += bits;
  }
  writer.reset(bitLength);
  for (let i = end - 1; i >= start; i--) {
    const sym = literals[i] ?? 0;
    writer.writeBits(table.numBitsBySymbol[sym] ?? 0, table.codeBySymbol[sym] ?? 0);
  }
  writer.writeBits(1, 1);
  return writer.finish();
}

/** Bytes a raw literals section would take for `size` literals. */
function rawLiteralsSize(size: number): number {
  return (size <= 31 ? 1 : size <= 0x0fff ? 2 : 3) + size;
}

/**
 * Frame a compressed literals section around an encoded tree + streams.
 *
 * Size_Format picks both header width and stream count: 00 is the only
 * single-stream layout (10-bit sizes); 01/10/11 are 4-stream with 10/14/18-bit
 * sizes. Compressed_Size spans the tree, the jump table, and the streams.
 */
function packCompressedLiterals(
  regenSize: number,
  fourStreams: boolean,
  tree: Uint8Array,
  streams: ReadonlyArray<Uint8Array>,
): Uint8Array | null {
  let streamBytes = 0;
  for (const s of streams) {
    if (s.length === 0) return null;
    streamBytes += s.length;
  }
  if (fourStreams) {
    // Jump table entries are u16.
    for (let i = 0; i < 3; i++) {
      if ((streams[i]?.length ?? 0) > 0xffff) return null;
    }
  }
  const jump = fourStreams ? JUMP_TABLE_SIZE : 0;
  const compressedSize = tree.length + jump + streamBytes;

  let sizeFormat: number;
  let headerLen: number;
  if (regenSize <= 0x3ff && compressedSize <= 0x3ff) {
    sizeFormat = fourStreams ? 1 : 0;
    headerLen = 3;
  } else if (!fourStreams) {
    return null;
  } else if (regenSize <= 0x3fff && compressedSize <= 0x3fff) {
    sizeFormat = 2;
    headerLen = 4;
  } else if (regenSize <= 0x3ffff && compressedSize <= 0x3ffff) {
    sizeFormat = 3;
    headerLen = 5;
  } else return null;

  const out = new Uint8Array(headerLen + compressedSize);
  // Byte 0: block type (2 = compressed) | size format | low 4 regen bits.
  out[0] = 2 | (sizeFormat << 2) | ((regenSize & 0x0f) << 4);
  if (sizeFormat < 2) {
    out[1] = ((regenSize >>> 4) & 0x3f) | ((compressedSize & 0x03) << 6);
    out[2] = (compressedSize >>> 2) & 0xff;
  } else if (sizeFormat === 2) {
    out[1] = (regenSize >>> 4) & 0xff;
    out[2] = ((regenSize >>> 12) & 0x03) | ((compressedSize & 0x3f) << 2);
    out[3] = (compressedSize >>> 6) & 0xff;
  } else {
    out[1] = (regenSize >>> 4) & 0xff;
    out[2] = ((regenSize >>> 12) & 0x3f) | ((compressedSize & 0x03) << 6);
    out[3] = (compressedSize >>> 2) & 0xff;
    out[4] = (compressedSize >>> 10) & 0xff;
  }

  let p = headerLen;
  out.set(tree, p);
  p += tree.length;
  if (fourStreams) {
    for (let i = 0; i < 3; i++) {
      const len = streams[i]?.length ?? 0;
      out[p++] = len & 0xff;
      out[p++] = (len >>> 8) & 0xff;
    }
  }
  for (const s of streams) {
    out.set(s, p);
    p += s.length;
  }
  return out;
}

/**
 * Encode a literals section with Huffman when strictly smaller than raw.
 * Returns null on any doubt (caller uses raw/RLE).
 */
export function tryEncodeHuffmanLiterals(literals: Uint8Array): Uint8Array | null {
  const regenSize = literals.length;
  if (regenSize < MIN_LITERALS) return null;
  const built = buildHuffmanTable(literals);
  if (!built) return null;

  // Direct 4-bit weights cost n/2 bytes and cap out at 128 weights; the FSE
  // form has a table description to pay for but scales. Try both when both are
  // legal and keep the smaller.
  const direct =
    built.weights.length <= MAX_DIRECT_WEIGHTS ? writeDirectWeightHeader(built.weights) : null;
  const fse = writeFseWeightHeader(built.weights);
  const tree = direct && (!fse || direct.length <= fse.length) ? direct : (fse ?? null);
  if (!tree) return null;
  const writer = new ReverseBitWriter();

  // One stream skips the 6-byte jump table, so try it whenever it can fit.
  let out: Uint8Array | null = null;
  if (regenSize <= 0x3ff) {
    const single = encodeHuffmanStream(built.table, literals, 0, regenSize, writer);
    if (single) out = packCompressedLiterals(regenSize, false, tree, [single]);
  }

  if (!out) {
    // The decoder recomputes the split from the regen size alone: three
    // segments of ceil(regen/4), then whatever is left.
    const segment = (regenSize + 3) >>> 2;
    if (regenSize - 3 * segment < 1) return null;
    const streams: Array<Uint8Array> = [];
    for (let i = 0; i < 4; i++) {
      const start = i * segment;
      const end = i === 3 ? regenSize : start + segment;
      const stream = encodeHuffmanStream(built.table, literals, start, end, writer);
      if (!stream) return null;
      streams.push(stream);
    }
    out = packCompressedLiterals(regenSize, true, tree, streams);
  }

  if (!out || out.length >= rawLiteralsSize(regenSize)) return null;
  return out;
}
