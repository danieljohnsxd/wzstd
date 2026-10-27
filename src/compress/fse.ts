/**
 * FSE decode-table construction + reverse state-path selection for encoding.
 * Predefined distributions from RFC 8878 / zstd format.
 */

export type FseDecodeTable = {
  symbol: Uint16Array;
  numBits: Uint8Array;
  baseline: Int32Array;
  tableLog: number;
  length: number;
};

export const LITERALS_LENGTH_DEFAULT_DISTRIBUTION: ReadonlyArray<number> = [
  4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1,
  -1, -1, -1, -1,
];

export const MATCH_LENGTH_DEFAULT_DISTRIBUTION: ReadonlyArray<number> = [
  1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1,
];

export const OFFSET_CODE_DEFAULT_DISTRIBUTION: ReadonlyArray<number> = [
  1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1,
];

export const LITERALS_LENGTH_TABLE_LOG = 6;
export const MATCH_LENGTH_TABLE_LOG = 6;
export const OFFSET_CODE_TABLE_LOG = 5;

function msb(val: number): number {
  let bits = 0;
  for (; 1 << bits <= val; ++bits);
  return bits - 1;
}

/** Build FSE decode table from normalized distribution (incl. -1 for "less than 1"). */
export function buildFseDecodeTable(
  normalizedCounter: ReadonlyArray<number>,
  tableLog: number,
): FseDecodeTable {
  const tableSize = 1 << tableLog;
  const maxSymbolValue = normalizedCounter.length - 1;
  const tableSymbol = new Int32Array(tableSize);
  tableSymbol.fill(-1);
  const symbolNext = new Int32Array(maxSymbolValue + 1);
  let highThreshold = tableSize - 1;

  for (let s = 0; s <= maxSymbolValue; s++) {
    const n = normalizedCounter[s] ?? 0;
    if (n === -1) {
      tableSymbol[highThreshold] = s;
      highThreshold--;
      symbolNext[s] = 1;
    } else {
      symbolNext[s] = n;
    }
  }

  const step = (tableSize >> 1) + (tableSize >> 3) + 3;
  const tableMask = tableSize - 1;
  let position = 0;
  for (let s = 0; s <= maxSymbolValue; s++) {
    const n = normalizedCounter[s] ?? 0;
    if (n <= 0) continue;
    for (let i = 0; i < n; i++) {
      tableSymbol[position] = s;
      do {
        position = (position + step) & tableMask;
      } while (position > highThreshold);
    }
  }

  const symbolByState = new Uint16Array(tableSize);
  const numBitsByState = new Uint8Array(tableSize);
  const baselineByState = new Int32Array(tableSize);
  for (let u = 0; u < tableSize; u++) {
    const symbol = tableSymbol[u] ?? 0;
    const nextState = symbolNext[symbol] ?? 0;
    symbolNext[symbol] = nextState + 1;
    const nbBits = tableLog - msb(nextState);
    const baseline = (nextState << nbBits) - tableSize;
    symbolByState[u] = symbol;
    numBitsByState[u] = nbBits;
    baselineByState[u] = baseline;
  }

  return {
    symbol: symbolByState,
    numBits: numBitsByState,
    baseline: baselineByState,
    tableLog,
    length: tableSize,
  };
}

type EncodeTable = {
  /** Row offset per symbol into `stateForNext`; -1 when absent from the table. */
  rowOffsetBySymbol: Int32Array;
  /** rowOffsetBySymbol[symbol] + nextState -> the state that reaches it. */
  stateForNext: Int32Array;
  /** Any valid state per symbol, used to seed the backward walk. */
  seedStateBySymbol: Int32Array;
  baselineByState: Int32Array;
};

const encodeCache = new WeakMap<FseDecodeTable, EncodeTable>();

/**
 * Invert a decode table into a next-state lookup.
 *
 * For any symbol, the `[baseline, baseline + 2^numBits)` ranges of its states
 * tile `[0, tableSize)` exactly, so every reachable next state has exactly one
 * predecessor per symbol. Materializing that map costs
 * `distinctSymbols * tableSize` entries and turns encoding into a lookup.
 */
function getEncodeTable(table: FseDecodeTable): EncodeTable {
  const cached = encodeCache.get(table);
  if (cached) return cached;
  const tableSize = table.length;
  let maxSymbol = 0;
  for (let s = 0; s < tableSize; s++) {
    const sym = table.symbol[s] ?? 0;
    if (sym > maxSymbol) maxSymbol = sym;
  }
  const rowOffsetBySymbol = new Int32Array(maxSymbol + 1).fill(-1);
  const seedStateBySymbol = new Int32Array(maxSymbol + 1).fill(-1);
  let rows = 0;
  for (let s = 0; s < tableSize; s++) {
    const sym = table.symbol[s] ?? 0;
    if ((rowOffsetBySymbol[sym] ?? -1) < 0) {
      rowOffsetBySymbol[sym] = rows * tableSize;
      seedStateBySymbol[sym] = s;
      rows++;
    }
  }
  const stateForNext = new Int32Array(rows * tableSize).fill(-1);
  for (let s = 0; s < tableSize; s++) {
    const sym = table.symbol[s] ?? 0;
    const offset = rowOffsetBySymbol[sym] ?? 0;
    const baseline = table.baseline[s] ?? 0;
    const width = 1 << (table.numBits[s] ?? 0);
    for (let v = 0; v < width; v++) {
      const next = baseline + v;
      if (next >= 0 && next < tableSize) stateForNext[offset + next] = s;
    }
  }
  const built: EncodeTable = {
    rowOffsetBySymbol,
    stateForNext,
    seedStateBySymbol,
    baselineByState: table.baseline,
  };
  encodeCache.set(table, built);
  return built;
}

export type FseStatePath = {
  states: Array<number>;
  updateBits: Array<number>;
};

/**
 * Find a valid FSE state sequence for the given symbol codes (decode order).
 * Returns states[i] for each code and updateBits between consecutive states.
 *
 * The path is fixed once the final state is chosen: walking backwards, each
 * symbol has exactly one state that can reach the state after it.
 */
export function buildStatePath(
  codes: ArrayLike<number>,
  table: FseDecodeTable,
): FseStatePath | null {
  const rowCount = codes.length;
  if (rowCount === 0) return { states: [], updateBits: [] };
  const { rowOffsetBySymbol, stateForNext, seedStateBySymbol, baselineByState } =
    getEncodeTable(table);

  const lastCode = codes[rowCount - 1] ?? -1;
  if (lastCode < 0 || lastCode >= seedStateBySymbol.length) return null;
  let state = seedStateBySymbol[lastCode] ?? -1;
  if (state < 0) return null;

  // Pre-sized plain arrays (filled below); avoids per-index Array.from callbacks.
  const states: Array<number> = Array.from({ length: rowCount });
  const updateBits: Array<number> = Array.from({
    length: Math.max(0, rowCount - 1),
  });
  states[rowCount - 1] = state;

  for (let row = rowCount - 2; row >= 0; row--) {
    const code = codes[row] ?? -1;
    if (code < 0 || code >= rowOffsetBySymbol.length) return null;
    const offset = rowOffsetBySymbol[code] ?? -1;
    if (offset < 0) return null;
    const previous = stateForNext[offset + state] ?? -1;
    if (previous < 0) return null;
    states[row] = previous;
    updateBits[row] = state - (baselineByState[previous] ?? 0);
    state = previous;
  }
  return { states, updateBits };
}

type PredefinedTables = {
  ll: FseDecodeTable;
  of: FseDecodeTable;
  ml: FseDecodeTable;
};

let cachedPredefined: PredefinedTables | null = null;

export function getPredefinedFseTables(): PredefinedTables {
  if (!cachedPredefined) {
    cachedPredefined = {
      ll: buildFseDecodeTable(LITERALS_LENGTH_DEFAULT_DISTRIBUTION, LITERALS_LENGTH_TABLE_LOG),
      of: buildFseDecodeTable(OFFSET_CODE_DEFAULT_DISTRIBUTION, OFFSET_CODE_TABLE_LOG),
      ml: buildFseDecodeTable(MATCH_LENGTH_DEFAULT_DISTRIBUTION, MATCH_LENGTH_TABLE_LOG),
    };
  }
  return cachedPredefined;
}
