# wzstd: context and rationale

Background for the rules in `../SKILL.md`. Sources are the repo's own records
(`README.md`, `AGENTS.md`, `HANDOFF.md`, `docs/experiments.md`) unless a link is
given.

## Platform facts

- **Browsers decode `Content-Encoding: zstd` natively**: Chrome 123+, Firefox
  126+, and Safari 26.3+ (February 2026; tied to the OS 26.3 networking stack,
  so older macOS / iOS with that Safari do not get it — caniuse marks it
  partial). Sources: [9to5mac, Safari 26.3](https://9to5mac.com/2026/02/11/safari-26-3-includes-welcome-improvements-for-users-and-developers-heres-whats-new/).
  `Accept-Encoding` negotiation is still the switch; never send zstd unasked.
- **`DecompressionStream` / `CompressionStream` do not support zstd** on any
  runtime (gzip, deflate, deflate-raw only). That gap is why this package
  exists for Workers, edge and browser code.
- **`node:zlib` has zstd from Node 22.15.0 / 23.8.0**, Stability 1
  (Experimental) in the Node docs. Native C libzstd: 5–10× faster encode and
  ~4× faster decode than wzstd. Prefer it whenever the code only runs on Node.
- **RFC 9659** (Window Sizing for Zstandard Content Encoding) limits HTTP zstd
  to an 8 MiB window. Fast and Strong declare 1 MiB, so their output is safe
  as `Content-Encoding`. Ultra declares 8 MiB.
- libzstd's default decoder window limit is 2^27 = 128 MiB
  (`ZSTD_WINDOWLOG_LIMIT_DEFAULT`); `zstd -d` and `node:zlib` reject larger
  windows unless told otherwise. wzstd uses the same fixed limit.

## Why tiers, not levels

There is one good answer per job, so the API names the job instead of exposing
zstd's 1–22 ladder:

- **Fast**: shallow chain (depth 4), raw/RLE literals, no Huffman. ~49 MB/s
  encode, ratio 0.1885 on the in-repo synthetic corpus.
- **Strong**: chain 20, Huffman literals, custom FSE tables. ~37 MB/s, ratio
  0.1486 — better than C zstd level 3 (0.1497) on that corpus, worse on the
  Silesia subset (0.485 vs 0.408).
- **Ultra**: Strong plus an 8-byte long hash and an 8 MiB window. Only ~0.6
  points of ratio over Strong in total; most payloads gain 0–1%. It never
  earned its cost and is kept as an experiment. Do not recommend it.

Numbers are Apple M3, Node 24, isolated processes (`pnpm bench:summary`).
Absolute MB/s is machine-local; the ratios travel.

## Why the safety defaults

- **Checksums verified by default.** Over 400 single-bit flips, structural
  checks alone caught 210 and returned wrong bytes for 190; with the XXH64
  digest, 400 and 0. Cost: 1.12–1.24× of decode. Only `checksum: false` skips
  it — there is no positional flag, so it cannot be skipped by accident.
  Structural validation never turns off.
- **`maxSize` 64 MiB.** A zstd RLE block regenerates 128 KiB from 4 bytes:
  a 10 KB input decoded to 327 MB before the cap existed. The cap counts every
  frame together and applies to one-shot, push and Web Streams decode alike.
  Same option name and default as the sibling `wgzip`.
- **Per-sequence bounds.** Checking block overflow only after the sequence loop
  let a 40 KB block spend 2.3 s copying into nowhere. Each sequence is now
  checked before it runs, at no measured decode cost.
- **No allocation from header fields alone.** The declared window is honoured
  as data arrives (a 27-byte frame once reserved 129 MiB); a declared content
  size is preallocated only up to `maxSize` and what the input could produce.
- **Fixed limits, not knobs.** Window and block limits come from libzstd so
  that wzstd accepts and rejects the same frames native tools do.

## Size and shape

- Decoder: ~6 KB gzipped (`wzstd` root or `wzstd/decompress`); whole package
  with every encoder ~16 KB gzipped. WASM zstd ports are hundreds of KB.
- The root export is decode-only; encoders live on `wzstd/compressFast`,
  `wzstd/compressStrong`, `wzstd/compressUltra`.
- Streaming encoders emit 128 KiB blocks as input arrives (never buffer until
  flush), omit the content size, and always carry a checksum.
- Decode is 1.13–1.31× fzstd (the pure-JS decoder it derives from) while
  verifying checksums fzstd never checks.

## Tried and rejected (see `docs/experiments.md`)

- A combined `compress(level)` entry point: rejected; tiers are separate
  subpaths so a Fast-only bundle never contains Huffman or Ultra.
- Streaming Ultra: its 8 MiB window is the wrong resident set for a stream.
- Windows above 1 MiB for Fast/Strong, long-hash in Strong, optimal parse:
  measured, too expensive for the ratio they bought.
- Dictionaries: not supported in either direction.
