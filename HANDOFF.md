# HANDOFF

Current product orientation. Absolute MB/s is machine-local — re-run benches.
A/B history lives in `docs/experiments.md`.

## Product

| Export                                           | Role                                                                                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `compressFast`                                   | One-shot Fast. FCS + checksum. Chain 4, hash 17 / row 4, skip-shift 8, raw lits, 1 MiB                                                          |
| `CompressFast` / `compressFastStream`            | Streaming Fast. No FCS, explicit 1 MiB window, checksum. Real 128 KiB blocks                                                                    |
| `compressStrong`                                 | One-shot Strong. FCS + checksum. Chain 20, patience 4, Huffman + FSE, 1 MiB                                                                     |
| `CompressStrong` / `compressStrongStream`        | Streaming Strong. Same framing as streaming Fast                                                                                                |
| `compressUltra`                                  | One-shot only. Chain 24 / patience 2 + long-hash lim4 + 8 MiB                                                                                   |
| `decompress` / `Decompress` / `decompressStream` | Verify checksums **by default**; only `{ checksum: false }` skips the hash. Output capped at 64 MiB (`maxSize`); windows above 128 MiB rejected |

Public names only — no `compressL1` / `compressL3` aliases, no combined `compress(level)`, no Ultra stream.

Subpaths are the isolation: `wzstd/compressFast`, `wzstd/compressStrong`, `wzstd/compressUltra`, `wzstd/decompress`. The root (`wzstd`, `src/index.ts`) is **decode-only**: `decompress` / `Decompress` / `ZstdError` plus `decompressStream`. That factory lives in `src/stream.ts` and is also `wzstd/decompressStream`; `wzstd/decompress` is `src/decompress.ts` only. Error types ship with every decode entry. There is no barrel that re-exports the encoders; `tests/compress_test.ts` pins the root's export list.

One-shot Fast/Strong/Ultra always write FCS. Streaming Fast/Strong write the pipe shape (no FCS). Both always write the digest. A stream that buffers until flush is not a stream.

Encode is judged against **C zstd** (`node:zlib` level 3) for ratio and as a
speed ceiling. Decode is judged against **fzstd** (`vs-fz`, we verify) with
**zrip** as the WASM ceiling. fflate gzip is a cross-format bench row, not the
product claim. Ultra stays frozen unless a Fast/Strong change inverts the
Ultra ≤ Strong size order.

## Standing numbers

Isolated `bench:encode --no-ultra` and `bench:decode` on the main set. Quote
**ratios** and **vs-fz / zrip/us**, not these MB/s, on another machine.

**Encode — in-repo synthetic**

| encoder        |  ratio |  MB/s |
| -------------- | -----: | ----: |
| wzstd Fast     | 0.1885 |  49.1 |
| wzstd Strong   | 0.1486 |  36.8 |
| fflate gzip    | 0.2044 |  69.8 |
| node:zlib gzip | 0.2034 | 184.8 |

**Encode — Silesia subset**

| encoder        |  ratio | saved |  MB/s |
| -------------- | -----: | ----: | ----: |
| wzstd Fast     | 0.5080 | 49.2% |  25.8 |
| wzstd Strong   | 0.4853 | 51.5% |  14.2 |
| fflate gzip    | 0.4227 | 57.7% |  39.6 |
| node:zlib gzip | 0.4237 | 57.6% |  68.9 |
| node:zlib -3   | 0.4079 | 59.2% | 299.3 |

Strong beats C zstd-3 on synthetic ratio (0.1486 vs 0.1497) and trails fflate on
Silesia (0.485 vs 0.423). That hole is search quality C zstd has. Worst Silesia
payload for everyone: **x-ray**.

**Decode** — `vs-fz` is the product claim (we verify; fzstd never hashes). Median
of per-payload ratios, never the ratio of medians.

| corpus    | wzstd lvl3 | fzstd |     vs-fz |     nv/fz |
| --------- | ---------: | ----: | --------: | --------: |
| synthetic |      399.9 | 337.0 | **1.31×** | **1.73×** |
| Silesia   |      246.9 | 229.5 | **1.13×** | **1.21×** |

Main-set `vs-fz` is not the extra-corpus 1.06× in the ledger (different files).

## Do not reopen

These are priced, not open tradeoffs. Conditions to revisit live in the ledger.

- **Strong chain 16 / 12, or hash 17 + `rowBits` 3** — `mixed-*` +120–186%. Hash
  17 keeps `chainLimit` 20 and `rowBits` 5. The contiguous ring does not
  activate at that table size (`slots < hashSize × row`); the linked chain is
  the measured layout.
- **Fast hash 16** — size and probes both worse. 17 is the knee; 18/19 grow
  memory and regress small synthetic payloads.
- **Fast chain 5/6** without a wider row — no-op (the 4-slot row already caps
  the walk).
- **Strong long-hash, binary tree, optimal parse, window > 1 MiB** — the
  remaining Silesia-ratio levers, already too expensive.
- **Decoder load-side reshapes** — packed tables, bit accumulator, `dhu`
  pairing, r32 word cache, overlapping-chunk `copyWithin`, distance-1 `fill`,
  skip-zero extra-bit loads. Work-removed pays; work-traded and per-sequence
  branches do not. A next decoder attempt needs no extra loop and no
  per-sequence branch.
- **Streaming Ultra, or a compress `TransformStream` that buffers until flush.**
  Ultra's 8 MiB window is the wrong resident set. Buffer-until-flush is a
  stream in name only — `EncodeStream` already emits blocks as they fill.
- **Remapping the encode hash chain across a window shift.** The linked chain
  is indexed by `pos & chainMask`. Compact rebuilds from retained history.
  Pass the matcher a view of `[0, end)`, never the allocation.

## Open

- **`sinceImprove` semantic fix** (optional, not a product win). Count only
  non-improving probes so `patience: 1` matches the prose. Re-tune historical
  patience A/Bs if done (`pnpm bench:ab --suite patience --stats`).
- **Silesia vs fflate** is still ~6 pts of ratio. Closing it means a lever in
  "Do not reopen."

## Commands

```bash
pnpm check
pnpm test                 # synthetic only (hermetic)
pnpm test --extra         # + extra corpus if present
pnpm fuzz --iters 2000    # seeded differential fuzz vs node:zlib; --seed/--start replay
pnpm bench:encode --no-ultra          # Fast/Strong + fflate + host gzip + node zstd -3
pnpm bench:encode --wzstd-only --encoder fast
pnpm bench:encode --no-ultra --silesia-only
pnpm bench:decode
pnpm bench:ab-decode --silesia-only   # cached frames; rebuild dist between variants
pnpm bench:summary        # encode first, then decode
pnpm bench:match-stats
pnpm bench:ab --vs … --stats
pnpm build
```

Main set is in-repo synthetic + pinned Silesia, **never pooled**. Quote sections
by name. `--extra` is your data. Re-check both corpus halves after any matcher
change; synthetic alone hid the Silesia ratio hole.

## Encode A/B

Size and probes are deterministic. Wall-clock for product speed claims is
`pnpm bench:encode` (isolated children).

```bash
pnpm bench:ab --vs patience:1
pnpm bench:ab --vs patience:1 --vs nullPatience:12 --stats
pnpm bench:ab --suite patience
pnpm bench:ab --suite nearby --stats
pnpm bench:ab --base fast --vs searchSkipShift:6 --stats
pnpm bench:ab --only rep-friendly --vs patience:1 --stats
pnpm bench:ab --vs patience:1,nullPatience:12
```

## Decode A/B

`pnpm bench:ab-decode` stages own-Fast / own-Strong / `--fast=8` / lvl3 frames
under `bench-data/decode-cache/` and times `dist/` against them. No zrip, no
level 19. Rebuild `dist` between variants. `--rebuild-cache` recodes the frames.

## Patience

Strong post-hit budget is **`patience: 4`**; Ultra is **2**. The counter ticks
on the improving probe itself, so `patience: 1` is first-hit-final and
regresses `rep-friendly-*` / `mixed-*` / `geojsonl-*`. `nullPatience` 24 and
`lazyDepth` 0 are orthogonal and stay.

Do not paper over `rep-friendly-*` with Strong long-hash or a larger Strong
window.

`rep-friendly-*` stresses post-hit patience. `farecho-*` / `longrange-*` need
Ultra window + long-hash. Workload map: `docs/experiments.md`.

## Still true

- Decoder: correct → durable → performant.
- Checksums verify by default; only `{ checksum: false }` skips the hash.
- vs-fz = median of per-payload ratios while we verify.
- Isolated benches for any peer speed claim.
- Extra corpus is opt-in. Never pool corpora.
- Streaming Fast/Strong is real (blocks as they fill). Ultra is one-shot.
- oxlint / oxfmt are the `--init` defaults (spaces, printWidth 100) plus
  typeAware / typeCheck. Do not re-add house style or extra recommended rules.

## Where to look

| Topic                           | Source                                                |
| ------------------------------- | ----------------------------------------------------- |
| Product claims / conventions    | `AGENTS.md`, `README.md`                              |
| Fuzz harness                    | `scripts/fuzz.ts`                                     |
| Package `exports` / entries     | `package.json`, `tsdown.config.ts`, `src/index.ts`    |
| Experiment ledger               | `docs/experiments.md` (end: Current product snapshot) |
| Matcher + `EncodeStream`        | `src/compress/shared.ts`                              |
| Shipped knobs + stream wrappers | `src/compress/fast.ts`, `strong.ts`, `ultra.ts`       |
| Decode stream adapter           | `src/stream.ts`                                       |
| Encode A/B                      | `scripts/helpers/ab_encode.ts`                        |
| Decode A/B                      | `scripts/ab_decode.ts`                                |
| Silesia pins                    | `scripts/helpers/silesia.ts`                          |
| Encode roster                   | `scripts/helpers/encoders.ts`                         |
