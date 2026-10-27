/**
 * Profile files in the extra corpus (or any directory) so the bench surface can
 * be described by content, not size alone.
 *
 * Axes measured:
 *   - bytes per feature — a few KB of properties vs hundreds of KB of ring
 *   - digit share       — how much of the file is raw coordinate numbers
 *   - alphabet + order-0 entropy — the ceiling a Huffman literals section hits
 *   - repeat share      — how much of a feature restates the previous one
 *
 * Statistics come from a prefix (4 MB). They characterise a file; they are not a
 * ratio basis. Whole-file copies only.
 *
 *   pnpm bench:profile-corpus
 *   pnpm bench:profile-corpus /path/to/dir
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProgress } from "./helpers/progress.ts";

/** Enough bytes to characterise a file without reading tens of MB. */
const SAMPLE_BYTES = 4_000_000;

export type Profile = {
  name: string;
  path: string;
  size: number;
  features: number;
  bytesPerFeature: number;
  digitShare: number;
  distinctBytes: number;
  entropyBits: number;
  /** Share of 8-byte grams that repeat within the sample (LZ headroom). */
  repeatShare: number;
};

function readPrefix(path: string, cap: number): Uint8Array {
  const size = statSync(path).size;
  const want = Math.min(size, cap);
  const buffer = new Uint8Array(want);
  const fd = openSync(path, "r");
  let read = 0;
  try {
    while (read < want) {
      const n = readSync(fd, buffer, read, want - read, read);
      if (n <= 0) break;
      read += n;
    }
  } finally {
    closeSync(fd);
  }
  return buffer.subarray(0, read);
}

export function profileFile(path: string, name = path): Profile {
  const size = statSync(path).size;
  const sample = readPrefix(path, SAMPLE_BYTES);
  const freq = new Uint32Array(256);
  let newlines = 0;
  let digits = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i] ?? 0;
    freq[b] = (freq[b] ?? 0) + 1;
    if (b === 0x0a) newlines++;
    else if (b >= 0x30 && b <= 0x39) digits++;
  }
  let distinct = 0;
  let bits = 0;
  for (const f of freq) {
    if (f === 0) continue;
    distinct++;
    bits += f * Math.log2(sample.length / f);
  }

  // Cheap LZ-headroom proxy: how often an 8-byte gram has been seen before.
  const seen = new Set<number>();
  let repeats = 0;
  let grams = 0;
  for (let i = 0; i + 8 <= sample.length; i += 4) {
    let h = 2_166_136_261;
    for (let k = 0; k < 8; k++) {
      h ^= sample[i + k] ?? 0;
      h = Math.imul(h, 16_777_619);
    }
    grams++;
    if (seen.has(h)) repeats++;
    else if (seen.size < 2_000_000) seen.add(h);
  }

  // Features in the sample; scale to the whole file by byte ratio.
  const sampledFeatures = Math.max(1, newlines);
  const bytesPerFeature = sample.length / sampledFeatures;
  return {
    name,
    path,
    size,
    features: Math.round(size / bytesPerFeature),
    bytesPerFeature,
    digitShare: sample.length > 0 ? digits / sample.length : 0,
    distinctBytes: distinct,
    entropyBits: sample.length > 0 ? bits / sample.length : 0,
    repeatShare: grams > 0 ? repeats / grams : 0,
  };
}

function listCorpusFiles(dir: string): Array<string> {
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => e.name);
  entries.sort();
  return entries;
}

export function profileDir(dir: string): Array<Profile> {
  return listCorpusFiles(dir).map((name) => profileFile(join(dir, name), name));
}

if (import.meta.filename === process.argv[1]) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dir =
    process.argv[2] ?? process.env["WZSTD_CORPUS_DIR"] ?? join(repoRoot, "extra-bench-data");
  if (!existsSync(dir)) {
    console.error(`corpus directory not found: ${dir}`);
    process.exit(1);
  }
  const names = listCorpusFiles(dir);
  if (names.length === 0) {
    console.error(`no files in ${dir}`);
    process.exit(1);
  }
  const progress = createProgress(names.length);
  const profiles: Array<Profile> = [];
  for (const name of names) {
    profiles.push(profileFile(join(dir, name), name));
    progress.tick(name);
  }
  console.log(
    "file                              size MB  features   B/feat  digit%  alpha  entropy  repeat%",
  );
  profiles.sort((a, b) => a.size - b.size);
  let total = 0;
  for (const p of profiles) {
    total += p.size;
    console.log(
      p.name.padEnd(32) +
        (p.size / 1048576).toFixed(2).padStart(8) +
        String(p.features).padStart(10) +
        Math.round(p.bytesPerFeature).toString().padStart(9) +
        (p.digitShare * 100).toFixed(0).padStart(7) +
        "%" +
        String(p.distinctBytes).padStart(7) +
        p.entropyBits.toFixed(2).padStart(9) +
        (p.repeatShare * 100).toFixed(0).padStart(8) +
        "%",
    );
  }
  console.log(`\n${profiles.length} files, ${(total / 1048576).toFixed(2)} MB`);
}
