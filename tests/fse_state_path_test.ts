/**
 * Internal invariant behind the FSE encoder: for any symbol, the
 * `[baseline, baseline + 2^numBits)` ranges of its states tile `[0, tableSize)`
 * exactly. That is what makes the backward state walk in `buildStatePath`
 * deterministic and search-free.
 *
 * Imports source (not `dist`) on purpose — this checks an internal contract,
 * not shipped surface.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildFseDecodeTable,
  buildStatePath,
  getPredefinedFseTables,
  type FseDecodeTable,
} from "../src/compress/fse.ts";

function makeRandom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>>= 0);
  };
}

/** Random normalized distribution summing to exactly `1 << tableLog`. */
function randomDistribution(
  rnd: () => number,
  symbolCount: number,
  tableLog: number,
  allowLowProb: boolean,
): Array<number> {
  const tableSize = 1 << tableLog;
  const dist: Array<number> = Array.from({ length: symbolCount }, () => 0);
  const present: Array<number> = [];
  for (let s = 0; s < symbolCount; s++) {
    if (rnd() % 3 === 0) continue;
    present.push(s);
  }
  if (present.length === 0) present.push(0);
  if (present.length > tableSize) present.length = tableSize;
  let remaining = tableSize;
  for (const s of present) dist[s] = 1;
  remaining -= present.length;
  while (remaining > 0) {
    const s = present[rnd() % present.length] ?? 0;
    const take = 1 + (rnd() % Math.min(remaining, 8));
    dist[s] = (dist[s] ?? 0) + take;
    remaining -= take;
  }
  if (allowLowProb && present.length > 1) {
    // "Less than one" probability: one slot, placed at the high end.
    const s = present[0] ?? 0;
    const had = dist[s] ?? 0;
    if (had > 1) {
      dist[s] = -1;
      let give = had - 1;
      while (give > 0) {
        const t = present[1 + (rnd() % (present.length - 1))] ?? 0;
        dist[t] = (dist[t] ?? 0) + 1;
        give--;
      }
    }
  }
  return dist;
}

/** Every state range of a symbol must tile [0, tableSize) exactly once. */
function assertTiles(table: FseDecodeTable, label: string): void {
  const bySymbol = new Map<number, Array<number>>();
  for (let s = 0; s < table.length; s++) {
    const sym = table.symbol[s] ?? 0;
    const list = bySymbol.get(sym);
    if (list) list.push(s);
    else bySymbol.set(sym, [s]);
  }
  for (const [sym, states] of bySymbol) {
    const cover = new Uint8Array(table.length);
    for (const s of states) {
      const baseline = table.baseline[s] ?? 0;
      const width = 1 << (table.numBits[s] ?? 0);
      for (let v = 0; v < width; v++) {
        const next = baseline + v;
        assert.ok(
          next >= 0 && next < table.length,
          `${label}: symbol ${sym} state ${s} reaches ${next}, out of range`,
        );
        assert.equal(cover[next], 0, `${label}: symbol ${sym} covers next state ${next} twice`);
        cover[next] = 1;
      }
    }
    for (let i = 0; i < cover.length; i++) {
      assert.equal(cover[i], 1, `${label}: symbol ${sym} never reaches next state ${i}`);
    }
  }
}

/** Replay the decoder's state machine over an encoded path. */
function assertPathDecodes(codes: Array<number>, table: FseDecodeTable, label: string): void {
  const path = buildStatePath(codes, table);
  assert.ok(path, `${label}: expected a state path`);
  assert.equal(path.states.length, codes.length, `${label}: state count`);

  let state = path.states[0] ?? 0;
  for (let i = 0; i < codes.length; i++) {
    assert.equal(
      table.symbol[state],
      codes[i],
      `${label}: state ${state} decodes to the wrong symbol at ${i}`,
    );
    if (i === codes.length - 1) break;
    const bits = table.numBits[state] ?? 0;
    const update = path.updateBits[i] ?? 0;
    assert.ok(
      update >= 0 && update < 1 << bits,
      `${label}: update ${update} does not fit ${bits} bits at ${i}`,
    );
    state = (table.baseline[state] ?? 0) + update;
    assert.equal(state, path.states[i + 1], `${label}: state transition diverged at ${i}`);
  }
}

describe("FSE state path", () => {
  test("predefined tables tile and replay", () => {
    const { ll, of, ml } = getPredefinedFseTables();
    for (const [name, table] of [
      ["ll", ll],
      ["of", of],
      ["ml", ml],
    ] as const) {
      assertTiles(table, name);
      const rnd = makeRandom(0x1111);
      const codes: Array<number> = [];
      const symbols = new Set<number>();
      for (let s = 0; s < table.length; s++) symbols.add(table.symbol[s] ?? 0);
      const usable = [...symbols];
      for (let i = 0; i < 500; i++) {
        codes.push(usable[rnd() % usable.length] ?? 0);
      }
      assertPathDecodes(codes, table, name);
    }
  });

  test("random distributions tile and replay at every accuracy log", () => {
    const rnd = makeRandom(0xabcdef);
    for (let tableLog = 5; tableLog <= 9; tableLog++) {
      for (let trial = 0; trial < 40; trial++) {
        const symbolCount = 2 + (rnd() % 52);
        const dist = randomDistribution(rnd, symbolCount, tableLog, trial % 3 === 0);
        const table = buildFseDecodeTable(dist, tableLog);
        const label = `log=${tableLog} trial=${trial}`;
        assertTiles(table, label);

        const usable: Array<number> = [];
        for (let s = 0; s < table.length; s++) {
          const sym = table.symbol[s] ?? 0;
          if (!usable.includes(sym)) usable.push(sym);
        }
        const codes: Array<number> = [];
        const n = 1 + (rnd() % 300);
        for (let i = 0; i < n; i++) {
          codes.push(usable[rnd() % usable.length] ?? 0);
        }
        assertPathDecodes(codes, table, label);
      }
    }
  });

  test("single-symbol (RLE-shaped) tables replay with zero-width updates", () => {
    const table: FseDecodeTable = {
      symbol: new Uint16Array([7]),
      numBits: new Uint8Array([0]),
      baseline: new Int32Array([0]),
      tableLog: 0,
      length: 1,
    };
    const codes = Array.from({ length: 50 }, () => 7);
    assertTiles(table, "rle");
    assertPathDecodes(codes, table, "rle");
    const path = buildStatePath(codes, table);
    assert.ok(path);
    for (const bits of path.updateBits) {
      assert.equal(bits, 0, "RLE transitions must carry no bits");
    }
  });

  test("a code absent from the table fails closed", () => {
    const { of } = getPredefinedFseTables();
    assert.equal(
      buildStatePath([0, 1, 250], of),
      null,
      "expected null for an unrepresentable code",
    );
  });
});
