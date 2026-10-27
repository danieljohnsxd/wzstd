# wzstd

Zstandard in pure TypeScript. A **~6 KB gzipped decoder**, three encode tiers,
streaming both ways, **no native or WASM dependency**, and **content checksums
verified by default**.

```bash
npm install wzstd     # or: pnpm add wzstd
```

ESM only, ES2022, Node ≥ 22. Runs anywhere typed arrays do — Node, Deno, Bun,
Cloudflare Workers, Convex, Supabase edge, browsers. The test suite runs on
Node; nothing in `src/` touches a Node-only API.

## When to use this

Agents: the same guidance, with the rules and error handling, is in
[`skills/zstd/SKILL.md`](skills/zstd/SKILL.md).

- **Decode zstd where there is no native zstd**: Workers, edge runtimes,
  Deno/Bun without a binding, browser code handling `.zst` bytes itself. On
  Node 22.15+ / 23.8+, `node:zlib` has zstd (still marked experimental) and is
  faster.
- **Compress zstd on the fly** (an API response, a log upload) from a runtime
  without native zstd: `compressFast`, or `compressStrong` when ratio matters
  more than speed.
- **Not for build-time static assets.** Precompress those with the native
  `zstd` or `brotli` CLI at a high level; both beat any pure-JS encoder on
  ratio, and nothing is waiting on the request.
- **HTTP `Content-Encoding: zstd`**: browsers decode it natively (Chrome 123+,
  Firefox 126+, Safari 26.3+ on OS 26.3), so wzstd is only needed on the
  serving side, and only where native zstd is missing. `Accept-Encoding` still
  decides — fall back to gzip or brotli when zstd is not offered. RFC 9659
  limits HTTP zstd to an 8 MiB window; Fast and Strong use 1 MiB, Ultra 8 MiB.
- **gzip instead** when the consumer is old or unknown, or the built-in
  `CompressionStream` is enough — see the sibling
  [wgzip](https://github.com/danieljohnsxd/wgzip). Image uploads (resize,
  re-encode) are [wimages](https://github.com/danieljohnsxd/wimages).

## Design choices

- **Tiers, not levels.** Fast and Strong are the two answers; there is no
  `compress(level)` and no 1–22 ladder. Ultra is a research experiment that
  never paid off — on the in-repo corpus it is ~0.6 points of ratio over
  Strong in total, for a slower encode and an 8 MiB window. It stays exported,
  but it is **experimental; do not pick it.**
- **Safe by default on untrusted input.** Content checksums are verified
  unless you write `checksum: false`. Output is capped at **64 MiB**
  (`maxSize`; `Infinity` opts out). Windows above **128 MiB** — libzstd's own
  default decoder limit — are rejected, with no option to raise it.
- **Fixed limits over knobs.** Window and block limits are constants taken
  from libzstd, not options.
- **Decode-only root.** `import { decompress } from "wzstd"` never loads an
  encoder; each tier is its own subpath.

## Why not `node:zlib` or a WASM build?

- **`node:zlib` has zstd, but only on Node.** Workers, edge runtimes, and
  browsers have no zstd at all — `DecompressionStream` is gzip/deflate only.
- **WASM zstd ports are hundreds of KB to ~1 MB plus a loader.** wzstd's
  decoder is one import: `dist/decompress.js` + the xxh64 chunk, ~6 KB gzipped.
  The whole package, every encoder included, is ~16 KB gzipped.
- **fzstd** (the pure-JS decoder wzstd's is derived from) **never checks the
  content checksum.** wzstd verifies by default and is still 1.1–1.3× faster on
  our corpora while doing that extra work.
- **The encoders are for when native can't ship.** They are not the fastest
  zstd; they are the zstd that fits a Worker's bundle budget and produces
  standard frames any `zstd` reads.

## Use

```ts
import { decompress, decompressStream } from "wzstd";
import { compressStrong } from "wzstd/compressStrong";
import { CompressFast, compressFastStream } from "wzstd/compressFast";

const frame = compressStrong(data); // Uint8Array → standard zstd frame
const bytes = decompress(frame); // checksum verified

// Web Streams
response.body?.pipeThrough(decompressStream());
readable.pipeThrough(compressFastStream());

// Push API (no TransformStream needed)
const enc = new CompressFast((chunk) => sink(chunk));
enc.push(part);
enc.push(new Uint8Array(0), true); // final
```

### Imports

The root export is **decode-only**, so `import { decompress } from "wzstd"`
never evaluates an encoder. Every function also has its own entry, so a
bundler-free consumer can import exactly one thing.

| Import                   | Exports                                                                      |
| ------------------------ | ---------------------------------------------------------------------------- |
| `wzstd`                  | `decompress`, `Decompress`, `decompressStream`, `ZstdError`, `ZstdErrorCode` |
| `wzstd/decompress`       | Same minus `decompressStream`                                                |
| `wzstd/decompressStream` | `decompressStream`, `ZstdError`, `ZstdErrorCode`                             |
| `wzstd/compressFast`     | `compressFast`, `CompressFast`, `compressFastStream`                         |
| `wzstd/compressStrong`   | `compressStrong`, `CompressStrong`, `compressStrongStream`                   |
| `wzstd/compressUltra`    | `compressUltra` (one-shot only; experimental)                                |

## API

### Decode

**`decompress(data: Uint8Array, opts?: { out?: Uint8Array; checksum?: boolean; maxSize?: number }): Uint8Array`**

- Decodes **any number of concatenated frames** and joins the output. Skippable
  frames are skipped.
- Frames from zstd levels **−8 through 19** are the exhaustively tested band;
  levels 20–22 decode and are tested too. Frames declaring a window above
  128 MiB (libzstd's default decoder limit; `--long=28` and up) throw
  `WindowSizeTooLarge`. Dictionary frames throw.
- `maxSize` caps the total output, **default 64 MiB**; exceeding it throws
  `OutputTooLarge`, and a declared content size above it throws before
  anything is allocated. Pass `maxSize: Infinity` only for trusted input. It
  must be `Infinity` or a non-negative safe integer (`TypeError` otherwise).
  A zstd frame can expand ~32,000× (10 KB → 300+ MB), so keep a cap on
  anything you did not produce.
- `checksum` **defaults to `true`**. `{}`, `undefined`, and omitting it all
  verify; only an explicit `checksum: false` skips the hash. Turning it off
  disables the hash only — bounds, offsets, window, FSE, and frame-size checks
  never turn off. There is no positional flag: you cannot skip verification
  by accident.
- `out` is a pre-sized output buffer for a **single data frame** (skippable
  frames still allowed). Multi-frame input with `out` throws, because every
  frame writes from offset 0. Omit it and the function allocates.

**`new Decompress(ondata?: (chunk: Uint8Array, final?: boolean) => void, opts?: { checksum?: boolean; maxSize?: number })`**

Push-based streaming decode with a real bounded window. `push(chunk, final?)`;
an empty final push closes the last frame and raises `UnexpectedEOF` if the
input ended mid-frame. Chunks handed to `ondata` are fresh allocations you may
keep. `maxSize` (default 64 MiB) counts everything emitted; the chunk that
would cross it is never emitted.

**`decompressStream(opts?: { checksum?: boolean; maxSize?: number }): TransformStream<Uint8Array, Uint8Array>`**

`Decompress` wrapped in a `TransformStream`. The global is looked up when you
call the factory, not at import time, so the module loads on hosts without it.

**Errors.** Every failure is a `ZstdError` with a numeric `code` from
`ZstdErrorCode`: `InvalidData`, `WindowSizeTooLarge`, `InvalidBlockType`,
`FSEAccuracyTooHigh`, `DistanceTooFarBack`, `UnexpectedEOF`,
`ChecksumMismatch`, `OutputTooLarge`. Invalid options throw `TypeError`. Corrupt or truncated input never escapes as any other
exception type and never returns wrong bytes — `tests/unguarded_reads_test.ts`
sweeps every byte flip and every truncation of every fixture, and `pnpm fuzz`
does the same on random inputs against `node:zlib`.

### Encode

| Function                                  | Tier   | Search                                              | Literals      | Window |
| ----------------------------------------- | ------ | --------------------------------------------------- | ------------- | ------ |
| `compressFast(data)`                      | Fast   | chain 4, 17-bit hash / 4-slot row, rep probes, skip | raw / RLE     | 1 MiB  |
| `compressStrong(data)`                    | Strong | chain 20, patience 4, rep probes                    | Huffman + FSE | 1 MiB  |
| `compressUltra(data)` (experimental)      | Ultra  | chain 24, patience 2, 8-byte long-hash, rep probes  | Huffman + FSE | 8 MiB  |
| `CompressFast` / `compressFastStream`     | Fast   | streaming; emits 128 KiB blocks as they fill        |               | 1 MiB  |
| `CompressStrong` / `compressStrongStream` | Strong | streaming; emits 128 KiB blocks as they fill        |               | 1 MiB  |

These are product tiers, not stock zstd levels — there is no `compress(level)`.
One-shot frames carry the content size and a checksum. Streaming frames carry
an explicit 1 MiB window and a checksum but no content size, because the size
is not known up front. Output is a standard zstd frame with no dictionary
(single-segment up to the tier's window, an explicit window descriptor above
it); `zstd`, `node:zlib`, and every other conforming decoder reads it.

**Not supported:** dictionaries, streaming Ultra (its 8 MiB window is the
wrong resident set for a stream).

## Numbers

Measured on an **Apple M3, 16 GB RAM, Node 24**, each subject in its own
**isolated Node child process** (`scripts/helpers/isolate.ts`). Absolute MB/s
will differ on your machine; the ratios and the relative columns travel.
`zrip` (Rust → WASM) and `node:zlib` (C libzstd) are **ceilings**, not peers —
they exist to show where native lands, not as a target.

Two corpora, never pooled: the in-repo synthetic set and a pinned
[Silesia](https://sun.aei.polsl.pl/~sdeor/index.php?page=silesia) subset.
**Ratio** is compressed ÷ original (lower is better).

**Encode**

| encoder            | synthetic ratio | synthetic MB/s | Silesia ratio | Silesia MB/s |
| ------------------ | --------------: | -------------: | ------------: | -----------: |
| wzstd Fast         |          0.1885 |             49 |        0.5080 |           26 |
| wzstd Strong       |          0.1486 |             37 |        0.4853 |           14 |
| fflate gzip (JS)   |          0.2044 |             70 |        0.4227 |           40 |
| `node:zlib` gzip   |          0.2034 |            185 |        0.4237 |           69 |
| `node:zlib` zstd 3 |          0.1497 |              — |        0.4079 |          299 |

Strong beats C zstd level 3 on ratio for the synthetic set and trails it (and
fflate) on Silesia — that gap is search quality libzstd has and we have priced
out of Strong (see the ledger). Encode is 5–10× slower than C; that is the
cost of pure JS, not a bug to file.

**Decode** — zstd level 3 frames. `vs fzstd` is wzstd **with checksum
verification on** against fzstd, which never hashes; it is the median of
per-payload ratios, never a ratio of medians.

| corpus    | wzstd MB/s | fzstd MB/s |  vs fzstd | zrip ÷ wzstd |
| --------- | ---------: | ---------: | --------: | -----------: |
| synthetic |        400 |        337 | **1.31×** |         4.5× |
| Silesia   |        247 |        230 | **1.13×** |         4.3× |

Every number above comes from `pnpm bench:summary`. How they were arrived at —
including the declined 1.08× decoder win, the ratio-of-medians mistake, and
every matcher lever that was tried and priced — is in
[`docs/experiments.md`](docs/experiments.md).

## Development

```bash
pnpm install
pnpm check                # oxfmt + oxlint (type-aware)
pnpm test                 # hermetic: synthetic fixtures, three oracles
pnpm test --extra         # + your own corpus in extra-bench-data/
pnpm fuzz                 # seeded differential fuzz vs node:zlib
pnpm bench:summary        # encode then decode, the quotable table
pnpm build
```

Tests are differential against three independent decoders — `zrip` (WASM),
the host `zstd` CLI, and `node:zlib` — in both directions. See
[`tests/README.md`](tests/README.md) and [`AGENTS.md`](AGENTS.md) for the
conventions.

## Maintenance

wzstd is maintained by one person. The encoders are frozen at the tiers above
unless a measured change moves the ledger.

## Credit

The decoder began as a study of [fzstd](https://github.com/101arrowz/fzstd) by
Arjun Barrett — the table layouts and the bit-reader shape are his idea, and
his copyright notice stays in [`LICENSE`](LICENSE). fzstd does not verify
content checksums and does little structural validation of hostile input;
wzstd adds both (bounds-guarded reads of untrusted data, checksum verification
on by default, a bounded streaming window), plus the three encoders, the
streams, and the test and bench harnesses, which are original. Security reports: see [`SECURITY.md`](SECURITY.md). Changes:
[`CHANGELOG.md`](CHANGELOG.md).

MIT.
