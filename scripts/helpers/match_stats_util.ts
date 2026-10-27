/**
 * Shared MatchStats helpers for encode experiment scripts.
 * Deterministic work counters — not wall-clock.
 */
import type { MatchStats } from "../../dist/compressStrong.js";

export function emptyStats(): MatchStats {
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

export function addStats(into: MatchStats, from: MatchStats): void {
  into.searches += from.searches;
  into.primarySearches += from.primarySearches;
  into.lazySearches += from.lazySearches;
  into.probes += from.probes;
  into.needleHits += from.needleHits;
  into.extends += from.extends;
  into.improvements += from.improvements;
  into.hits += from.hits;
  into.exitPatience += from.exitPatience;
  into.exitNullPatience += from.exitNullPatience;
  into.exitChainLimit += from.exitChainLimit;
  into.exitMinLen += from.exitMinLen;
  into.exitMaxMatch += from.exitMaxMatch;
  into.exitNoCandidate += from.exitNoCandidate;
}

export function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${((100 * n) / d).toFixed(1)}%`;
}

export function num(n: number): string {
  return n.toLocaleString("en-US");
}
