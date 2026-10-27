/**
 * Shared frame encode loop + match infrastructure used by Fast and Strong.
 * Does not import Huffman — literals encoding is injected by the caller.
 */

import { Xxh64 } from "../xxh64.js";
import {
  usePredefinedTables,
  writeCompressedBlock,
  writeRawBlock,
  writeRLEBlock,
  type LiteralsEncoder,
  type Sequence,
  type SequenceTableSelector,
} from "./block.js";

/**
 * Deterministic matcher work counters.
 *
 * Wall-clock between processes varies widely on Strong; these counts do not.
 * Enable with {@link withMatchStats}. When unset, the hot path only pays a
 * null check per search.
 */
export type MatchStats = {
  /** `bestMatchAt` invocations (primary + lazy). */
  searches: number;
  primarySearches: number;
  lazySearches: number;
  /** Candidates examined inside the chain/row walk. */
  probes: number;
  /** Probes whose 4-byte needle matched (genuine repeats or collisions). */
  needleHits: number;
  /** Needle hits that also passed the minLen-1 filter and ran `matchLengthAt`. */
  extends: number;
  /** Times an incumbent best was replaced or first-found. */
  improvements: number;
  /** Searches that returned a usable match. */
  hits: number;
  /** Walk exit reasons (one per search that entered the loop with a candidate). */
  exitPatience: number;
  exitNullPatience: number;
  exitChainLimit: number;
  exitMinLen: number;
  exitMaxMatch: number;
  exitNoCandidate: number;
};

export function emptyMatchStats(): MatchStats {
  return {
    searches: 0,
    primarySearches: 0,
    lazySearches: 0,
    probes: 0,
    needleHits: 0,
    extends: 0,
    improvements: 0,
    hits: 0,
    exitPatience: 0,
    exitNullPatience: 0,
    exitChainLimit: 0,
    exitMinLen: 0,
    exitMaxMatch: 0,
    exitNoCandidate: 0,
  };
}

let activeMatchStats: MatchStats | null = null;

/**
 * Run `fn` with matcher counters active. Nested calls replace the outer stats
 * for the duration of the inner call (no stacking).
 */
export function withMatchStats<T>(fn: () => T): {
  value: T;
  stats: MatchStats;
} {
  const stats = emptyMatchStats();
  const prev = activeMatchStats;
  activeMatchStats = stats;
  try {
    return { value: fn(), stats };
  } finally {
    activeMatchStats = prev;
  }
}

export const BLOCK_MAX = 128 * 1024;
/**
 * Match window. Blocks stay at 128 KiB, but matches may reach further back.
 * Frames up to this size are single-segment (the decoder derives its window
 * from the frame content size); larger frames carry an explicit window
 * descriptor pinned to this value — see {@link writeFrameHeader}.
 *
 * 1 MiB is where the gain saturates on real data: below it, long-range
 * structured input loses matches a larger window would find; above it the
 * extra memory buys almost nothing.
 */
export const WINDOW_SIZE = 1024 * 1024;
/** Default hash table log2 size (Ultra). Fast/Strong ship 17. */
export const DEFAULT_HASH_BITS = 15;
/**
 * Default per-bucket ring log2 width. `2^rowBits` must be ≥ `chainLimit` when
 * the ring layout is used, or the walk is capped early.
 */
export const DEFAULT_ROW_BITS = 5;
const MIN_MATCH = 4;

/**
 * Window descriptor byte: `Exponent << 3 | Mantissa` for
 * `Window_Size = (1 << (10 + Exponent)) + (1 << (10 + Exponent) >> 3) * Mantissa`.
 * Powers of two with log2 ≥ 10 encode as mantissa 0.
 */
export function windowDescriptorByte(windowSize: number): number {
  if (!Number.isInteger(windowSize) || windowSize < 1 << 10) {
    throw new RangeError("windowSize must be an integer ≥ 1024");
  }
  // Exact power of two: mantissa 0, exponent = log2(window) − 10.
  if ((windowSize & (windowSize - 1)) === 0) {
    const log = 31 - Math.clz32(windowSize);
    return (log - 10) << 3;
  }
  // General form: pick the largest base ≤ windowSize, then mantissa 0..7.
  let exp = 0;
  while (1 << (10 + exp + 1) <= windowSize && exp < 21) exp++;
  const base = 1 << (10 + exp);
  const step = base >> 3;
  let mant = 0;
  if (step > 0) {
    mant = Math.min(7, Math.floor((windowSize - base) / step));
  }
  return (exp << 3) | mant;
}

/** Matcher policy for a compressor strategy. */
export type MatcherConfig = {
  /** Hash-chain depth (1 = single-slot). */
  chainLimit: number;
  /**
   * Post-hit walk budget in `bestMatchAt`. After each probe the matcher does
   * `++sinceImprove` and exits when the counter reaches this value **once a
   * match has been found** (or a lazy `scoreFloor` is in play).
   *
   * **Counter quirk:** an improvement sets `sinceImprove = 0` and the same
   * iteration still increments, so the improving probe consumes one unit.
   * Effective non-improving probes after a hit ≈ `patience − 1`. Thus
   * `patience: 1` = first positive-score hit wins. Strong ships `patience: 4`.
   *
   * Ignored when `chainLimit` is 1. Fruitless walks use {@link nullPatience}.
   */
  patience: number;
  /**
   * Pre-hit walk budget: probes before *any* usable match is found. Set
   * generously (Strong/Ultra 24) because this is where late finds that carry
   * real bytes turn up. Orthogonal to post-hit {@link patience}; do not shrink
   * it to paper over a post-hit bug.
   */
  nullPatience: number;
  /** Lazy look-ahead (0 = pure greedy). */
  lazyDepth: number;
  /** Prefer recent offsets when scoring matches. */
  preferRepOffsets: boolean;
  /**
   * Literals will be Huffman-coded, so price them at the block's entropy
   * instead of a flat 8 bits. Raising the cost of a match relative to the
   * literals it replaces is what keeps short far matches out of the parse.
   */
  huffmanLiterals: boolean;
  /**
   * Extra 1/16-bit charge per offset bit past {@link offsetSurchargeFrom}.
   * This is a locality prior, not an FSE cost estimate: it keeps a monotone
   * preference for near offsets so the repeat-offset chain stays intact.
   * Strong/Ultra charge from code 3; Fast charges 0 (raw literals make a
   * rejected match pure loss).
   */
  offsetSurcharge16: number;
  /**
   * First offset code that pays {@link offsetSurcharge16}; codes below it are
   * charged nothing beyond their own extra bits.
   *
   * The repeat codes and the shortest explicit offsets live at the bottom of
   * the code range and carry the parse — they stay exempt.
   */
  offsetSurchargeFrom: number;
  /**
   * Match window in bytes. Frames at or below this size stay single-segment;
   * larger frames carry an explicit window descriptor for this value.
   * Fast/Strong use {@link WINDOW_SIZE} (1 MiB); Ultra may raise it (8 MiB).
   */
  windowSize: number;
  /**
   * Hash table log2 size. Wider tables thin the chains so a deep walk reaches
   * farther genuine repeats instead of burning patience on near collisions.
   * Fast/Strong ship 17; Ultra keeps {@link DEFAULT_HASH_BITS} (15).
   */
  hashBits: number;
  /**
   * Per-bucket ring log2 width when the contiguous layout is active.
   * Must satisfy `2^rowBits >= chainLimit` or the walk caps early on large inputs.
   * Strong/Ultra use {@link DEFAULT_ROW_BITS} (5 → 32). Fast uses 2 because
   * its four-slot row exactly covers its chain depth.
   */
  rowBits: number;
  /**
   * Probe the three repeat offsets explicitly before the hash-chain walk.
   * The chain only surfaces a rep when the 4-byte hash collides with it; many
   * valid rep matches are otherwise invisible. All three tiers ship this —
   * long-hash does not substitute.
   */
  probeReps: boolean;
  /**
   * Secondary hash over 8-byte needles (0 = off). Surfaces long matches the
   * 4-byte chain never reaches under patience budgets. Fast/Strong keep 0
   * (Ultra ships lim4).
   */
  longHashBits: number;
  /**
   * Max probes on the secondary long-hash chain. Ignored when
   * {@link longHashBits} is 0.
   */
  longChainLimit: number;
  /**
   * Primary table needle length. `4` finds short matches. `8` hashes and
   * verifies 8-byte needles only, dropping length 4–7 matches that cannot
   * share an 8-byte prefix. Fast/Strong/Ultra ship `4`.
   */
  primaryHashBytes: 4 | 8;
  /**
   * When true, run the secondary long-hash only if the primary search found
   * nothing or a match shorter than 8 bytes. Cuts long-hash probes on already
   * good local matches. Ignored when {@link longHashBits} is 0.
   */
  longHashOnlyIfShort: boolean;
  /**
   * When true, plan the block with a forward optimal parse (bit-cost DP over
   * match/literal decisions) instead of greedy+lazy. Ultra only — expensive,
   * but the product already accepts lower encode throughput for ratio.
   */
  optimalParse: boolean;
  /**
   * Use a binary-tree match finder (zstd bt* style) instead of a hash chain.
   * Positions with the same 4-byte hash are ordered by the following bytes, so
   * a bounded walk finds longer matches more often than a recency chain.
   * Fast/Strong keep the chain.
   */
  binaryTree: boolean;
  /**
   * Incompressible-run skip, zstd-fast style. After a miss, advance
   * `((pos - anchor) >> searchSkipShift) + 1` instead of 1. `0` disables
   * (always step 1). Fast ships 8; Strong/Ultra ship 0.
   */
  searchSkipShift: number;
};

/**
 * `max(0, code - from) * surcharge`, as a table.
 *
 * A table keeps the hot path to one array load rather than a multiply, and lets
 * the shape change without touching the matcher. Cached because a config is
 * fixed per level and this is called once per block.
 */
const offsetCostCache = new Map<number, Int32Array>();
function offsetCost16Table(surcharge16: number, from: number): Int32Array {
  const key = from * 4096 + surcharge16;
  const hit = offsetCostCache.get(key);
  if (hit) return hit;
  const t = new Int32Array(32);
  for (let b = 0; b < 32; b++) t[b] = Math.max(0, b - from) * surcharge16;
  offsetCostCache.set(key, t);
  return t;
}

/** Cost of a literal byte when the section cannot be Huffman-coded. */
const RAW_LITERAL_BITS16 = 8 << 4;
/**
 * Per-sequence cost independent of the offset, in 1/16-bit units: the LL, ML,
 * and OF state transitions under the predefined FSE tables. Tuned on the bench
 * corpus — too low re-admits the short far matches this model exists to reject.
 */
const SEQ_OVERHEAD_BITS16 = 16 << 4;
/**
 * Added to the measured entropy so literals are never priced below what the
 * Huffman section really costs (whole-bit codes plus the tree description).
 */
const LITERAL_COST_MARGIN16 = 8;

export type RepOffsets = [number, number, number];

/**
 * `Content_Checksum_flag` — bit 2 of the frame header descriptor.
 *
 * Set it and four bytes holding the low half of XXH64 over the frame content
 * follow the last block. Nothing else in the header changes size, so a checksum
 * costs exactly four bytes per frame.
 */
const CHECKSUM_FLAG = 0x04;

export function writeFrameHeader(
  contentSize: number,
  checksum = false,
  windowSize: number = WINDOW_SIZE,
): Uint8Array {
  // Fail closed: reject non-integers / negative / beyond 32-bit FCS field.
  // (JS ToUint32 would otherwise mint a wrong header for huge values.)
  if (!Number.isInteger(contentSize) || contentSize < 0 || contentSize > 0xffff_ffff) {
    throw new RangeError("contentSize must be an integer in 0..0xFFFFFFFF for frame header");
  }
  const n = contentSize >>> 0;
  const ck = checksum ? CHECKSUM_FLAG : 0;
  if (n <= 255) {
    const out = new Uint8Array(6);
    out[0] = 0x28;
    out[1] = 0xb5;
    out[2] = 0x2f;
    out[3] = 0xfd;
    out[4] = 0x20 | ck; // single-segment, FCS flag 0
    out[5] = n & 0xff;
    return out;
  }
  // FCS flag 1: Field_Value + 256, 16-bit field → max 0xffff + 256 = 65791
  if (n <= 256 + 0xffff) {
    const v = n - 256;
    const out = new Uint8Array(7);
    out[0] = 0x28;
    out[1] = 0xb5;
    out[2] = 0x2f;
    out[3] = 0xfd;
    out[4] = 0x60 | ck; // single-segment, FCS flag 1
    out[5] = v & 0xff;
    out[6] = (v >>> 8) & 0xff;
    return out;
  }
  if (n <= windowSize) {
    const out = new Uint8Array(9);
    out[0] = 0x28;
    out[1] = 0xb5;
    out[2] = 0x2f;
    out[3] = 0xfd;
    out[4] = 0xa0 | ck; // single-segment, FCS flag 2
    out[5] = n & 0xff;
    out[6] = (n >>> 8) & 0xff;
    out[7] = (n >>> 16) & 0xff;
    out[8] = (n >>> 24) & 0xff;
    return out;
  }
  // Above the match window, single-segment would declare Window_Size =
  // Frame_Content_Size and make every decoder reserve the whole payload for a
  // window we never reach past. Worse, it is not merely wasteful: zstd's
  // default decode limit is 2^27, so a single-segment frame over 128 MiB is
  // rejected outright ("Window size larger than maximum"). Emit an explicit
  // window descriptor instead — one extra byte, FCS still present.
  const out = new Uint8Array(10);
  out[0] = 0x28;
  out[1] = 0xb5;
  out[2] = 0x2f;
  out[3] = 0xfd;
  out[4] = 0x80 | ck; // windowed (not single-segment), FCS flag 2
  out[5] = windowDescriptorByte(windowSize);
  out[6] = n & 0xff;
  out[7] = (n >>> 8) & 0xff;
  out[8] = (n >>> 16) & 0xff;
  out[9] = (n >>> 24) & 0xff;
  return out;
}

function isAllSame(data: Uint8Array, start: number, size: number): boolean {
  if (size <= 1) return size === 1;
  const first = data[start] ?? 0;
  const end = start + size;
  for (let i = start + 1; i < end; i++) {
    if ((data[i] ?? 0) !== first) return false;
  }
  return true;
}

function encodeOffsetValue(distance: number, litLen: number, reps: RepOffsets): number {
  if (litLen !== 0) {
    if (distance === reps[0]) return 1;
    if (distance === reps[1]) return 2;
    if (distance === reps[2]) return 3;
  } else {
    if (distance === reps[1]) return 1;
    if (distance === reps[2]) return 2;
    if (reps[0] > 1 && distance === reps[0] - 1) return 3;
  }
  return distance + 3;
}

/** Mutates `reps` in place (hot path; avoids allocating a new triple). */
function updateRepOffsets(reps: RepOffsets, offsetValue: number, litLen: number): void {
  if (offsetValue > 3) {
    const actual = offsetValue - 3;
    reps[2] = reps[1];
    reps[1] = reps[0];
    reps[0] = actual;
    return;
  }
  const idx = offsetValue - (litLen !== 0 ? 1 : 0);
  if (idx === 0) return;
  if (idx === 3) {
    const actual = reps[0] - 1;
    reps[2] = reps[1];
    reps[1] = reps[0];
    reps[0] = actual;
    return;
  }
  const selected = reps[idx] ?? reps[0];
  if (idx === 1) {
    reps[1] = reps[0];
    reps[0] = selected;
  } else {
    reps[2] = reps[1];
    reps[1] = reps[0];
    reps[0] = selected;
  }
}

/** Little-endian u32 load; OOB lanes read as 0 via `??`. */
function loadU32(data: Uint8Array, i: number): number {
  return (
    ((data[i] ?? 0) |
      ((data[i + 1] ?? 0) << 8) |
      ((data[i + 2] ?? 0) << 16) |
      ((data[i + 3] ?? 0) << 24)) >>>
    0
  );
}

function hash4(data: Uint8Array, pos: number, hashBits: number, hashMask: number): number {
  return (Math.imul(loadU32(data, pos), 2654435761) >>> (32 - hashBits)) & hashMask;
}

/** 8-byte needle hash for the secondary long-match table. */
function hash8(data: Uint8Array, pos: number, hashBits: number, hashMask: number): number {
  const a = loadU32(data, pos);
  const b = loadU32(data, pos + 4);
  return (Math.imul(a ^ Math.imul(b, 0x9e3779b1), 2654435761) >>> (32 - hashBits)) & hashMask;
}

/**
 * Match length from `pos`/`candidate`, starting at `from` (caller may pass 4
 * after an initial u32 needle equality check).
 */
function matchLengthAt(
  data: Uint8Array,
  pos: number,
  candidate: number,
  maxLen: number,
  from = 0,
): number {
  let len = from;
  while (len + 4 <= maxLen) {
    const x = loadU32(data, pos + len) ^ loadU32(data, candidate + len);
    if (x !== 0) {
      // Little-endian: first mismatched byte is the lowest differing lane.
      if ((x & 0xff) === 0) {
        len++;
        if ((x & 0xff00) === 0) {
          len++;
          if ((x & 0xff0000) === 0) len++;
        }
      }
      return len;
    }
    len += 4;
  }
  while (len < maxLen && (data[pos + len] ?? 0) === (data[candidate + len] ?? 0)) {
    len++;
  }
  return len;
}

type FoundMatch = {
  pos: number;
  distance: number;
  length: number;
  score: number;
};

type HashState = {
  heads: Int32Array;
  chain: Int32Array | null;
  /** `chain.length - 1`; below the window for inputs smaller than it. */
  chainMask: number;
  /**
   * Same candidates as {@link chain}, laid out as a per-bucket ring so a walk
   * reads forward through two cache lines instead of chasing pointers across
   * a multi-megabyte array. Null when the chain form is in use.
   */
  rows: Int32Array | null;
  /** Next write slot per bucket. Wrapping at 256 is exact: `row` divides it. */
  rowHead: Uint8Array | null;
  /**
   * Binary tree: for each slot `i`, `bt[2i]` is the "smaller" child and
   * `bt[2i+1]` the "larger" child (content-ordered), or −1. Null when off.
   */
  bt: Int32Array | null;
  nextHash: number;
  windowSize: number;
  hashBits: number;
  hashMask: number;
  rowBits: number;
  row: number;
  rowMask: number;
  probeReps: boolean;
  /** Secondary 8-byte hash heads; null when long-hash is off. */
  heads8: Int32Array | null;
  /** Linked prev positions for the 8-byte hash; null when long-hash is off. */
  chain8: Int32Array | null;
  longHashBits: number;
  longHashMask: number;
  longChainLimit: number;
  /** Primary needle length (4 or 8). */
  primaryHashBytes: 4 | 8;
  /** Skip secondary long-hash when primary already found length ≥ 8. */
  longHashOnlyIfShort: boolean;
  /** Max tree predictions per search (from {@link MatcherConfig.chainLimit}). */
  btLimit: number;
};

/**
 * The chain only ever indexes positions that exist, so size it to the input
 * rather than the window — a 10 KB payload must not allocate a 1 MiB chain.
 */
function chainSlots(inputLength: number, windowSize: number): number {
  let slots = 4096;
  while (slots < inputLength && slots < windowSize) slots <<= 1;
  return slots;
}

function createHashState(useChain: boolean, inputLength: number, config: MatcherConfig): HashState {
  const hashBits = config.hashBits;
  const hashSize = 1 << hashBits;
  const rowBits = config.rowBits;
  const row = 1 << rowBits;
  const heads = new Int32Array(hashSize);
  heads.fill(-1);
  const slots = chainSlots(inputLength, config.windowSize);
  const useBt = config.binaryTree && useChain;
  // The ring is a fixed `hashSize * row` regardless of input, so it only pays
  // for itself once the linked form would have allocated as much anyway — at
  // which point it holds the same candidates for the same memory with far
  // better locality. Below that a small input keeps the small allocation.
  // Binary tree owns the primary structure when enabled (no chain/rows).
  const useRows = useChain && !useBt && slots >= hashSize << rowBits;
  const longHashBits = config.longHashBits;
  const useLong = longHashBits > 0;
  const longHashSize = useLong ? 1 << longHashBits : 0;
  const heads8 = useLong ? new Int32Array(longHashSize).fill(-1) : null;
  // Long chain reuses the same slot count as the primary chain so both index
  // the same position space; only allocated when long-hash is on.
  const chain8 = useLong && useChain ? new Int32Array(slots).fill(-1) : null;
  return {
    heads,
    chain: useChain && !useRows && !useBt ? new Int32Array(slots).fill(-1) : null,
    chainMask: slots - 1,
    rows: useRows ? new Int32Array(hashSize << rowBits).fill(-1) : null,
    rowHead: useRows ? new Uint8Array(hashSize) : null,
    bt: useBt ? new Int32Array(slots * 2).fill(-1) : null,
    nextHash: 0,
    windowSize: config.windowSize,
    hashBits,
    hashMask: hashSize - 1,
    rowBits,
    row,
    rowMask: row - 1,
    probeReps: config.probeReps,
    heads8,
    chain8,
    longHashBits,
    longHashMask: longHashSize > 0 ? longHashSize - 1 : 0,
    longChainLimit: config.longChainLimit,
    primaryHashBytes: config.primaryHashBytes,
    longHashOnlyIfShort: config.longHashOnlyIfShort,
    btLimit: config.chainLimit,
  };
}

/** Primary-table hash: 4-byte (shipped) or 8-byte. */
function primaryHash(data: Uint8Array, pos: number, state: HashState): number {
  if (state.primaryHashBytes === 8) {
    return hash8(data, pos, state.hashBits, state.hashMask);
  }
  return hash4(data, pos, state.hashBits, state.hashMask);
}

/**
 * Insert `pos` as the new root of its hash's binary tree (zstd-style).
 * Splits the previous tree into "smaller" / "larger" content-ordered subtrees.
 *
 * @returns How far to advance the insert cursor (always ≥ 1). On long matches
 * zstd skips intermediate positions that would re-insert the same repetitive
 * run — that is the main BT throughput lever we were missing.
 */
function btInsert(data: Uint8Array, pos: number, state: HashState): number {
  const bt = state.bt;
  if (bt === null) return 1;
  const h = primaryHash(data, pos, state);
  let matchIndex = state.heads[h] ?? -1;
  state.heads[h] = pos;
  const mask = state.chainMask;
  const ipos = pos & mask;
  let smallerSlot = ipos * 2;
  let largerSlot = ipos * 2 + 1;
  let commonSmaller = 0;
  let commonLarger = 0;
  const windowStart = Math.max(0, pos - state.windowSize);
  const maxCmp = Math.min(data.length - pos, 1024);
  const limit = state.btLimit;
  // Farthest position covered by any match seen while inserting — used for
  // skip-ahead (zstd: matchEndIdx - (curr + 8)).
  let matchEndIdx = pos + 8 + 1;
  let bestLength = 8;

  for (let attempts = 0; attempts < limit; attempts++) {
    if (matchIndex < windowStart || matchIndex >= pos) {
      bt[smallerSlot] = -1;
      bt[largerSlot] = -1;
      break;
    }
    const mSlot = (matchIndex & mask) * 2;
    let mlen = commonSmaller < commonLarger ? commonSmaller : commonLarger;
    const maxLen = Math.min(maxCmp, data.length - matchIndex);
    if (mlen > maxLen) mlen = maxLen;
    mlen = matchLengthAt(data, pos, matchIndex, maxLen, mlen);
    if (mlen > bestLength) {
      bestLength = mlen;
      const end = matchIndex + mlen;
      if (end > matchEndIdx) matchEndIdx = end;
    }
    if (mlen >= maxLen) {
      // Equal through the compare budget — stop (tree consistency).
      bt[smallerSlot] = -1;
      bt[largerSlot] = -1;
      break;
    }
    const mb = data[matchIndex + mlen] ?? 0;
    const pb = data[pos + mlen] ?? 0;
    if (mb < pb) {
      // Candidate content is smaller → it sits on our smaller side; walk
      // its larger child next.
      bt[smallerSlot] = matchIndex;
      smallerSlot = mSlot + 1;
      commonSmaller = mlen;
      matchIndex = bt[mSlot + 1] ?? -1;
    } else {
      bt[largerSlot] = matchIndex;
      largerSlot = mSlot;
      commonLarger = mlen;
      matchIndex = bt[mSlot] ?? -1;
    }
  }
  bt[smallerSlot] = -1;
  bt[largerSlot] = -1;

  // zstd: skip positions inside a long match so repetitive runs don't rebuild
  // the tree at every byte. Cap the skip so we still index enough structure.
  let forward = matchEndIdx - (pos + 8);
  if (forward < 1) forward = 1;
  if (bestLength > 384) {
    const extra = bestLength - 384;
    const capped = extra > 192 ? 192 : extra;
    if (capped > forward) forward = capped;
  }
  return forward;
}

/**
 * Search the binary tree rooted at `heads[hash(pos)]` for the best match.
 * Does not modify the tree (caller inserts via {@link btInsert} / insertThrough).
 */
function btFindBest(
  data: Uint8Array,
  pos: number,
  blockEnd: number,
  state: HashState,
  reps: RepOffsets,
  preferRep: boolean,
  litBits16: number,
  offsetCost16: Int32Array,
  scratch: FoundMatch,
  scoreFloor: number,
): FoundMatch | null {
  const bt = state.bt;
  if (bt === null) return null;
  const stats = activeMatchStats;
  const maxMatch = blockEnd - pos;
  if (maxMatch < MIN_MATCH) return null;
  const windowStart = Math.max(0, pos - state.windowSize);
  const h = primaryHash(data, pos, state);
  let matchIndex = state.heads[h] ?? -1;
  let best: FoundMatch | null = null;
  const hasFloor = scoreFloor > 0;
  const mask = state.chainMask;
  let commonSmaller = 0;
  let commonLarger = 0;
  const limit = state.btLimit;
  const minPrimary = state.primaryHashBytes;

  for (let attempts = 0; attempts < limit; attempts++) {
    if (matchIndex < windowStart || matchIndex >= pos) break;
    if (stats !== null) stats.probes++;
    let mlen = commonSmaller < commonLarger ? commonSmaller : commonLarger;
    if (mlen > maxMatch) mlen = maxMatch;
    mlen = matchLengthAt(data, pos, matchIndex, maxMatch, mlen);
    if (stats !== null && mlen >= minPrimary) {
      stats.needleHits++;
      stats.extends++;
    }
    if (mlen >= MIN_MATCH) {
      const dist = pos - matchIndex;
      const score = matchGain16(mlen, dist, litBits16, offsetCost16, reps, preferRep);
      const beatsFloor = !hasFloor || score > scoreFloor;
      if (
        score > 0 &&
        beatsFloor &&
        (best === null || score > best.score || (score === best.score && mlen > best.length))
      ) {
        scratch.pos = pos;
        scratch.distance = dist;
        scratch.length = mlen;
        scratch.score = score;
        best = scratch;
        if (stats !== null) stats.improvements++;
        if (mlen >= maxMatch) break;
      }
    }
    if (mlen >= maxMatch) break;
    const mb = data[matchIndex + mlen] ?? 0;
    const pb = data[pos + mlen] ?? 0;
    const mSlot = (matchIndex & mask) * 2;
    if (mb < pb) {
      commonSmaller = mlen;
      matchIndex = bt[mSlot + 1] ?? -1;
    } else {
      commonLarger = mlen;
      matchIndex = bt[mSlot] ?? -1;
    }
  }
  return best;
}

function insertThrough(data: Uint8Array, pos: number, state: HashState): void {
  // Primary-8 needs 8 safe bytes; primary-4 needs MIN_MATCH.
  const primaryNeed = state.primaryHashBytes;
  const limit = Math.min(pos, data.length - primaryNeed);
  const longLimit = state.heads8 !== null ? Math.min(pos, data.length - 8) : -1;
  const useBt = state.bt !== null;
  while (state.nextHash <= limit) {
    const p = state.nextHash;
    let step = 1;
    if (useBt) {
      // May skip intermediate positions on long matches (BT throughput).
      step = btInsert(data, p, state);
    } else {
      const h = primaryHash(data, p, state);
      const prev = state.heads[h] ?? -1;
      if (prev !== p) {
        if (state.chain !== null) {
          state.chain[p & state.chainMask] = prev;
        } else if (state.rows !== null && state.rowHead !== null) {
          const c = state.rowHead[h] ?? 0;
          state.rows[(h << state.rowBits) + (c & state.rowMask)] = p;
          state.rowHead[h] = c + 1;
        }
        state.heads[h] = p;
      }
    }
    // Secondary 8-byte hash: only positions with a full 8-byte needle.
    // When BT skip-ahead fires, still index the head position for long-hash
    // (skipped interiors are re-found via the 8-byte chain when searched).
    if (state.heads8 !== null && p <= longLimit) {
      const h8 = hash8(data, p, state.longHashBits, state.longHashMask);
      const prev8 = state.heads8[h8] ?? -1;
      if (prev8 !== p && state.chain8 !== null) {
        state.chain8[p & state.chainMask] = prev8;
        state.heads8[h8] = p;
      } else if (prev8 !== p) {
        state.heads8[h8] = p;
      }
    }
    state.nextHash = p + step;
    // Do not jump past the caller's requested fill frontier.
    if (state.nextHash > limit + 1) state.nextHash = limit + 1;
  }
}

/**
 * Bits per literal byte this block is expected to cost, in 1/16-bit units.
 *
 * Order-0 entropy of the block's bytes, which is what a Huffman literals
 * section approaches.
 */
function estimateLiteralBits16(data: Uint8Array, start: number, end: number): number {
  const n = end - start;
  if (n <= 0) return RAW_LITERAL_BITS16;
  const freq = new Uint32Array(256);
  let maxSymbol = 0;
  for (let i = start; i < end; i++) {
    const b = data[i] ?? 0;
    freq[b] = (freq[b] ?? 0) + 1;
    if (b > maxSymbol) maxSymbol = b;
  }
  let bits = 0;
  for (let s = 0; s <= maxSymbol; s++) {
    const f = freq[s] ?? 0;
    if (f > 0) bits += f * Math.log2(n / f);
  }
  const avg16 = Math.round((bits / n) * 16) + LITERAL_COST_MARGIN16;
  if (avg16 < 16) return 16;
  return avg16 > RAW_LITERAL_BITS16 ? RAW_LITERAL_BITS16 : avg16;
}

/**
 * Bits saved by covering `length` bytes with a match instead of emitting them
 * as literals, in 1/16-bit units. A negative result means the sequence costs
 * more than the bytes it replaces, so the match is not worth taking.
 */
function matchGain16(
  length: number,
  distance: number,
  litBits16: number,
  offsetCost16: Int32Array,
  reps: RepOffsets,
  preferRep: boolean,
): number {
  // Explicit offsets pay log2(offset_value) extra bits; repeat codes are 1..3
  // and pay next to nothing.
  let offsetBits = 31 - Math.clz32(distance + 3);
  if (preferRep) {
    if (distance === reps[0]) offsetBits = 1;
    else if (distance === reps[1] || distance === reps[2]) offsetBits = 2;
  }
  // Match lengths past 34 carry extra bits on top of the ML code.
  const lengthBits = length <= 34 ? 0 : 31 - Math.clz32(length);
  return (
    length * litBits16 -
    SEQ_OVERHEAD_BITS16 -
    ((offsetBits + lengthBits) << 4) -
    (offsetCost16[offsetBits] ?? 0)
  );
}

function bestMatchAt(
  data: Uint8Array,
  pos: number,
  blockEnd: number,
  state: HashState,
  chainLimit: number,
  patience: number,
  nullPatience: number,
  reps: RepOffsets,
  preferRep: boolean,
  litBits16: number,
  offsetCost16: Int32Array,
  minLenBase: Int32Array,
  scratch: FoundMatch,
  /** When capturing, whether this search is the primary or a lazy probe. */
  lazy: boolean,
  /**
   * Minimum score a match must beat to be useful. Lazy look-ahead passes the
   * primary's score (plus the deferred-literal bias) so the walk can use a
   * high minLen bar and the short post-hit patience budget from probe 0,
   * instead of nullPatience as if it had found nothing. Primary searches
   * pass 0.
   */
  scoreFloor: number,
): FoundMatch | null {
  const stats = activeMatchStats;
  if (stats !== null) {
    stats.searches++;
    if (lazy) stats.lazySearches++;
    else stats.primarySearches++;
  }
  const maxMatch = blockEnd - pos;
  if (maxMatch < MIN_MATCH) return null;
  const windowStart = Math.max(0, pos - state.windowSize);
  const hasFloor = scoreFloor > 0;
  const primaryBytes = state.primaryHashBytes;
  // Primary-8 cannot start a match with fewer than 8 bytes available.
  if (primaryBytes === 8 && maxMatch < 8) return null;
  const needle = loadU32(data, pos);
  const needle8b = primaryBytes === 8 ? loadU32(data, pos + 4) : 0;
  let best: FoundMatch | null = null;

  // Binary-tree finder: content-ordered walk finds long matches the recency
  // chain misses. Falls through to long-hash after.
  if (state.bt !== null) {
    best = btFindBest(
      data,
      pos,
      blockEnd,
      state,
      reps,
      preferRep,
      litBits16,
      offsetCost16,
      scratch,
      scoreFloor,
    );
  }

  // Chain / row walk when not using the binary tree.
  const h = primaryHash(data, pos, state);
  let candidate = state.bt !== null ? -1 : (state.heads[h] ?? -1);
  let depth = 0;
  let sinceImprove = 0;
  // A chain walks strictly outward, so a repeat offset is only still reachable
  // while the current distance has not passed it.
  const repReach = preferRep ? Math.max(reps[0], reps[1], reps[2]) : 0;
  const rows = state.rows;
  const rowBase = h << state.rowBits;
  // Most-recent slot; the walk steps backwards from here, which is the same
  // order the linked form produces.
  const rowTop = (state.rowHead?.[h] ?? 0) - 1;
  // `minLen` depends only on the offset bucket and the bar to clear, and both
  // move rarely along a walk — the bucket is log2 of a growing distance and
  // the bar only changes when the incumbent improves. Memoize so the divide
  // is amortized across the run of probes that share them.
  let memoOb = -1;
  let memoBar = -1;
  let memoMinLen = 0;
  let memoByte = -1;

  // Exit reason for the stats path. Production ignores it.
  // 0 none / 1 patience / 2 nullPatience / 3 chainLimit / 4 minLen /
  // 5 maxMatch / 6 noCandidate
  let exit = 0;

  // Explicit rep-offset probes. The hash chain only surfaces a rep when the
  // 4-byte hash collides; many valid rep matches are otherwise missed.
  if (state.probeReps && preferRep) {
    for (let ri = 0; ri < 3; ri++) {
      const dist = reps[ri] ?? 0;
      if (dist <= 0 || dist > pos - windowStart) continue;
      const repCand = pos - dist;
      if (loadU32(data, repCand) !== needle) continue;
      if (stats !== null) {
        stats.probes++;
        stats.needleHits++;
        stats.extends++;
      }
      const length = matchLengthAt(data, pos, repCand, maxMatch, 4);
      if (length < MIN_MATCH) continue;
      const score = matchGain16(length, dist, litBits16, offsetCost16, reps, preferRep);
      const beatsFloor = !hasFloor || score > scoreFloor;
      if (
        score > 0 &&
        beatsFloor &&
        (best === null || score > best.score || (score === best.score && length > best.length))
      ) {
        scratch.pos = pos;
        scratch.distance = dist;
        scratch.length = length;
        scratch.score = score;
        best = scratch;
        if (stats !== null) stats.improvements++;
      }
    }
  }

  while (candidate >= windowStart && candidate < pos && depth < chainLimit) {
    if (stats !== null) stats.probes++;
    const dist = pos - candidate;
    let ob = 31 - Math.clz32(dist + 3);
    if (preferRep) {
      if (dist === reps[0]) ob = 1;
      else if (dist === reps[1] || dist === reps[2]) ob = 2;
    }
    // Shortest match that could possibly clear the bar at this distance. The
    // sequence overhead and the offset charge have to be paid back at
    // `litBits16` per byte, so the requirement climbs steeply as the walk
    // moves outward — past a few KiB it is tens of bytes. Exact: dropping
    // the length bits only lowers the requirement, so no match that could
    // win is ever rejected.
    //
    // With a score floor (lazy look-ahead), the bar starts high even before
    // a local best exists — same formula as an incumbent of that score.
    const bar = best !== null ? best.score : hasFloor ? scoreFloor : 1;
    if (ob !== memoOb || bar !== memoBar) {
      memoOb = ob;
      memoBar = bar;
      // Nothing found yet is the common case — 48% of calls end that way,
      // and they are the ones that walk furthest — so that column is a
      // per-block table and costs no divide at all.
      memoMinLen =
        bar === 1
          ? (minLenBase[ob] ?? 1)
          : Math.ceil(
              (bar + SEQ_OVERHEAD_BITS16 + (ob << 4) + (offsetCost16[ob] ?? 0)) / litBits16,
            );
      memoByte = memoMinLen <= maxMatch ? (data[pos + memoMinLen - 1] ?? -1) : -1;
    }
    if (memoMinLen > maxMatch) {
      // Not even the longest match left can pay here. The chain only gets
      // farther, so once the repeat offsets are also out of reach nothing
      // deeper can pay either.
      if (dist > repReach) {
        exit = 4;
        break;
      }
    } else if (
      // One load decides it: a match reaching `minLen` must match every
      // byte below it, so a mismatch at that byte caps the length short of
      // the bar and the extend is pure waste.
      data[candidate + memoMinLen - 1] === memoByte &&
      loadU32(data, candidate) === needle &&
      (primaryBytes === 4 || loadU32(data, candidate + 4) === needle8b)
    ) {
      if (stats !== null) stats.needleHits++;
      // First primaryBytes already match; extend from there.
      if (stats !== null) stats.extends++;
      const length = matchLengthAt(data, pos, candidate, maxMatch, primaryBytes);
      if (length >= MIN_MATCH) {
        const score = matchGain16(length, dist, litBits16, offsetCost16, reps, preferRep);
        // A match that does not pay for its own sequence loses to leaving
        // the bytes in the literal run. With a floor, it must also beat
        // that score (strict) — same test the lazy loop applied after
        // the search returned.
        const beatsFloor = !hasFloor || score > scoreFloor;
        if (
          score > 0 &&
          beatsFloor &&
          (best === null || score > best.score || (score === best.score && length > best.length))
        ) {
          scratch.pos = pos;
          scratch.distance = dist;
          scratch.length = length;
          scratch.score = score;
          best = scratch;
          sinceImprove = 0;
          if (stats !== null) stats.improvements++;
          if (length >= maxMatch) {
            exit = 5;
            break;
          }
        }
      }
    }
    // Give up once the walk stops paying, on whichever budget applies. The
    // two are deliberately far apart: probes after a match is found are
    // nearly worthless, probes before one are where the late finds that
    // carry real bytes turn up.
    //
    // A score floor means we already have a usable match outside this call
    // (lazy), so the short budget applies even before a local best exists.
    const huntingFirst = best === null && !hasFloor;
    if (++sinceImprove >= (huntingFirst ? nullPatience : patience)) {
      exit = huntingFirst ? 2 : 1;
      break;
    }
    let next: number;
    if (rows !== null) {
      if (depth + 1 >= state.row) {
        exit = 3;
        break;
      }
      next = rows[rowBase + ((rowTop - depth - 1) & state.rowMask)] ?? -1;
    } else if (state.chain !== null) {
      next = state.chain[candidate & state.chainMask] ?? -1;
    } else {
      exit = 6;
      break;
    }
    // Both forms hand back strictly older positions; anything else means the
    // ring has wrapped past its useful entries or the chain slot was reused.
    if (next >= candidate) {
      exit = 6;
      break;
    }
    candidate = next;
    depth++;
  }
  // Fell out of the while without an explicit break: chainLimit or no head.
  if (exit === 0) {
    if (depth >= chainLimit) exit = 3;
    else exit = 6;
  }

  // Secondary 8-byte hash runs *after* the primary chain so near/rep matches
  // keep first claim; long-hash only wins when its score strictly beats them.
  // Adaptive: optional skip when primary already found a long match.
  const heads8 = state.heads8;
  if (
    heads8 !== null &&
    maxMatch >= 8 &&
    state.longChainLimit > 0 &&
    (!state.longHashOnlyIfShort || best === null || best.length < 8)
  ) {
    const needleHi = primaryBytes === 8 ? needle8b : loadU32(data, pos + 4);
    let cand8 = heads8[hash8(data, pos, state.longHashBits, state.longHashMask)] ?? -1;
    let depth8 = 0;
    while (cand8 >= windowStart && cand8 < pos && depth8 < state.longChainLimit) {
      if (stats !== null) stats.probes++;
      if (loadU32(data, cand8) === needle && loadU32(data, cand8 + 4) === needleHi) {
        if (stats !== null) {
          stats.needleHits++;
          stats.extends++;
        }
        const dist = pos - cand8;
        const length = matchLengthAt(data, pos, cand8, maxMatch, 8);
        if (length >= 8) {
          const score = matchGain16(length, dist, litBits16, offsetCost16, reps, preferRep);
          const beatsFloor = !hasFloor || score > scoreFloor;
          if (
            score > 0 &&
            beatsFloor &&
            (best === null || score > best.score || (score === best.score && length > best.length))
          ) {
            scratch.pos = pos;
            scratch.distance = dist;
            scratch.length = length;
            scratch.score = score;
            best = scratch;
            if (stats !== null) stats.improvements++;
            if (length >= maxMatch) break;
          }
        }
      }
      const next8 = state.chain8 !== null ? (state.chain8[cand8 & state.chainMask] ?? -1) : -1;
      if (next8 >= cand8) break;
      cand8 = next8;
      depth8++;
    }
  }

  if (stats !== null) {
    if (best !== null) stats.hits++;
    switch (exit) {
      case 1:
        stats.exitPatience++;
        break;
      case 2:
        stats.exitNullPatience++;
        break;
      case 3:
        stats.exitChainLimit++;
        break;
      case 4:
        stats.exitMinLen++;
        break;
      case 5:
        stats.exitMaxMatch++;
        break;
      default:
        stats.exitNoCandidate++;
        break;
    }
  }
  return best;
}

type PlanResult = {
  literals: Uint8Array;
  sequences: Array<Sequence>;
  reps: RepOffsets;
};

/**
 * Absolute sequence cost in 1/16-bit units (no literal credit). Used by the
 * optimal parser's DP; greedy still uses {@link matchGain16}.
 */
function matchAbsCost16(length: number, distance: number, offsetCost16: Int32Array): number {
  const ob = 31 - Math.clz32(distance + 3);
  const lengthBits = length <= 34 ? 0 : 31 - Math.clz32(length);
  return SEQ_OVERHEAD_BITS16 + ((ob + lengthBits) << 4) + (offsetCost16[ob] ?? 0);
}

/**
 * Forward optimal parse: min estimated bit-cost path of literals vs matches.
 *
 * Phase 1 gathers the best match at every position (deep chain + long-hash).
 * Phase 2 DP chooses, for each byte, literal vs a (possibly shortened) match.
 * Phase 3 reconstructs sequences and applies real rep-offset coding.
 *
 * Rep codes are not modeled inside the DP (state would explode); they are still
 * emitted correctly on the reconstructed path. That under-prices near repeats
 * slightly but still finds far better global structure than greedy+lazy.
 */
function planBlockOptimal(
  data: Uint8Array,
  blockStart: number,
  blockEnd: number,
  state: HashState,
  config: MatcherConfig,
  repsIn: RepOffsets,
): PlanResult {
  const n = blockEnd - blockStart;
  const litBits16 = config.huffmanLiterals
    ? estimateLiteralBits16(data, blockStart, blockEnd)
    : RAW_LITERAL_BITS16;
  const offsetCost16 = offsetCost16Table(config.offsetSurcharge16, config.offsetSurchargeFrom);
  const minLenBase = new Int32Array(32);
  for (let b = 0; b < 32; b++) {
    minLenBase[b] = Math.ceil(
      (1 + SEQ_OVERHEAD_BITS16 + (b << 4) + (offsetCost16[b] ?? 0)) / litBits16,
    );
  }
  const bestLen = new Int32Array(n);
  const bestDist = new Int32Array(n);
  const scratch: FoundMatch = { pos: 0, distance: 0, length: 0, score: 0 };
  // Prefer-rep scoring during gather uses the block-entry rep set only — a
  // stable bias toward recent distances without path-dependent state.
  const repsGather: RepOffsets = [repsIn[0], repsIn[1], repsIn[2]];

  for (let i = 0; i < n; i++) {
    const pos = blockStart + i;
    // Skip the full chain walk when a prior match already extends here with
    // a usable remainder — critical on long runs (zeros / repeats).
    if (pos + MIN_MATCH <= blockEnd && (bestLen[i] ?? 0) < MIN_MATCH) {
      const m = bestMatchAt(
        data,
        pos,
        blockEnd,
        state,
        config.chainLimit,
        config.patience,
        config.nullPatience,
        repsGather,
        config.preferRepOffsets,
        litBits16,
        offsetCost16,
        minLenBase,
        scratch,
        false,
        0,
      );
      if (m !== null && m.length >= MIN_MATCH) {
        bestLen[i] = m.length;
        bestDist[i] = m.distance;
        // A match of length L at i is also a match of length L−j at i+j.
        for (let j = 1; j < m.length && i + j < n; j++) {
          const rem = m.length - j;
          if (rem > (bestLen[i + j] ?? 0)) {
            bestLen[i + j] = rem;
            bestDist[i + j] = m.distance;
          }
        }
      }
    }
    insertThrough(data, pos, state);
  }

  const INF = 1e18;
  const price = new Float64Array(n + 1);
  const back = new Int32Array(n + 1);
  const choseLen = new Int32Array(n + 1);
  const choseDist = new Int32Array(n + 1);
  price[0] = 0;
  for (let i = 1; i <= n; i++) price[i] = INF;
  back[0] = -1;

  for (let i = 0; i < n; i++) {
    const base = price[i] ?? INF;
    if (!(base < INF)) continue;
    // One-byte literal.
    const lp = base + litBits16;
    const nextLit = price[i + 1] ?? INF;
    if (lp < nextLit) {
      price[i + 1] = lp;
      back[i + 1] = i;
      choseLen[i + 1] = 0;
      choseDist[i + 1] = 0;
    }
    // Best match plus a bounded set of shorter prefixes. Full enumeration
    // from L down to 4 is O(L) per position and explodes on long runs
    // (zeros / repeats); a geometric ladder keeps the DP O(n).
    let L = bestLen[i] ?? 0;
    const d = bestDist[i] ?? 0;
    if (L > n - i) L = n - i;
    if (L >= MIN_MATCH && d > 0) {
      let len = L;
      let tries = 0;
      while (len >= MIN_MATCH && tries < 20) {
        const end = i + len;
        const mc = matchAbsCost16(len, d, offsetCost16);
        const np = base + mc;
        const cur = price[end] ?? INF;
        if (np < cur) {
          price[end] = np;
          back[end] = i;
          choseLen[end] = len;
          choseDist[end] = d;
        }
        tries++;
        if (len <= 12) len--;
        else if (len <= 64) len -= 4;
        else len = Math.max(MIN_MATCH, (len * 3) >> 2);
      }
    }
  }

  // If DP failed open (should not), fall back to all-literals path.
  if (!((price[n] ?? INF) < INF)) {
    const litBuf = data.subarray(blockStart, blockEnd);
    return {
      literals: litBuf,
      sequences: [],
      reps: [repsIn[0], repsIn[1], repsIn[2]],
    };
  }

  // Walk back: list of (start, end, dist) with dist 0 = pure literals.
  const segs: Array<{ start: number; end: number; dist: number }> = [];
  let at = n;
  while (at > 0) {
    const p = back[at] ?? at - 1;
    const ml = choseLen[at] ?? 0;
    if (ml > 0) {
      segs.push({ start: p, end: at, dist: choseDist[at] ?? 0 });
      at = p;
    } else {
      segs.push({ start: p, end: at, dist: 0 });
      at = p;
    }
  }
  segs.reverse();

  // Emit sequences: coalesce literal runs, then a match.
  const sequences: Array<Sequence> = [];
  const litBuf = new Uint8Array(n);
  let litOut = 0;
  const reps: RepOffsets = [repsIn[0], repsIn[1], repsIn[2]];
  let litRun = 0;
  let litRunStart = 0;

  const flushLitsTo = (until: number): number => {
    const len = until - litRunStart;
    if (len > 0) {
      litBuf.set(data.subarray(blockStart + litRunStart, blockStart + until), litOut);
      litOut += len;
    }
    litRun = 0;
    return len > 0 ? len : 0;
  };

  for (const seg of segs) {
    if (seg.dist === 0) {
      if (litRun === 0) litRunStart = seg.start;
      litRun += seg.end - seg.start;
      continue;
    }
    // Match: preceding coalesced literals are this sequence's litLen.
    if (litRun === 0) litRunStart = seg.start;
    const litLen = flushLitsTo(seg.start);
    const matchLength = seg.end - seg.start;
    const offsetValue = encodeOffsetValue(seg.dist, litLen, reps);
    sequences.push({
      literalsLength: litLen,
      offset: offsetValue,
      matchLength,
    });
    updateRepOffsets(reps, offsetValue, litLen);
    litRunStart = seg.end;
  }
  // Trailing literals after the last match (or the whole block if no matches).
  if (litRun > 0) {
    flushLitsTo(n);
  } else if (sequences.length === 0 && n > 0) {
    litBuf.set(data.subarray(blockStart, blockEnd), 0);
    litOut = n;
  }

  return {
    literals: litOut < litBuf.length ? litBuf.subarray(0, litOut) : litBuf,
    sequences,
    reps,
  };
}

function planBlock(
  data: Uint8Array,
  blockStart: number,
  blockEnd: number,
  state: HashState,
  config: MatcherConfig,
  repsIn: RepOffsets,
): PlanResult {
  if (config.optimalParse) {
    return planBlockOptimal(data, blockStart, blockEnd, state, config, repsIn);
  }
  const sequences: Array<Sequence> = [];
  const litBuf = new Uint8Array(blockEnd - blockStart);
  let litOut = 0;
  let anchor = blockStart;
  let pos = blockStart;
  const litBits16 = config.huffmanLiterals
    ? estimateLiteralBits16(data, blockStart, blockEnd)
    : RAW_LITERAL_BITS16;
  // Deferring a match by one position leaves that byte in the literal run, so
  // a later match has to make up the difference to be worth the wait.
  const lazyBias16 = litBits16;
  const offsetCost16 = offsetCost16Table(config.offsetSurcharge16, config.offsetSurchargeFrom);
  // Shortest match that can pay for its own sequence, per offset bucket, for a
  // matcher that has not found anything yet. Depends only on the block's
  // literal price and the offset cost curve, so it is built once here rather
  // than divided out per probe — see the filter in `bestMatchAt`.
  const minLenBase = new Int32Array(32);
  for (let b = 0; b < 32; b++) {
    minLenBase[b] = Math.ceil(
      (1 + SEQ_OVERHEAD_BITS16 + (b << 4) + (offsetCost16[b] ?? 0)) / litBits16,
    );
  }
  // Own copy so we can mutate in place without aliasing the caller's triple.
  const reps: RepOffsets = [repsIn[0], repsIn[1], repsIn[2]];
  // Scratch for the primary probe; lazy look-ahead uses a second slot so a
  // later match can beat the current one without clobbering it mid-compare.
  const scratchA: FoundMatch = { pos: 0, distance: 0, length: 0, score: 0 };
  const scratchB: FoundMatch = { pos: 0, distance: 0, length: 0, score: 0 };
  // When we keep a match across the lazy loop we must snapshot it — scratch
  // slots are reused on the next probe.
  let kept: FoundMatch | null = null;
  const keptSnap: FoundMatch = { pos: 0, distance: 0, length: 0, score: 0 };

  while (pos + MIN_MATCH <= blockEnd) {
    let match = bestMatchAt(
      data,
      pos,
      blockEnd,
      state,
      config.chainLimit,
      config.patience,
      config.nullPatience,
      reps,
      config.preferRepOffsets,
      litBits16,
      offsetCost16,
      minLenBase,
      scratchA,
      false,
      0,
    );
    insertThrough(data, pos, state);

    if (match && config.lazyDepth > 0) {
      keptSnap.pos = match.pos;
      keptSnap.distance = match.distance;
      keptSnap.length = match.length;
      keptSnap.score = match.score;
      kept = keptSnap;
      const lazyEnd = Math.min(pos + config.lazyDepth, blockEnd - MIN_MATCH);
      for (let probe = pos + 1; probe <= lazyEnd; probe++) {
        insertThrough(data, probe - 1, state);
        // Floor = score the lazy match must beat (primary + deferred lit
        // cost). Pushed into the walk so it does not burn nullPatience
        // hunting first finds that the outer check would discard.
        const floor = kept.score + (probe - pos) * lazyBias16;
        const later = bestMatchAt(
          data,
          probe,
          blockEnd,
          state,
          config.chainLimit,
          config.patience,
          config.nullPatience,
          reps,
          config.preferRepOffsets,
          litBits16,
          offsetCost16,
          minLenBase,
          scratchB,
          true,
          floor,
        );
        if (later) {
          keptSnap.pos = later.pos;
          keptSnap.distance = later.distance;
          keptSnap.length = later.length;
          keptSnap.score = later.score;
        }
      }
      match = kept;
    }

    if (!match || match.length < MIN_MATCH) {
      const shift = config.searchSkipShift;
      const skip = shift > 0 ? ((pos - anchor) >> shift) + 1 : 1;
      if (skip > 1) insertThrough(data, pos + skip - 1, state);
      pos += skip;
      continue;
    }

    const litLen = match.pos - anchor;
    if (litLen > 0) {
      litBuf.set(data.subarray(anchor, match.pos), litOut);
      litOut += litLen;
    }
    const offsetValue = encodeOffsetValue(match.distance, litLen, reps);
    sequences.push({
      literalsLength: litLen,
      offset: offsetValue,
      matchLength: match.length,
    });
    updateRepOffsets(reps, offsetValue, litLen);

    const matchEnd = match.pos + match.length;
    insertThrough(data, matchEnd - 1, state);
    anchor = matchEnd;
    pos = matchEnd;
  }

  if (anchor < blockEnd) {
    litBuf.set(data.subarray(anchor, blockEnd), litOut);
    litOut += blockEnd - anchor;
  }

  return {
    literals: litOut < litBuf.length ? litBuf.subarray(0, litOut) : litBuf,
    sequences,
    reps,
  };
}

function concat(parts: Array<Uint8Array>): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/**
 * Low half of XXH64 as the 4-byte content checksum, little-endian.
 *
 * One pass over the input — cheap relative to the match search, and it is
 * what takes corruption detection from structural checks alone to complete.
 */
function checksumTail(digest32: number): Uint8Array {
  const tail = new Uint8Array(4);
  tail[0] = digest32 & 0xff;
  tail[1] = (digest32 >>> 8) & 0xff;
  tail[2] = (digest32 >>> 16) & 0xff;
  tail[3] = (digest32 >>> 24) & 0xff;
  return tail;
}

function appendChecksum(chunks: Array<Uint8Array>, data: Uint8Array): void {
  const h = new Xxh64();
  h.update(data);
  chunks.push(checksumTail(h.digest32()));
}

/**
 * Frame header for a streaming producer: checksum on, no Frame_Content_Size,
 * explicit window descriptor. This is the shape `zstd` writing a pipe emits,
 * and the one {@link EncodeStream} writes — one-shot {@link encodeFrame} still
 * always writes FCS.
 */
export function writeStreamingFrameHeader(windowSize: number = WINDOW_SIZE): Uint8Array {
  const out = new Uint8Array(6);
  out[0] = 0x28;
  out[1] = 0xb5;
  out[2] = 0x2f;
  out[3] = 0xfd;
  // FCS flag 00, Single_Segment 0, Content_Checksum 1. Window_Descriptor follows.
  out[4] = CHECKSUM_FLAG;
  out[5] = windowDescriptorByte(windowSize);
  return out;
}

/**
 * Plan and pack one block. Always inserts through `end - 1` so the next
 * block's search sees this block's positions, matching {@link encodeFrame}.
 */
function writeBlock(
  data: Uint8Array,
  start: number,
  end: number,
  last: boolean,
  state: HashState,
  config: MatcherConfig,
  reps: RepOffsets,
  encodeLiterals: LiteralsEncoder,
  selectTables: SequenceTableSelector,
): { chunk: Uint8Array; reps: RepOffsets } {
  const plan = planBlock(data, start, end, state, config, reps);
  const rawSize = end - start;
  // Zero sequences is a valid compressed block: the literals section is
  // the whole block. That is the shape a Huffman-only block takes when no
  // match pays for its own sequence.
  const compressed = writeCompressedBlock(
    plan.literals,
    plan.sequences,
    last,
    encodeLiterals,
    selectTables,
  );
  if (compressed && compressed.length < 3 + rawSize) {
    insertThrough(data, end - 1, state);
    return { chunk: compressed, reps: plan.reps };
  }
  if (isAllSame(data, start, rawSize) && rawSize > 0) {
    insertThrough(data, end - 1, state);
    return { chunk: writeRLEBlock(data[start] ?? 0, rawSize, last), reps };
  }
  insertThrough(data, end - 1, state);
  return { chunk: writeRawBlock(data, start, rawSize, last), reps };
}

/**
 * Encode a full zstd frame with the given matcher config and literals encoder.
 * Assembles with exact-size concat (pre-sum lengths, one Uint8Array + .set).
 */
export function encodeFrame(
  data: Uint8Array,
  config: MatcherConfig,
  encodeLiterals: LiteralsEncoder,
  selectTables: SequenceTableSelector = usePredefinedTables,
): Uint8Array {
  const chunks: Array<Uint8Array> = [];
  chunks.push(writeFrameHeader(data.length, true, config.windowSize));

  if (data.length === 0) {
    chunks.push(writeRawBlock(data, 0, 0, true));
    // An empty frame still gets a digest — XXH64 of zero bytes is a defined
    // value, and a decoder trusting the flag reads four bytes whether or not
    // there was content to hash.
    appendChecksum(chunks, data);
    return concat(chunks);
  }

  const state = createHashState(config.chainLimit > 1, data.length, config);
  let reps: RepOffsets = [1, 4, 8];
  let offset = 0;
  while (offset < data.length) {
    const blockEnd = Math.min(offset + BLOCK_MAX, data.length);
    const last = blockEnd >= data.length;
    const out = writeBlock(
      data,
      offset,
      blockEnd,
      last,
      state,
      config,
      reps,
      encodeLiterals,
      selectTables,
    );
    chunks.push(out.chunk);
    reps = out.reps;
    offset = blockEnd;
  }

  appendChecksum(chunks, data);
  return concat(chunks);
}

export type EncodeHandler = (data: Uint8Array, final?: boolean) => unknown;

/**
 * Push-based streaming encoder. One instance is one frame.
 *
 * Emits a no-FCS, window-described, checksummed frame and a real sliding
 * window — never the whole payload. Blocks go out as soon as 128 KiB of
 * uncompressed input has arrived. Hash state is rebuilt from the retained
 * history when the buffer compactifies, so the chain is never remapped
 * across a shift (it is indexed by position).
 *
 * Not a public product name — Fast/Strong wrap this. Ultra has no stream.
 */
export class EncodeStream {
  ondata: EncodeHandler;
  private readonly config: MatcherConfig;
  private readonly encodeLiterals: LiteralsEncoder;
  private readonly selectTables: SequenceTableSelector;
  private readonly window: number;
  private readonly digest = new Xxh64();
  private buf: Uint8Array;
  private hist = 0;
  private end = 0;
  private reps: RepOffsets = [1, 4, 8];
  private state: HashState | null = null;
  private headerSent = false;
  private done = false;

  constructor(
    config: MatcherConfig,
    encodeLiterals: LiteralsEncoder,
    ondata?: EncodeHandler,
    selectTables: SequenceTableSelector = usePredefinedTables,
  ) {
    this.config = config;
    this.encodeLiterals = encodeLiterals;
    this.selectTables = selectTables;
    this.window = config.windowSize;
    // Same lazy-growth rule as streaming decode: do not reserve the window
    // before the data justifying it has arrived.
    this.buf = new Uint8Array(Math.min(this.window, BLOCK_MAX * 2));
    this.ondata = ondata ?? (() => {});
  }

  push(chunk: Uint8Array, final?: boolean): void {
    if (this.done) {
      throw new TypeError("EncodeStream.push called after final");
    }
    this.append(chunk);
    while (this.end - this.hist >= BLOCK_MAX) {
      this.emitBlock(BLOCK_MAX, false);
    }
    if (final) this.finish();
  }

  private finish(): void {
    this.done = true;
    if (!this.headerSent) {
      this.emit(writeStreamingFrameHeader(this.window));
      this.headerSent = true;
    }
    this.emitBlock(this.end - this.hist, true);
    this.emit(checksumTail(this.digest.digest32()), true);
    this.buf = new Uint8Array(0);
    this.state = null;
  }

  private emit(chunk: Uint8Array, final?: boolean): void {
    this.ondata(chunk, final);
  }

  private emitBlock(size: number, last: boolean): void {
    if (!this.headerSent) {
      this.emit(writeStreamingFrameHeader(this.window));
      this.headerSent = true;
    }
    if (size <= 0) {
      this.emit(writeRawBlock(this.buf, 0, 0, last));
      return;
    }
    const start = this.hist;
    const end = start + size;
    this.digest.update(this.buf.subarray(start, end));
    if (this.state === null) {
      // A single-block frame can size the chain to the payload, like one-shot.
      // A stream that will continue must use the window: a smaller chain aliases
      // `pos & chainMask` while the older slot is still in range.
      const slots = last ? end : this.window;
      this.state = createHashState(this.config.chainLimit > 1, slots, this.config);
    }
    // Matcher uses `data.length` as the logical end. Pass a view, not the
    // allocation, or the last 3 bytes of a flushed block hash leftover tail.
    const live = this.buf.subarray(0, this.end);
    const out = writeBlock(
      live,
      start,
      end,
      last,
      this.state,
      this.config,
      this.reps,
      this.encodeLiterals,
      this.selectTables,
    );
    this.reps = out.reps;
    this.emit(out.chunk);
    this.hist = end;
    this.compact();
  }

  private append(chunk: Uint8Array): void {
    let off = 0;
    while (off < chunk.length) {
      if (this.end === this.buf.length) {
        if (this.end - this.hist >= BLOCK_MAX) {
          this.emitBlock(BLOCK_MAX, false);
          continue;
        }
        const before = this.buf.length;
        this.grow(chunk.length - off);
        if (this.buf.length === before) {
          // At the window+8-block cap. Emit the partial pending block so
          // compact can reclaim history — never grow past the cap.
          if (this.end > this.hist) this.emitBlock(this.end - this.hist, false);
          else return;
        }
      }
      const n = Math.min(this.buf.length - this.end, chunk.length - off);
      this.buf.set(chunk.subarray(off, off + n), this.end);
      this.end += n;
      off += n;
    }
  }

  private grow(need: number): void {
    const max = this.window + BLOCK_MAX * 8;
    if (this.buf.length >= max) return;
    const want = this.end + need;
    let cap = this.buf.length > 0 ? this.buf.length : Math.min(this.window, BLOCK_MAX * 2);
    while (cap < want && cap < max) cap <<= 1;
    if (cap === this.buf.length) return;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.end));
    this.buf = next;
  }

  private compact(): void {
    if (this.hist <= this.window) return;
    const drop = this.hist - this.window;
    this.buf.copyWithin(0, drop, this.end);
    this.end -= drop;
    this.hist -= drop;
    // Rebuild rather than remap: the linked chain is indexed by
    // `pos & chainMask`, so subtracting `drop` from stored positions would
    // land them in the wrong slots.
    this.state = createHashState(this.config.chainLimit > 1, this.window, this.config);
    if (this.hist >= MIN_MATCH)
      insertThrough(this.buf.subarray(0, this.end), this.hist - 1, this.state);
  }
}
