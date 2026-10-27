# wzstd tests

TypeScript tests run with Node’s built-in `node:test` against the built ESM package in `dist/`.

## Run

```bash
pnpm test
```

## Files

| File                       | Coverage                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| `simple_cases_test.ts`     | Upstream fzstd fixtures (Ok, Lorem, 1M nuls)                                                     |
| `api_test.ts`              | Streaming vs one-shot, `out` buffer, multi-frame rules, error codes                              |
| `compress_test.ts`         | Fast/Strong/Ultra round-trips, Huffman emit, interop, dist subpath isolation                     |
| `checksum_test.ts`         | Digest emitted on every frame; verify-by-default; every unsafe spelling still verifies           |
| `stream_test.ts`           | Push + TransformStream encode/decode, one-shot framing pins, encode→decode pipe                  |
| `decode_no_fcs_test.ts`    | No-FCS decode: hermetic `CompressFast` plus CLI-over-a-pipe growing-buffer history               |
| `frame_header_test.ts`     | One-shot single-segment vs windowed FCS, plus streaming Fast/Strong no-FCS headers               |
| `large_window_test.ts`     | Declared-window limits in both directions; a huge declaration does not allocate                  |
| `limits_test.ts`           | `maxSize` cap and validation, per-sequence CPU bound, 128 MiB window — hand-built hostile frames |
| `literals_huffman_test.ts` | Single-stream vs 4-stream layouts, weight-header forms, 11-bit length cap                        |
| `sequence_tables_test.ts`  | Custom vs predefined FSE selection, and both sequence-code producers bounded                     |
| `fse_state_path_test.ts`   | `buildStatePath` tiling invariant at every accuracy log                                          |
| `match_cost_test.ts`       | Matches that do not pay for their own sequence are dropped                                       |
| `unguarded_reads_test.ts`  | Byte-flip / truncation / NaN-length sweeps: corrupt input yields `ZstdError` or correct bytes    |
| `zrip_cross_test.ts`       | Cross-check vs [zrip](https://github.com/paddor/zrip) (pure Rust → WASM) and host `zstd` CLI     |
| `node_zstd_cross_test.ts`  | Cross-check both directions against `node:zlib`'s zstd (C libzstd)                               |
| `external_corpus_test.ts`  | Round-trips `extra-bench-data/` when present; skips when absent                                  |

`pnpm test` is correctness only: deterministic, no perf thresholds (security DoS cases assert a throw, with at most a generous 1 s ceiling). Size baselines and perf regression checks live in `pnpm bench:check` (`scripts/bench_check.ts`).

`pnpm test` is hermetic and runs the synthetic fixtures only. `pnpm test --extra`
adds `extra-bench-data/`, and `--extra-only` runs that corpus alone — format work
(literal framing, weight headers, sequence tables, window handling) should be
checked with it before shipping.

## Supported decode (product claim)

wzstd decodes standard zstd frames from encoder levels **−8 through 19**
(C zstd–compatible band). Ultra **20–22 decode and are tested**, just outside
the exhaustively tested band; the real ceiling is the declared window
(128 MiB, libzstd's default), rejected above that with `WindowSizeTooLarge`.

## Reference codecs

- **[zrip](https://github.com/paddor/zrip)** via `@paddor/zrip` (JSR) — pure-Rust encode **−8…4** (and decode oracle).
- **Host `zstd` CLI** (optional, skipped if missing) — C encode positive levels **1…19**.

Cross tests: zrip compress → wzstd decompress; `zstd` CLI compress → wzstd decompress.
