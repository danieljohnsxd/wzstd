/**
 * Pinned Silesia subset — part of the main bench set (with in-repo synthetic).
 *
 * Not the full Silesia corpus (12 files). Four that fill shapes the synthetic
 * generators under-cover:
 *
 * - **dickens** — real English literary prose
 * - **xml** — real structured markup
 * - **osdb** — database-style binary dump
 * - **x-ray** — medical/image binary (high-entropy structure)
 *
 * Total ~34 MB. **Downloaded on demand** into `bench-data/silesia/` (gitignored).
 * Size + SHA-256 pinned so a corrupt or swapped mirror fails closed.
 *
 * ## Provenance
 *
 * Files are from the **Silesia compression corpus**, maintained by
 * Sebastian Deorowicz (Silesian University of Technology):
 * https://sun.aei.polsl.pl/~sdeor/index.php?page=silesia
 *
 * Distributed as bzip2 from that site; we store the decompressed payloads
 * after verifying size and digest. Digests match the pins used by paddor/zrip.
 * Cite as the Silesia corpus (Deorowicz) when publishing numbers that include
 * these rows.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Payload } from "../../tests/helpers/corpus.ts";

export type SilesiaEntry = {
  /** Basename on disk and payload label. */
  name: string;
  url: string;
  size: number;
  sha256: string;
};

/** Corpus home page (attribution / citation). */
export const SILESIA_PROVENANCE = {
  name: "Silesia compression corpus",
  author: "Sebastian Deorowicz",
  institution: "Silesian University of Technology",
  url: "https://sun.aei.polsl.pl/~sdeor/index.php?page=silesia",
} as const;

/**
 * Hand-picked subset. Full Silesia is a different claim (e.g. zrip geomean);
 * this is the real-file half of *our* main set next to in-repo synthetic.
 */
export const SILESIA_SUBSET: ReadonlyArray<SilesiaEntry> = [
  {
    name: "dickens",
    url: "https://sun.aei.polsl.pl/~sdeor/corpus/dickens.bz2",
    size: 10_192_446,
    sha256: "b24c37886142e11d0ee687db6ab06f936207aa7f2ea1fd1d9a36763c7a507e6a",
  },
  {
    name: "xml",
    url: "https://sun.aei.polsl.pl/~sdeor/corpus/xml.bz2",
    size: 5_345_280,
    sha256: "0e82e54e695c1938e4193448022543845b33020c8be6bf3bf3ead2224903e08c",
  },
  {
    name: "osdb",
    url: "https://sun.aei.polsl.pl/~sdeor/corpus/osdb.bz2",
    size: 10_085_684,
    sha256: "60f027179302ca3ad87c58ac90b6be72ec23588aaa7a3b7fe8ecc0f11def3fa3",
  },
  {
    name: "x-ray",
    url: "https://sun.aei.polsl.pl/~sdeor/corpus/x-ray.bz2",
    size: 8_474_240,
    sha256: "7de9fce1405dc44ae5e6813ed21cd5751e761bd4265655a005d39b9685d1c9ad",
  },
];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** On-disk cache for the pinned subset (gitignored). */
export function silesiaDir(): string {
  return join(ROOT, "bench-data", "silesia");
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function verify(entry: SilesiaEntry, data: Uint8Array): void {
  if (data.length !== entry.size) {
    throw new Error(`silesia ${entry.name}: got ${data.length} bytes, expected ${entry.size}`);
  }
  const hash = sha256Hex(data);
  if (hash !== entry.sha256) {
    throw new Error(`silesia ${entry.name}: sha256 ${hash}, expected ${entry.sha256}`);
  }
}

function download(entry: SilesiaEntry, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.part.${process.pid}`;
  try {
    unlinkSync(tmp);
  } catch {
    // absent is fine
  }
  // Same fetch path as zrip: curl the .bz2, decompress to payload bytes.
  const shell = `curl -fSL ${JSON.stringify(entry.url)} | bzip2 -d > ${JSON.stringify(tmp)}`;
  const run = spawnSync("sh", ["-c", shell], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (run.error !== undefined) {
    throw new Error(`silesia ${entry.name}: ${run.error.message}`);
  }
  if (run.status !== 0) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort
    }
    throw new Error(
      `silesia ${entry.name}: download failed (exit ${String(run.status)})\n` +
        `  need curl + bzip2; url ${entry.url}`,
    );
  }
  const data = new Uint8Array(readFileSync(tmp));
  verify(entry, data);
  renameSync(tmp, dest);
}

/**
 * Ensure one entry is on disk and valid. Re-downloads on size/hash mismatch.
 */
export function ensureSilesiaEntry(entry: SilesiaEntry): string {
  const path = join(silesiaDir(), entry.name);
  if (existsSync(path)) {
    const data = new Uint8Array(readFileSync(path));
    try {
      verify(entry, data);
      return path;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  silesia cache stale (${msg}); re-downloading`);
      try {
        unlinkSync(path);
      } catch {
        // continue to download
      }
    }
  }
  console.error(`  downloading silesia/${entry.name} ...`);
  download(entry, path);
  return path;
}

/**
 * Load the full subset as payloads (downloads missing files). Sorted by size.
 * Throws if network/tools fail — the main bench set must not silently skip.
 */
export function silesiaPayloads(): Array<Payload> {
  writeSilesiaReadme();
  const out: Array<Payload> = [];
  for (const entry of SILESIA_SUBSET) {
    const path = ensureSilesiaEntry(entry);
    const data = new Uint8Array(readFileSync(path));
    verify(entry, data);
    out.push({ name: entry.name, data });
  }
  out.sort((a, b) => a.data.length - b.data.length || a.name.localeCompare(b.name));
  return out;
}

/** README in the cache dir: provenance + do-not-hand-edit. Always refreshed. */
export function writeSilesiaReadme(): void {
  const dir = silesiaDir();
  mkdirSync(dir, { recursive: true });
  const { name, author, institution, url } = SILESIA_PROVENANCE;
  writeFileSync(
    join(dir, "README.md"),
    [
      "# Pinned Silesia subset (main bench set)",
      "",
      "Part of the default encode/decode/summary corpus next to in-repo",
      "synthetic. **Downloaded on demand** into this directory; payloads are",
      "gitignored. Do not hand-edit files — size and SHA-256 are pinned in",
      "`scripts/helpers/silesia.ts`.",
      "",
      "## Files",
      "",
      "- dickens (~10.2 MB) — English literary prose",
      "- xml (~5.3 MB) — structured markup",
      "- osdb (~10.1 MB) — database-style dump",
      "- x-ray (~8.5 MB) — medical/image binary",
      "",
      "Total ~34 MB (not full Silesia).",
      "",
      "## Provenance",
      "",
      `${name}, ${author} (${institution}).`,
      url,
      "",
      "Fetched as `.bz2` from that site; we keep the decompressed bytes after",
      "hash verification. Cite the Silesia corpus when publishing figures that",
      "include these rows.",
      "",
    ].join("\n"),
  );
}
