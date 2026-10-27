# AGENTS

Conventions for this repo. Follow them for all changes.

## TypeScript

- **TypeScript 7** is the default: `typescript@^7` (native `tsc` for emit/types via tsdown). Typecheck + type-aware lint run together in **oxlint** (`options.typeAware` + `options.typeCheck`).
- **Strict, erasable-syntax only TypeScript.** Single root `tsconfig.json` (`strict`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noEmit`). Emit is **tsdown** only; type-aware lint/check uses this config.
- Prefer real types over escapes (`any`, non-null `!`).
- Never use TSX (the `tsx` runner). Run TypeScript **directly through Node** — `node file.ts`, `node --test 'tests/**/*.ts'`, `node --watch` where applicable. Type stripping is **on by default** since Node 22.18 / 23.6, so `--experimental-strip-types` is obsolete: do not add it back. Local dev therefore needs **Node ≥ 22.18** (`engines.node` stays `>=22`, which describes consumers of the emitted ESM, not this repo's scripts).
- **Erasable syntax is the contract, in all three places, and they must agree:** `tsconfig.json` sets `erasableSyntaxOnly`; oxlint enforces it type-aware (`options.typeCheck`); and Node strips rather than transforms, so anything non-erasable (enums, `namespace`, parameter properties, `import =`) is a runtime error, not just a lint failure. Never reach for `--experimental-transform-types` to make such syntax work — fix the syntax.
- Angle-bracket assertions and `import =` / `export =` are forbidden by `erasableSyntaxOnly` at `tsc`.
- Erasable-only syntax / zero-compilation via `node --watch` where applicable. This package is Node-only for tests and emits ESM for publish.

## Runtime

- **ES2022 ESM** output so the same build runs on Node 22+, Deno, Bun, Cloudflare Workers, Convex, Supabase edge, and similar hosts.
- **Node.js 22+** for local scripts/tests (stay on 22 until key platform deps allow 24/26).
- **ESM only** — no CJS, UMD, or dual packages. `"type": "module"`, `exports` with `import` + `types` only.
- Library code must not depend on Node-only builtins (`node:*`, `fs`, `Buffer` APIs). Typed arrays + standard `Error` only.

## Decoder priorities

**Correct, then durable, then performant — in that order.** The decoder is the
product's ground truth: it validates every encoder change and is what other
people's data flows through. This ordering is not a platitude, it decides real
calls that have already come up:

- A 1.03–1.08× win was **declined** because it meant weakening type guarantees
  (unchecked indexing) — and the decline was later found to rest on a **wrong
  diagnosis**. Measured against a control build (2026-08-03): dropping the
  `?? 0` is worth **1.000×**, and the gain comes from removing the _call_ to a
  helper invoked 111 times. `noUncheckedIndexedAccess` was never what we were
  paying for, and it **stays on**. What shipped instead is a split by **trust**:
  reads of the decoder's own derived structures are unguarded, reads of
  untrusted input keep the guard. The ordering held — the version that raw-read
  everything was rejected for failing open on malformed input, and it was the
  faster one. See "Unguarded reads of derived structures" in the ledger.
- The wide-read speedup **only** shipped once the invariant it needs could be
  established in one place, with the failure mode converted to `ZstdError` in
  code. The fast version that skipped that was not an option.
- Streaming decode keeps a real bounded window rather than adopting the
  one-shot growing buffer, because it does not own the output. Correctness
  first; the performance was recovered another way (amortized compaction).

Applies to `Decompress` and `decompressStream()` equally — streaming is not a
second-class path. It has its own tests (`stream_test`), and its window
behaviour is benched separately, because it diverged from one-shot once already
and nothing caught it until it was measured.

**Content checksums** (`src/xxh64.ts`) are **emitted by our encoder on every
frame and verified on decode by default.** One-shot decode takes a single
options bag: `decompress(data, opts?: { out?, checksum?, maxSize? })` — never a positional
second argument. `checksum` defaults to `true`; leaving it out, passing
`undefined`, or passing `{}` all verify, and only an explicit `false` skips the
hash. **The invariant is that you cannot skip verification by accident** — never
add a positional boolean, a separate "fast" entry point, or any spelling that
reaches the unverified path without naming `false`. `tests/checksum_test.ts`
pins every one of those spellings.

The opt-out disables **the hash only**. Structural validation — bounds, offsets,
window size, FSE accuracy, symbol ranges, frame content size, truncation before
the digest — stays on, and a change that couples them is a bug.

zrip and `node:zlib` verify unconditionally and offer no equivalent; only fzstd
skips, by never hashing at all. **Two comparison numbers, never conflated:**
`vs-fz` is our _verifying_ decode against fzstd and is the default product
claim; `nv/fz` is both sides skipping and is like-for-like. Quoting the second
as "our decode speed vs fzstd" is measuring less work — `bench:decode` prints
both, labelled, plus the cost of verification between them.

It is the only _reliable_ corruption detection the format allows, though not the
only detection: measured over 400 single-bit flips, structural checks alone catch
210 and let 190 through as **wrong bytes returned successfully**, while the
digest makes it 400 and 0. Cost is **1.12–1.24× of decode** by frame shape
(1.12× on `lvl3` and `own-Strong`, 1.15× on `own-Fast`, 1.24× on the copy-bound
`fast8`) and 0.6–2.0% of encode.

Two consequences for benching. Our own frames carry a digest, so wzstd → wzstd
exercises the checksum path rather than hiding it — which also means the
`own-Strong` row is **not a control that must hold still**, since it pays the hash
like every other row. And frames from `node:zlib`'s one-shot API carry no digest
unless asked, so that helper takes a `checksum` argument; pass `true` when the
frames are meant to exercise verification.

**Output cap.** `maxSize` (default 64 MiB, `Infinity` opts out, anything else
not a non-negative safe integer is a `TypeError`) bounds total output on all
three decode entry points — the same option name and default as wgzip. Never
let a header field size an allocation past it, and never move the
per-sequence bound in `rzb` back behind the loop: that is what kept CPU
proportional to output (`tests/limits_test.ts`).

**`docs/experiments.md` has a "Will not do" section.** Those are design
commitments, not open tradeoffs — read it before "fixing" a restriction.

## Package layout

- Source: `src/` — `compress/fast.ts`, `compress/strong.ts`, `compress/ultra.ts`, `compress/shared.ts` (`EncodeStream` + packing), `decompress.ts`, `stream.ts` (decode `TransformStream` only), `index.ts` (decode-only root — encoders are subpath-only)
- Emitted library: `dist/` (gitignored; produced by `pnpm build` → **tsdown**); entries: `index`, `compressFast`, `compressStrong`, `compressUltra`, `decompress`, `decompressStream` (package subpaths match entry names). No `compressL1` / `compressL3` aliases.
- Tests: `tests/` using Node’s built-in `node:test` + `node:assert/strict`
- **Decode support (product claim):** standard zstd frames from encoder levels **−8 through 19** (C zstd–compatible band). Ultra **20–22 decodes and is tested**, just outside the exhaustively tested band; the real ceiling is the **declared window**, rejected above **128 MiB** (`WindowSizeTooLarge`) — libzstd's default decoder limit (`ZSTD_WINDOWLOG_LIMIT_DEFAULT` 27), a fixed constant, not an option; single-segment frames count their content size as the window, as libzstd streaming does. Note that an under-claiming limit is still a wrong limit and can sit undetected for a long time, because nothing fails — `tests/large_window_test.ts` therefore pins the limits **in both directions**. Keep README, this file, and `package.json`'s description in step when they change.
- **Frames and the optional output buffer:** `decompress(data)` — the form nearly everyone uses — decodes **any number of concatenated frames** and joins them. Passing `{ out }` in the options bag restricts input to a **single data frame**: each frame writes from offset 0 of its own output, so a second would overwrite the first, and that is rejected with `ZstdError`. **Skippable frames stay legal with `out`** (they produce no output to place) — that matters because they are the common multi-frame case in the wild, used by the seekable-zstd format and for embedded metadata, whereas genuinely concatenated data frames are rare. Do not "fix" the restriction by making `out` multi-frame-capable without also deciding where frame _n_ writes; and keep skippable frames working, since narrowing that would break seekable-zstd readers. `api_test` pins all four combinations.
- **Streaming decode window:** `Decompress` keeps a real bounded sliding window (it does not own the output, so it cannot use the one-shot growing-buffer trick). Blocks are appended at `st.e` in a buffer that starts at `min(window, 2 × st.m)` and **grows by doubling toward `window + 8 blocks` only as data arrives**, compacting once there — `st.g` holds the history length to retain. Both halves are load-bearing: shifting the whole window per block made streaming decode **0.22× of one-shot** on a level-19 frame (8 MiB declared window), while allocating the declared window up front let a 27-byte frame reserve 129 MiB, because the declaration is attacker-controlled and need bear no relation to the payload. Never restore a per-block `copyWithin` of the full window, and never size a buffer from a header field before the data justifying it has arrived.
- **Web Streams:** `decompressStream()` (`src/stream.ts`, on the decode-only root and the `wzstd/decompressStream` subpath) wraps `Decompress` in a `TransformStream` and measures at 0.91–1.05× of the push API — the adapter is free. Fast and Strong have matching compress factories (`compressFastStream`, `compressStrongStream`) next to their push classes; Ultra stays one-shot. `TransformStream` is a **host API, not an ES2022 feature**, so the language target says nothing about its availability; it is referenced **lazily inside the factory** so importing the root still works where it is absent. Never write `class X extends TransformStream` — that evaluates the global at module load and breaks the import for everyone. A compress stream that buffered until flush is forbidden — `EncodeStream` emits 128 KiB blocks as they fill.
- **Streaming encode:** `CompressFast` / `CompressStrong` (no Ultra). One instance is one frame. Frames omit FCS, declare the strategy window (1 MiB), and always carry a content checksum. The matcher keeps a real bounded window (starts at `2 × 128 KiB`, grows by doubling toward `window + 8 blocks`, compactifies by dropping history past the window and rebuilding the hash chain from what remains — the linked chain is indexed by position, so it cannot be remapped across a shift). Never restore a buffer-until-flush wrapper, and never allocate the window before the data justifying it has arrived. One-shot `compressFast` / `compressStrong` still always emit FCS.
- **Decoder output buffer:** one-shot `decompress` decodes a frame into a single buffer and uses that buffer as its own match history (`st.w = ob`, `st.e = st.y` per block). When Frame_Content_Size is present the buffer is sized exactly; when it is absent it starts at `2 × st.m` and **grows by doubling**. Never reintroduce the per-block window `copyWithin` — the shift is O(declared window) per block, so a level-19 frame (8 MiB window) paid ~512 MB of memmove per 4 MB of output. Streaming `Decompress` is the exception and keeps a real bounded window, since it does not own the output. **Frames without FCS are the common case in the wild** (`zstd` reading a pipe, any streaming producer). One-shot `compressFast` / `compressStrong` / `compressUltra` still always emit FCS; `CompressFast` / `CompressStrong` emit the pipe shape (no FCS, explicit window). Benching only against one-shot own frames hides the no-FCS decode path — always bench CLI `-3` **and** `-19` frames too.
- **Encode support (product claim):** separate exports only — **`compressFast`**, **`compressStrong`**, **`compressUltra`** (no level param, no combined multi-level `compress`, no L1/L3 aliases). Fast and Strong also ship **`CompressFast` / `compressFastStream`** and **`CompressStrong` / `compressStrongStream`**. Ultra is one-shot only. **Ultra is a research experiment that never paid off** (~0.6 pts over Strong on the synthetic total, slower): keep it exported, label it experimental, and never recommend it in the README or the skill — removing it is the owner's call. These are product tiers, not stock zstd levels 1/3. Fast = shallow chain (depth 4, derived patience) + **17-bit primary hash / 4-slot row** + greedy + raw/RLE + prefer + **explicit rep probes** + **incompressible skip (`searchSkipShift` 8)** — no Huffman, no long-hash; Strong = chain 20 + **hash 17** + **patience 4** + nullPatience 24 + pure greedy + Huffman + prefer + **explicit rep probes** (no long-hash — lim4 costs ~33% encode for ~0.5 pts raw on the synthetic total); Ultra = chain 24 / patience 2 + secondary 8-byte long-hash (lim4) + **8 MiB** window + the same explicit rep probes. All three emit valid rep-offset codes (1–3) when the distance matches the rep set and prefer them when scoring. Shared multi-seq + predefined FSE in `compress/shared` + `compress/block`. Fast must not import Huffman; Ultra has its own package entry so tree-shaking never pulls it into a Fast-only consumer. `pnpm bench:summary` compares Fast/Strong/Ultra vs zrip WASM, fzstd and `node:zlib` (size + encode/decode).
- **Match cost model:** matches are scored in bits saved (literals replaced − sequence cost), not in raw length, and are dropped when they do not pay for their own sequence. `MatcherConfig.huffmanLiterals` picks the literal price: Fast raw (8 bits), Strong the block's order-0 entropy. Distance is charged `max(0, code − offsetSurchargeFrom) × offsetSurcharge16` (Strong **72 from code 3**, Fast **0**) — the two tiers genuinely want opposite settings, so never tune it as one global constant. Changing `SEQ_OVERHEAD_BITS16` / `LITERAL_COST_MARGIN16` / the surcharge changes output sizes on every payload — re-run `pnpm bench:encode --extra` and re-tune together.
- **The offset surcharge is a locality prior, not a cost estimate.** Measured against real FSE output it over-prices by ~2×, and ~3× at the far end. Pricing codes by their _actual_ frequency — the two-pass idea that looked obvious — is **14–17% worse**, because the true cost is non-monotonic in distance (it falls again at codes 16–19, since far codes are common), and monotonicity is the entire product: it is what keeps the repeat chain that carries **85% of sequences** intact. Magnitude is nearly free (2× the charge moves size <1%); shape is everything. Full data in `docs/experiments.md` — read it before touching the cost model.
- **Window:** Fast/Strong use `WINDOW_SIZE` **1 MiB**; Ultra uses **8 MiB** (one greedy pass — no multi-arm). Blocks stay at 128 KiB. **One-shot** frames at or below the strategy window are single-segment (the decoder derives its window from FCS); larger one-shot frames carry an explicit window descriptor pinned to that strategy's window, with FCS still present. Single-segment above the window is not just wasteful — it declares `Window_Size = Frame_Content_Size`, and zstd's default decode limit is 2²⁷, so a single-segment frame over **128 MiB is rejected by the stock `zstd` CLI** ("Window size larger than maximum"). **Streaming** Fast/Strong always omit FCS and always declare the 1 MiB window — the pipe shape. `tests/frame_header_test.ts` pins both one-shot forms, the Fast/Strong boundary, and the streaming header. Changing any of this needs the full-file interop check against zrip _and_ the host `zstd` CLI, not just our own decoder. One-shot hash chains are sized to the input (`chainSlots`); a continuing stream sizes to the window, a single-block flush sizes to the payload.
- **Literal sections:** Strong/Ultra emit single-stream Huffman under the 1023-byte cap and the 4-stream + jump-table layouts above it (`Size_Format` 01/10/11). Code lengths are capped at 11 bits. Weight headers come in two forms — direct 4-bit (≤ 128 weights) and FSE-compressed — and the smaller wins; both must stay reachable, since dropping either silently disables Huffman for a whole class of input (the FSE form for any byte > 128, i.e. all non-ASCII). Tests must cross-check new literal framing against **both** zrip and the host `zstd` CLI — a mis-shifted size field still round-trips through our own decoder for some inputs.
- **Sequence tables:** `compress/fse-tables` (Strong/Ultra only, injected as `SequenceTableSelector`) prices a custom FSE table against the predefined one per code stream per block; Fast passes `usePredefinedTables` and must never pull that module in — `compress_test` asserts the Fast + shared dist chunks contain none of its markers. Accuracy log ceilings are fixed by the format: 9 for LL/ML, 8 for OF. RLE (mode 1) is intentionally not implemented — mode 2 over a single symbol already costs zero bits per sequence, and the mode never won on the bench corpus. Cost comparison must charge only `n-1` state transitions for `n` sequences; charging `n` makes tiny frames pick a table description that does not pay for itself. **Decoder side:** every sequence code is bounded to its code space at its source — `rfse` rejects a table description above LL 35 / ML 52 / OF 31, and Compression_Mode 1 (RLE) range-checks its single raw byte, which is a separate producer that never passes through `rfse`. Those bounds are what let `llb`/`llbl`/`mlb`/`mlbl` be exactly 36 and 53 entries and be read unguarded; narrowing a table further or widening a code space has to move with them. `sequence_tables_test` pins both entry points against hand-built frames that the host `zstd` CLI vouches for.
- **FSE state paths:** `buildStatePath` relies on the tiling invariant — for any symbol, its states' `[baseline, baseline + 2^numBits)` ranges partition `[0, tableSize)` exactly — so the backward walk is deterministic and needs no search. `fse_state_path_test` checks that property directly against random distributions; keep it green if you touch `buildFseDecodeTable`.
- **Bench corpora:** main set + optional extra, **never pooled**. **Main set (default):** (1) **In-repo synthetic** — `tests/helpers/corpus.ts`, ~78 payloads / ~141 MB (ndjson/csv/prose/far-echo + fixed `randomBytes` xorshift); quote as _in-repo synthetic_. Keep it representative on its own: an ASCII-only corpus is what hid the Huffman weight-header cliff. (2) **Silesia subset** — four pinned real files (dickens, xml, osdb, x-ray; ~34 MB), always loaded with the main set; **downloaded on demand** into gitignored `bench-data/silesia/` with size + SHA-256 pins in `scripts/helpers/silesia.ts`. Provenance: Silesia compression corpus, Sebastian Deorowicz, Silesian University of Technology (https://sun.aei.polsl.pl/~sdeor/index.php?page=silesia). Not full Silesia. **Extra** — `extra-bench-data/` or `WZSTD_CORPUS_DIR`, your data; opt-in `--extra`. **Tests must skip when extra is absent; benches must error** if extra is missing when asked or if silesia download/verify fails. Selection lives in `scripts/helpers/corpora.ts`. Profile with `pnpm bench:profile-corpus`.
- **Benchmarking discipline:** decoder work uses `pnpm bench:decode` (encoder-free), encoder work `pnpm bench:encode` (decoder-free). **`bench:summary` encodes first, then decodes** so encoder numbers are not blocked on frame build / decode isolation. **Never accept or reject a decoder change from a same-process sweep** — a same-process sweep carries ±15% noise and will invent signal; run each variant in its own process and take a median. All three benches do that themselves via **`scripts/helpers/isolate.ts`**. **Encoder work reductions: count probes first** (`pnpm bench:match-stats`, `withMatchStats`) — wall-clock between processes exceeds ±40% on Strong. **Matcher size A/B:** `pnpm bench:ab` (`--vs key:value` or `--suite patience|nearby|ultra-levers`) — build once, no ad-hoc scripts; use `--stats` for probes. Product encode MB/s still needs isolated `bench:encode`. **Decoder A/B against cached frames:** `pnpm bench:ab-decode` (own-Fast / own-Strong / `--fast=8` / lvl3 under `bench-data/decode-cache/`; rebuild `dist` between variants). `docs/experiments.md` records every attempt — **read it before trying an optimization**, and append to it after. Open follow-ups (e.g. `sinceImprove` semantic fix) live in `HANDOFF.md`.
- **Test-run hygiene:** the full suite finishes in **well under a minute** on this machine, so a run still going after a few minutes is wedged, not slow — check CPU before waiting on it (a real loop burns a core; a deadlock sits at ~0%). The known way to wedge it: piping the runner's output (`| grep`, `| tail`) while the external-corpus tests are doing real `zstd -19` work, especially with another `pnpm` command running alongside. Prefer running the suite unpiped, and one at a time. Killing a run mid-test can also **strand a `zstd` child** — `tests/helpers` drives the CLI through `spawnSync` with piped stdin, and the child outlives a parent that dies during the call. Look for leftover idle `node --test` / `zstd` processes before concluding anything about a hang.
- Cross-validation: `@paddor/zrip` (pure Rust zstd → WASM; see [paddor/zrip](https://github.com/paddor/zrip)) for negative/fast encode (−8…4); optional host `zstd` CLI for positive levels through 19. Encoder output is also decoded by zrip / host `zstd` when present.

## Lint / format (Oxc)

- **oxlint** + **oxfmt** (not Biome). Config: `.oxlintrc.json`, `.oxfmtrc.json` — `--init` defaults, plus oxlint `options.typeAware` / `options.typeCheck`, a `node:test` allowlist on `no-floating-promises`, `no-restricted-globals` on `src/**`, and `no-unused-expressions` off in `src/decompress.ts`. Do not re-add extra recommended rules or house style.
- Type-aware rules + TypeScript diagnostics via **oxlint-tsgolint v7** (`options.typeAware: true` and `options.typeCheck: true`; [stable as of 2026-07-21](https://oxc.rs/blog/2026-07-22-type-aware-linting-stable)). Version scheme tracks TS 7 (e.g. `7.0.2001` ↔ TS 7.0.2). One command — **`pnpm lint`** / **`pnpm check-types`** — runs both so nothing is skipped.
- oxfmt defaults (spaces, `printWidth` 100, double quotes).
- Library-only — no React/Vue/Next plugin surface unless needed.
- Prefer `pnpm check` / `pnpm fmt` over ad-hoc tools. New code outside `src/decompress.ts` follows the defaults.

## Build

- **tsdown** (Rolldown) — library bundler used by the Vite+ stack. Config: `tsdown.config.ts`.
- Output: **ESM-only**, `target: es2022`, `platform: neutral`, **minified** + `.d.ts`, no sourcemaps (not shipped in the package).
- Do **not** emit CJS/UMD. Typecheck is via oxlint (`pnpm lint` / `pnpm check-types`), not a separate `tsc` emit.
- Full **Vite+** (`vp`) is optional globally; this repo uses the same pieces as deps (`oxlint` / `oxfmt` / `tsdown`) without requiring the unified CLI.

## Numeric range analysis (Freerange)

- Dev tool: [`@chenglou/freerange`](https://github.com/chenglou/freerange) — static range analysis for TypeScript numbers.
- Commands: `pnpm fr` / `pnpm fr:audit`. The decompression core is largely outside freerange’s analyzable subset.

## Commands

```bash
pnpm install
pnpm check         # fmt:check + oxlint (type-aware + typeCheck)
pnpm fmt           # oxfmt
pnpm lint          # oxlint (type-aware rules + TS diagnostics)
pnpm check-types   # alias of lint (same single gate)
pnpm fr            # freerange
pnpm build         # tsdown → dist/ (ESM min + d.ts)
pnpm test                # build + node --test (needs Node >= 22.18); synthetic fixtures only
pnpm test --extra        # + round-trip extra-bench-data/ (opt-in; skips if absent)
pnpm test --extra-only   # extra corpus alone
pnpm bench:decode       # decode-only, vs fzstd + zrip, over our / fast8 / lvl3 / lvl19 frames
pnpm bench:ab-decode    # cached-frame decode A/B (no zrip / lvl19); --silesia-only
pnpm bench:encode       # encode-only: Fast/Strong/Ultra ratio + speed, --peers / --lvl19
pnpm bench:summary      # both sides (encode first, then decode) — the quotable table
pnpm bench:check        # perf + size regression checks (generous limits; not in pnpm test)
pnpm bench:match-stats  # deterministic Strong probe counters (+ --sweep for nearby levers)
pnpm bench:ab           # encode size A/B: --vs key:value | --suite patience|nearby|ultra-levers
pnpm bench:ultra-levers # wrap of bench:ab --suite ultra-levers
```

**Encode A/B.** Matcher lever comparisons go through `pnpm bench:ab` (build once) —
not one-off node scripts. Examples: `pnpm bench:ab --vs patience:1 --stats`,
`pnpm bench:ab --suite patience`, `pnpm bench:ab --only rep-friendly --vs patience:1`.
**Decode A/B.** Isolated timing against cached frames: `pnpm bench:ab-decode`
(`--silesia-only`, `--rebuild-cache`). Open notes live in `HANDOFF.md`.

**Bench flags.** Shared by benches (`scripts/helpers/corpora.ts`): default is the **main set** (synthetic + silesia); `--silesia-only` isolates the Silesia half; `--extra` / `--extra-only` for `extra-bench-data/`; `--limit N` takes the first N payloads per corpus (smoke test only — it says so); a positional number sets the per-payload speed cap; `WZSTD_CORPUS_DIR` points elsewhere. Encoder-side (`scripts/helpers/encoders.ts`, shared by `bench:encode` and `bench:summary`): `--peers` adds zrip and `node:zlib` — `bench:summary` always has them, so it does not take the flag — `--lvl19` adds the `node:zlib -19` ratio reference, and `--no-ultra` drops Ultra. Everything composes in any order. **Parsing is strict**: a flag a bench does not define is an error, never a silent no-op. Asking for extra when missing, or a silesia download/verify failure, is an error.

**`pnpm test` is hermetic by default.** It runs the synthetic fixtures only. `extra-bench-data/` is the user's own data, so making the correctness suite depend on it would mean the same command means different things on two machines — and it is the part that drives `zstd -19` through `spawnSync`, which is how the runner has been wedged. **`pnpm test --extra` (or `--extra-only`) runs it, and format work (literal framing, weight headers, sequence tables, window handling) must be checked with it before shipping** — that is exactly where fixture-only coverage has missed things. Same flag names as the benches.

**Writing compression levels: never a bare minus.** `zstd -19` is level **19** and `zstd --fast=8` is level **−8**, so "CLI −19" and "CLI −8" read as the same sign and mean opposite things — they did, in these docs, for several sessions. Write positive levels as `level 19` (or `lvl19` in a bench column) and the negative band by its actual CLI spelling, `--fast=8` (or `fast8`). A range with the word "through" is fine as-is (`−8 through 19`).

## Comparisons

`pnpm bench:decode` carries two comparison columns and they are not the same kind of thing:

- **fzstd** is the peer: pure JS, and what `src/decompress.ts` derives from. It **does not verify the content checksum** — it skips the 4 trailing bytes without hashing. So the `vs-fz` column compares our decoder **with verification on** against one that cannot verify at all, and a value at or above 1 means we are **at parity or faster while doing strictly more work**. State it that way; "faster than fzstd" alone undersells it and invites a false comparison.
- **zrip** is Rust → WASM, and `node:zlib` is C libzstd. Both are ceilings, not peers. Being slower than them is expected and is not a finding.

**`vs-fz` is the median of per-payload ratios, never the ratio of the medians**,
and on this corpus the two differ by about **5 points** — 1.06× against 1.12×.
They are not interchangeable roundings of one number: the ratio of medians
divides two figures that come from _different payloads_ (our median payload and
fzstd's median payload need not be the same file), so it answers no question
anyone asked. Only the median of per-payload ratios answers "on a typical
payload".

This is not hypothetical. A recorded product claim of **1.11×** turned out to be the ratio of medians written into the median-of-ratios cell; three quiet runs of the unchanged code put the real figure at **1.06×**. Two tells, both cheap to check before publishing a ratio:

- On this corpus the median of ratios sits **below** the ratio of medians in every honest run. A ratio that lands above it, and lands almost exactly _on_ it, is the substitution rather than a result.
- Cross-check the ratio against the A/B that produced it. A claim that moves 11% on changes measured at ~1% is arithmetic, not a speedup.

Read the ratio off the bench's own `vs-fz` cell. Do not recompute one from the absolute median columns printed beside it.

## Provenance

Decompression core is based on [fzstd](https://github.com/101arrowz/fzstd) (MIT). Keep the license attribution when changing `src/`.
