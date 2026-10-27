/**
 * The **extra corpus**: whatever files are in `extra-bench-data/`.
 *
 * It is deliberately generic. Anyone can drop their own data in that directory —
 * or point `WZSTD_CORPUS_DIR` at a directory of their own — and the benches will
 * report it beside the synthetic fixtures, because "how does this codec do on
 * *my* data" is the only question that decides whether to adopt it. Nothing here
 * knows or cares that this machine's copy happens to be GeoJSONL.
 *
 * Any file in the directory is a payload; the extension is not interpreted.
 *
 * It is gitignored and absent on a fresh clone. **Tests must treat an empty
 * result as skip, never as failure.** Benches are the opposite: a bench asked
 * for the extra corpus must fail loudly rather than quietly report synthetic
 * numbers under an "extra" heading — see `scripts/helpers/corpora.ts`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Payload } from "./corpus.ts";

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "extra-bench-data");

export function externalCorpusDir(): string {
  return process.env["WZSTD_CORPUS_DIR"] ?? DEFAULT_DIR;
}

/**
 * True when there is at least one non-empty file to load — the same bar
 * {@link externalPayloads} uses. Empty placeholders and subdirectories alone
 * do not count, so a half-filled directory does not claim "present" and then
 * fail with "corpus is present" assertions against an empty list.
 */
export function hasExternalCorpus(): boolean {
  const dir = externalCorpusDir();
  if (!existsSync(dir)) return false;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (st.isFile() && st.size > 0) return true;
    } catch {
      // ignore races / permission
    }
  }
  return false;
}

/** True when any filename contains `-part.` — a truncated sample marker. */
export function externalCorpusIsPartial(): boolean {
  const dir = externalCorpusDir();
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((f) => f.includes("-part."));
}

/**
 * Files from the external corpus, smallest first.
 * `maxBytes` caps each payload (whole file otherwise); 0 means no cap.
 */
export function externalPayloads(maxBytes = 0): Array<Payload> {
  const dir = externalCorpusDir();
  if (!existsSync(dir)) return [];
  const found: Array<{ name: string; path: string; size: number }> = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size === 0) continue;
    found.push({ name, path, size: stat.size });
  }
  // Smallest first, name as tiebreak, so the order is stable across machines.
  found.sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));

  const out: Array<Payload> = [];
  for (const entry of found) {
    const raw = new Uint8Array(readFileSync(entry.path));
    const data = maxBytes > 0 && raw.length > maxBytes ? raw.subarray(0, maxBytes) : raw;
    // Drop one trailing extension for a readable row label, whatever it is —
    // the corpus is not assumed to be any particular format.
    out.push({ name: entry.name.replace(/\.[^./]+$/, ""), data });
  }
  return out;
}
