# Security

wzstd parses untrusted binary input. If you find a way to make the decoder
crash outside of `ZstdError`, return wrong bytes without throwing, read out of
bounds, or accept a frame whose content checksum does not match, that is a
security bug.

## Reporting

Use GitHub's private vulnerability reporting for this repository
(**Security → Report a vulnerability**). Please do not open a public issue for
anything exploitable.

Include the input that triggers it (or the `pnpm fuzz --seed … --start …`
coordinates that reproduce it) and the runtime you observed it on.

## Scope

- `decompress`, `Decompress`, `decompressStream` — any panic, wrong output,
  silent checksum bypass, or **resource exhaustion on untrusted input**:
  - **Decompression bombs.** Output is capped by `maxSize` (default 64 MiB,
    counted across every frame of the input, on all three entry points). A
    way to make the decoder allocate or emit materially more than `maxSize`,
    or allocate from a header field before data proves it, is in scope.
  - **CPU amplification.** Decode work should be proportional to the input
    plus the output actually produced. Each sequence is bounds-checked before
    it runs, so a block cannot spin through copies past Block_Maximum_Size.
    An input that takes disproportionate time per byte is in scope.
  - **Memory from declarations.** Windows above 128 MiB (libzstd's default
    decoder limit) are rejected. A declared window never drives an
    allocation before data arrives; a declared content size is preallocated
    only up to `maxSize` and to what the input could possibly regenerate.
- The encoders — output that a conforming zstd decoder (`zstd` CLI,
  `node:zlib`) rejects or decodes to different bytes. Encoders take trusted
  input; slow encodes of adversarial input are not a vulnerability.

Out of scope: anything that requires `{ checksum: false }` or
`{ maxSize: Infinity }` to be passed explicitly — those opt out of the
protection on purpose — and decode that is slow only because the output is
legitimately large.

## Posture

- Content checksums are verified by default; only an explicit
  `{ checksum: false }` skips the hash. Structural validation never turns off.
- Reads of untrusted input are bounds-guarded; only reads of the decoder's own
  derived tables are unguarded (see `docs/experiments.md`).
- `pnpm test` runs byte-flip and truncation sweeps over every fixture
  (`tests/unguarded_reads_test.ts`); `pnpm fuzz` runs a seeded randomized
  differential fuzz against `node:zlib`; `tests/limits_test.ts` reproduces
  each bomb / amplification case above with a small hand-built frame.
