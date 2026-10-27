# Changelog

## Unreleased

Initial public release.

- `compressFast`, `compressStrong`, `compressUltra` one-shot encoders on
  `wzstd/compressFast`, `wzstd/compressStrong`, `wzstd/compressUltra`.
- Streaming Fast/Strong: `CompressFast` / `compressFastStream`,
  `CompressStrong` / `compressStrongStream`.
- `decompress`, `Decompress`, `decompressStream` on the root `wzstd` export,
  `wzstd/decompress`, and `wzstd/decompressStream`. Frames from zstd levels
  −8 through 19 are in the tested band; 20–22 decode as well.
- Content checksums are verified by default; only `{ checksum: false }` skips.
- Decode output is capped by `maxSize` (default 64 MiB, `Infinity` opts out,
  `OutputTooLarge` when exceeded) on `decompress`, `Decompress` and
  `decompressStream`. Windows above 128 MiB (libzstd's default limit) throw
  `WindowSizeTooLarge`. Sequences are bounds-checked as they execute, so a
  hostile block cannot burn CPU past its 128 KiB output.
- `compressUltra` is experimental: kept for research, not recommended.
- The npm package ships no sourcemaps.
- The root `wzstd` export is **decode-only**. Encoders are imported from their
  subpaths; there is no barrel that pulls in every tier.

Development:

- `pnpm fuzz` — seeded randomized differential fuzz against `node:zlib`
  (`--iters`, `--seed`, `--start` to replay).
- `@paddor/zrip` is declared as an `npm:@jsr/…` alias with the jsr registry in
  `.npmrc`, so plain `npm install` works for contributors (no `jsr:` protocol).
- Minimal CI (`pnpm check` + `pnpm test` on Node 24) and a tag-triggered
  release workflow that publishes with npm provenance.
