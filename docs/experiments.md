# Experiment log

Every optimization attempt, what it measured, and whether it stayed. The point
is to **not repeat work** — before trying something, check whether it is already
here. If it is listed as rejected, only revisit it under the stated condition:
a genuinely different implementation, or in combination with something that was
not present when it was measured.

Conventions used below:

| Status       | Meaning                                                  |
| ------------ | -------------------------------------------------------- |
| **Adopted**  | In the shipped code today                                |
| **Rejected** | Built and measured, then removed — do not rebuild as-is  |
| **Declined** | Analyzed to an upper bound that did not justify building |
| **Open**     | Not yet attempted                                        |

**Numbers are only comparable within a single commit.** The bench corpus grew
several times (non-ASCII payloads, binary payloads, then a real GeoJSONL corpus),
so absolute totals move for reasons unrelated to the encoder. Every figure below
is a before/after pair measured in one run. Never compare a total in one row
against a total in another.

> **Results here are relative on purpose.** Entries state percentages, ratios and
> before/after pairs rather than absolute byte totals, because totals do not
> survive the things that move them: the extra corpus is re-profiled when its
> files change, and every frame carries a 4-byte content checksum. An absolute
> total from an older corpus cannot be reproduced and would read as current, so
> it is not recorded.
>
> Current totals live in one place — `pnpm bench:summary` — and the standing
> figures are in `HANDOFF.md`. The extra corpus inventory is under "Extra corpus
> content profile" below.

---

## Encoder — adopted

### Match cost model in bits saved

`src/compress/shared.ts` · commit `6b127be`

Matches were scored `length*16 - log2(distance)` and accepted at any length ≥ 4.
On literal-heavy input that takes chance 4-byte matches at long distances, where
the sequence costs more bits than the bytes it covers — `low-entropy-50k` spent
28,188 of its 41,018 B on 8,806 such sequences.

Now a match is scored by the bits it actually saves: literals replaced minus
sequence cost (per-sequence FSE state, offset bits, match-length bits), and is
dropped when it does not pay for itself. `MatcherConfig.huffmanLiterals` sets the
literal price — L1 raw 8 bits, L3 the block's order-0 entropy.

> `low-entropy-50k` 41,028 → 23,654 B (under zrip level 3's 26,051); `mixed-200k`
> 29,944 → 26,018; `mixed-256k` 39,564 → 34,222; `json-lines-500` 3,632 → 2,909.

A block where nothing pays for itself now emits a valid zero-sequence compressed
block rather than falling back to raw, so literal-only blocks still get Huffman.

### Offset surcharge (`MatcherConfig.offsetSurcharge16`)

`src/compress/shared.ts` · commit `963d325`

Charging an offset only its literal `log2(distance)` extra bits under-prices
distance: a far, rare offset code also widens the offset FSE distribution and
displaces the rep-offset chain. A flat extra charge per offset bit pulls the
parse toward near and repeat offsets — **~15% on real data**, at either window
size.

**L3 = 52, L1 = 0.** The two levels genuinely want opposite settings, because
with L1's raw 8-bit literals a rejected match is pure loss. Tuning it as one
global constant cost L1 **17%**. The L3 response is flat from ~32 to 64, so 52
sits mid-plateau rather than at the measured minimum of a nine-file corpus.

**Superseded** by the threshold form below (L3 = 72 from code 3). What this
entry got right is that the charge is worth ~15%; what it got wrong is _why_ —
see "What the offset surcharge actually is".

### Offset surcharge threshold (`MatcherConfig.offsetSurchargeFrom`)

`src/compress/shared.ts`

Charging from offset code 0 taxes the codes that carry the parse: **85% of
sequences use codes 0–1**, the repeat offsets. Exempting the bottom of the code
range and steepening above it is worth **−1.50% total / −1.52% on real data**
for one array lookup — the same lookup the flat form now does.

**L3: `max(0, code − 3) × 72`.** Neighbours (3, 68) and (3, 76) both measure
−1.4%, so 72 is mid-ridge rather than a fitted point. Threshold 5 and above
loses; slope past ~88 loses at every threshold. L1 keeps slope 0 and is
byte-identical before and after.

**Encode cost: none, established by counting rather than timing.** The commit
claimed "unchanged, inside noise" from a single bench run, which was not
evidence — that run's _zrip_ column had moved 8× on one row, so it was
contaminated. Two wall-clock A/Bs then disagreed outright (one process per
variant, median of 5, whole files): the first put the new setting 10–16% slower,
the second 18–68% faster, with a 0.69–3.15 MB/s spread _within_ one process on
the same payload.

Wall clock could not resolve it, so count the work instead. Same input
(`school_district-ak`), counters on `bestMatchAt` calls, chain hits, and matches
accepted:

| setting          | bestMatchAt calls |         chain hits | matches accepted |
| ---------------- | ----------------: | -----------------: | ---------------: |
| from 0, slope 52 |           797,608 |         17,397,632 |          106,594 |
| from 3, slope 72 |   793,568 (−0.5%) | 17,339,908 (−0.3%) |  112,886 (+5.9%) |

Work-neutral. It accepts **5.9% more matches** while making _fewer_ probes,
because a longer match advances the parse further and skips positions — which
also refutes the natural hypothesis (that cheaper near matches would fire the
lazy look-ahead at more positions, since it only runs when a match was found).

**Method note for the L3 throughput work.** This machine's wall-clock variance
on whole-file encodes exceeds ±40% between processes, which is far larger than
any plausible single optimization. Deterministic counters answer "does this do
less work?" exactly and take seconds; use them to triage, and reserve timing for
confirming a change that already shows a work reduction.

### What the offset surcharge actually is

`docs/experiments.md` — **read this before "improving" the cost
model**

The planned next step was a two-pass parse: collect real offset-code
frequencies, re-price each code by what it truly costs, re-parse. It was
expected to beat a flat charge "worth ~15% for something that crude". It does
not. It is **much worse**, and the reason generalises.

Harvested from every block of the whole corpus (1.94M sequences), what an offset
code really costs versus what the flat model charges:

| code | share | true (extra + symbol) | model charges |  over |
| ---- | ----: | --------------------: | ------------: | ----: |
| 0    | 58.5% |             0.77 bits |     0.00 bits |     — |
| 1    | 26.9% |                  2.90 |          4.25 | 1.47× |
| 5    |  4.3% |                  9.55 |         21.25 | 2.23× |
| 12   |  0.4% |                 20.14 |         51.00 | 2.53× |
| 17   |  1.6% |                 22.99 |         72.25 | 3.14× |
| 19   |  1.0% |                 25.72 |         80.75 | 3.14× |

The model over-prices by **2.1× on average and 3.1× at the far end**. Feeding it
real frequencies, measured on whole payloads:

| model                                     | size vs flat |
| ----------------------------------------- | -----------: |
| flat per bit (current)                    |            — |
| **true measured cost**                    |   **+14.1%** |
| true shape, rescaled to equal magnitude   |   **+17.1%** |
| flat charge per sequence, equal magnitude |       +30.3% |
| flat 32/bit                               |        +1.0% |
| flat 64/bit                               |        +0.6% |

Two things fall out. **Magnitude barely matters** — 2× the charge moves size
under 1%. **Shape matters enormously**, and the true shape is the wrong one:
matching magnitude exactly and keeping only the measured shape is 17% worse.

The reason is that the true cost is **not monotonic in distance**. It peaks
around codes 10–11 and _falls_ at 16–19, because far codes are common in this
data and common codes are cheap in FSE. A frequency-fed model therefore tells
the parse a 500 KB-distant match is cheaper than a 2 KB one, and the repeat
chain that carries 85% of sequences comes apart.

**So the surcharge is not an estimate of anything. It is a monotone locality
prior**, and monotonicity is the whole product. That also explains the plateau
in the entry above: the level of the charge is nearly free to choose, because
what the parse consumes is the _ordering_ it induces over candidates.

_Do not revisit_ frequency-fed offset pricing, per-block or two-pass, unless it
keeps a monotone floor in distance — and note that the ~7.7% of output that
offset codes occupy caps the direct win regardless.

### 4-stream Huffman literals

`src/compress/huffman.ts` · commit `6b127be`

Single-stream (`Size_Format` 00) caps both regenerated and compressed size at
1023 B, so every large literal section fell back to raw. Added the 4-stream
layouts (`Size_Format` 01/10/11, 10/14/18-bit size fields) with the 6-byte jump
table, covering literal sections up to the 128 KiB block limit.

Same commit, same file: code lengths limited to 11 bits by rebuilding on halved
frequencies (instead of failing closed on a deeper natural tree); depths from a
two-queue merge (one sort, then linear) rather than re-sorting the active set
each step; dropped the pseudo-leaf used to force last-weight inference, since a
complete tree's Kraft sum already closes on the table size; symbols written
straight into the bit writer, dropping two per-literal scratch arrays.

> L3 corpus total 137,085 → 106,782 B (−22%) for +390 B gzipped of shipped code.
> L1 unchanged to slightly better (242,326 → 242,202 B).

### FSE-compressed Huffman weight headers

`src/compress/huffman.ts` · commit `c2b1188`

The direct 4-bit weight header carries at most 128 weights, and the weight count
is the highest present literal byte — so **a single byte above 128 anywhere in a
128 KiB block disabled Huffman for that whole block**. That is every UTF-8
payload with one accented character, and all binary data. The corpus was pure
ASCII and never showed it.

The decoder reads weights from two interleaved FSE states (state 1 the even
indices, state 2 the odd, update bits alternating), so the two subsequences are
independent state chains over a shared table and reuse `buildStatePath`.
Normalization, table description writing, and the accuracy-log heuristic are
shared with the sequence tables; the new code is the interleave and the framing.

Both header forms are built and the smaller wins, so pure-ASCII payloads gain too.

> `utf8-heavy-2k` 13,384 → 10,113; `utf8-one-char` 12,582 → 9,082;
> `skewed-binary-60k` 54,948 → 48,043 (within 5% of that payload's order-0
> entropy floor). ASCII: `huffman-lit-400` 157 → 113 B; `lorem-fixture` 141 → 105;
> `json-lines-200` 933 → 900. Corpus total 175,649 → 157,984 B (−10%).

**Both forms must stay reachable.** Small alphabets still pick the direct form,
and a test pins each.

### Custom FSE sequence tables (L3 only)

`src/compress/fse-tables.ts` · commit `0bfa787`

The predefined LL/ML/OF distributions are a fixed compromise; measured against
the code entropy of real blocks they cost 7–11 bits per sequence, which after
the literals work was the dominant remaining cost (`mixed-200k` spent 22,187 of
its 26,018 B on sequences).

Per code stream per block, L3 normalizes the block's own code counts, writes the
table description, and prices it against the predefined table before choosing.
Injected as a `SequenceTableSelector` so L1 keeps passing `usePredefinedTables`
and never pulls the module in — `compress_test` asserts the L1 and shared dist
chunks contain none of its markers, and L1 output stayed byte-identical.

> L3 corpus total 106,782 → 82,077 B (−23%). `json-lines-500` 2,909 → 1,578 B
> (under zrip level 3's 1,707); `json-lines-200` 1,386 → 933; `mixed-200k`
> 26,018 → 18,161; `mixed-256k` 34,222 → 23,985; `mixed-40k` 5,203 → 3,664.
> Shipped code +~1.2 KB gzipped.

Two design notes that cost time to get right:

- Normalization gives every present symbol at least one slot and hands leftovers
  to the largest fractional parts. It never emits the "less than one" (−1)
  probability zstd uses — marginally less precise, much easier to keep correct,
  and the decoder accepts either.
- **Cost comparison charges `n−1` state transitions for `n` sequences, not `n`.**
  Charging `n` made tiny frames buy a table description that did not pay for
  itself (`million-zeros` regressed 98 → 106 B).

### O(1) FSE state paths

`src/compress/fse.ts` · commit `0bfa787`

`buildStatePath` ran a backward reachability DP over `rowCount × tableSize`
cells. Never necessary: for any symbol, its states' `[baseline, baseline + 2^numBits)`
ranges **tile `[0, tableSize)` exactly**, so walking back from the final state
has exactly one predecessor at each step. Replaced with a next-state lookup built
once per table (`distinctSymbols × tableSize` entries, cached on the table object).

This removed the slowdown custom tables would otherwise have caused (a higher
accuracy log made the DP 8–16× bigger) and sped up both levels:

> `mixed-40k` L1 23.6 → 38.0 MB/s, L3 16.7 → 17.2. `mixed-200k` L1 21.5 → 36.2,
> L3 14.5 → 15.1.

`fse_state_path_test` checks the tiling invariant directly against random
distributions at every accuracy log. Keep it green if `buildFseDecodeTable` changes.

### Window descriptor above the match window

`src/compress/shared.ts`

Every frame we emitted was **single-segment**, which declares
`Window_Size = Frame_Content_Size`. For a 140 MiB payload that tells the decoder
to reserve 140 MiB for a window we never reach more than 1 MiB back into.

It is not only wasteful. zstd's default decode limit is 2²⁷, so the stock CLI
**rejects** any single-segment frame over 128 MiB:

> `Frame requires too much memory for decoding`
> `Window size larger than maximum : 146800640 > 134217728`
> `Use --long=28 or --memory=140MB`

So above 128 MiB we were producing frames only our own decoder could read —
silently, since no corpus payload is that large. Frames over `WINDOW_SIZE` now
carry an explicit window descriptor (`0x50`, exponent 10 → 1 MiB) with FCS still
present, one byte longer. Verified at 140 MiB against wzstd, zrip and the CLI,
all three OK, for both L1 and L3. Our own decode fast path is unaffected
(122.8 / 122.0 MB/s on 4 MB real files, against ~120 / ~119 before).

`tests/frame_header_test.ts` pins both header forms and the boundary, and
`tests/helpers/frame.ts` now parses the header for the three tests that used to
hand-compute `5 + fcsBytes` — an assumption that broke the moment a frame stopped
being single-segment.

### 1 MiB match window

`src/compress/shared.ts` · commit `963d325`

Blocks stay at 128 KiB; `WINDOW_SIZE` rose from 128 KiB to 1 MiB. Frames are
single-segment, so the decoder derives its window from the frame content size and
any in-content distance is legal — verified by decoding every whole real file
through zrip **and** the host `zstd` CLI, not just our own decoder.

This was the binding constraint on the files zrip used to win: at 128 KiB,
`federal_house-ca`, `federal_house-ut` and `county-subdivision-ri` all lost to
zrip level 3; at 1 MiB they win by 10–18%. The hash chain is now sized to the input
(`chainSlots`) rather than the window, so small payloads allocate less.

> Real corpus: L3 10,858,863 B vs zrip level 3's 15,385,757 (0.706×) and zrip level 1's
> 16,513,278 — winning every file. L3 encode 19.6 → 17.9 MB/s weighted; L1
> unchanged in size and faster.

---

### Minimum-length match filter (exact) — **Adopted**

`src/compress/shared.ts` · `bestMatchAt`, `minLenBase`

A candidate at distance `d` cannot score at all until it is long enough to pay
back the sequence overhead plus the offset charge at `litBits16` per byte. That
length is computable _before_ extending: at typical literal entropy it is ~12
bytes at distance 100, ~25 at 10 KiB, ~31 at 100 KiB — against the 4 bytes the
hash needle proves. So check the single byte at `minLen - 1`; a mismatch there
caps the length short of the bar and the extension is pure waste.

**Exact, not a heuristic.** Dropping the length-bits term only _lowers_ the
requirement, so no match that could win is ever rejected. The proof is that L3
output is byte-identical before and after, and the probe and extension counters
match exactly.

The bar rises as the walk finds better matches, so the filter strengthens
itself. The `bar = 1` column — a matcher that has found nothing yet, which is
48% of calls and the ones that walk furthest — is a per-block table, so the
common case costs a lookup rather than a divide.

> Real corpus: match extensions 539,553,392 → **89,916,139 (−83%)**, chain
> probes unchanged at ~601M, output byte-identical. ~1.38× on its own.

Revisit only if the cost model stops being monotone in distance — the filter's
correctness rests on that, plus the fact that a chain walks strictly outward.

### Contiguous per-bucket candidate ring — **Adopted**

`src/compress/shared.ts` · `HashState.rows` / `rowHead`

The hash chain was a linked list: `chain[p & chainMask]` hops to a scattered
word in an array up to 4 MB, once per probe, ~601M times. Storing each bucket's
most recent `ROW` candidates contiguously instead means a walk reads forward
through ~2 cache lines. It visits **the same candidates in the same order** —
byte-identical output, and the probe and extension counters match the linked
form exactly, which is what proves it is a layout change and not a search
change.

The ring is a fixed `HASH_SIZE * ROW` regardless of input, so it is used only
once the linked form would have allocated as much anyway; below that a small
payload keeps the small allocation, preserving the `chainSlots` property.

> Real corpus: ~1.14× on its own; ~1.67× stacked with the minimum-length filter,
> both at **zero ratio cost**.

### Asymmetric chain cutoff (`MatcherConfig.patience`) — **Adopted**

`src/compress/shared.ts` · `bestMatchAt`

Abandon the walk after `patience` probes without improving — **but only once a
match has been found**. A walk that still has nothing runs to `chainLimit`.

The asymmetry is the entire finding, and it is not obvious. Capping walks that
have already found something is nearly free; capping the ones that have not is
what costs ratio, because their late finds carry real bytes. Measured
separately over the whole real corpus:

| cutoff                                 | L3 size | chain work |
| -------------------------------------- | ------: | ---------: |
| after a match is found (`patience` 2)  |  +0.24% |       −26% |
| before one is found (`nullPatience` 8) |  +2.79% |       −45% |
| undifferentiated (single cutoff, 8)    |  +2.90% |       −65% |

An undifferentiated cutoff tracks a flat `chainLimit` cut almost exactly (2.90%
vs 2.94%), which is why the "83% of winners are the first probe" histogram did
**not** translate into a cheap win.

> Real corpus, stacked on the two exact changes above: **2.14× L3 encode for
> +0.24% size**, L1 byte-identical.

The fruitless-walk cap (`nullPatience` 12) stacked on top measures **3.02× for
+2.11%**. Beyond that it flattens (pat 8 + null 8: 3.15% speed for +2.90% size).

That +2.11% was held back pending "a look at where L3's ratio sits against zrip
and `node:zlib`" — a 2% regression being a product call, not a benchmark one.
**That table exists now, and the trade clears on ratio.** Ratios only, so this
stays comparable as totals move:

| impl            | ratio  |
| --------------- | ------ |
| wzstd L1        | 0.5201 |
| **wzstd L3**    | 0.2540 |
| node:zlib fast8 | 0.7103 |
| node:zlib -3    | 0.3534 |
| node:zlib -19   | 0.2012 |

L3 is **28.1% smaller than libzstd `-3`**, its like-for-like level, and sits far
closer to `-19` than to `-3`. The cap costs ~2% of that lead and does not change
the standing against any of them.

Note the method: the gate was a **ratio** question, and ratios are deterministic
sizes. Settling it needed a size-only pass over the corpus — seconds — not the
full `bench:summary` speed run. Do not let a speed harness gate a size decision.

**The lever-convergence worry was a corpus artifact — resolved, L1 survives.**
The concern was that at +2.11% the L1÷L3 _size_ gap barely moves (48.3% →
49.3%) while the _speed_ gap halves, leaving L1 without a reason to exist. The
pooled `bench:summary` median said L1 was only **1.27×** L3, which would indeed
have been fatal: 2× the output for 1.27× the speed is not a product.

Measured properly — real corpus only, whole files, byte-weighted, one process
per level — it is **2.0–2.5×** (17.60 vs 8.75 MB/s at 3 repeats, 23.63 vs 9.58
at 5; the spread is warmup, L1 warms more). So L1 buys ~2× the speed for ~2× the
size, which is a coherent pair of levers, and the 2.11% did not blur them.

The 1.27× came from a median over 42 payloads in which 33 synthetic fixtures
worth 6.8% of the bytes outvoted the real files — small, cache-resident payloads
where L3's chain never gets expensive, which is exactly where L1's advantage
disappears. Fixed in `bench_summary.ts`, which now reports the two corpora
separately. **Before treating a lever comparison as a product signal, check what
it was measured over.**

### L1's patience sentinels, derived not literal — **Adopted**

`src/compress/l1.ts`

L1 must supply `patience`/`nullPatience` (both are required on `MatcherConfig`,
so TypeScript already prevents deleting them). They were written as literal `1`
with a comment saying the cutoff is unreachable at `chainLimit` 1. True, but
inert **by coincidence**: `1` is the most aggressive cutoff the matcher accepts,
so it is armed and waiting rather than absent.

Now derived from a single `L1_CHAIN_LIMIT`. A cutoff equal to the walk length
provably cannot fire — the walk body runs at most `chainLimit` times, and
`sinceImprove` rises by one per iteration and only resets, so it reaches the
budget exactly when the loop bound does, and strictly later once anything has
improved. So it is a no-op for **any** value, and widening the chain stays a
pure search-depth change.

Measured, because the point is that the old form fails silently. At
`chainLimit` 4 on the real corpus:

| L1 `patience`/`nullPatience`   | L1 size vs `chainLimit` 1 |
| ------------------------------ | ------------------------: |
| derived (`= L1_CHAIN_LIMIT`)   |                     −4.6% |
| 1000 (unbounded control)       |                     −4.6% |
| literal `1` (the old spelling) |         **0.0%, exactly** |

The last row is byte-for-byte the `chainLimit` 1 output: **the entire 4.6% the
deeper chain buys is discarded, with no error and no signal.** Someone widening
the chain would see a flat result and correctly conclude their change did
nothing — while drawing the wrong lesson, that L1 does not benefit from a chain.

> _Not_ a suggestion to ship `chainLimit` 4 for L1; that trades L1's speed, which
> is its whole purpose. The 4.6% is here only to price the trap.

---

## Encoder — rejected and declined

Do not rebuild these as specified. Each line ends with what would make it worth
revisiting.

### RLE sequence mode (`Compression_Mode` 1) — **Rejected**

Built, then removed (commit `0bfa787`). A custom table (mode 2) over a single
symbol already costs **zero bits per sequence**, so mode 2 subsumes mode 1
entirely. It never won on any corpus payload, including payloads constructed
specifically to trigger it.
_Revisit only if:_ the table-description cost model changes such that mode 2's
description is no longer near-free for a one-symbol alphabet.

### Treeless literal blocks (reuse previous block's Huffman tree) — **Declined**

Upper bound measured at **0.13–0.14% of frame size** on 1–4 MB payloads, and that
bound assumes reuse is free, which it is not — it needs cross-block encoder state
and a validity check per block.
_Revisit only if:_ block size drops well below 128 KiB (many more, smaller trees),
or it comes bundled with other cross-block state that is being added anyway.

### Repeat-mode sequence tables (`Compression_Mode` 3) — **Declined**

Same shape as treeless literals, **≤0.5% upper bound**.
_Revisit only if:_ paired with treeless literals so one cross-block state
mechanism pays for both.

### Match window above 1 MiB — **Rejected**

2 MiB adds **under 0.1%** over 1 MiB. The saturation point is real and was
measured on whole files.
_Revisit only if:_ the corpus gains payloads with genuine long-range structure at
multi-MiB distances — this corpus does not have it. Do not re-litigate on the
current data.

### Single global offset surcharge — **Rejected**

Covered above: cost L1 **17%** while helping L3. It is a per-strategy
`MatcherConfig` field for that reason.
_Revisit only if:_ L1 gains entropy-coded literals, which is what makes the two
levels' cost structures differ.

### Good-enough match length cutoff (`goodEnough`) — **Rejected**

Ending the walk as soon as a match reaches some length. Built and swept
alongside `patience`: at a threshold of 16 it removed **1.1%** of chain work for
**+0.32%** of L3 size — the worst trade in the whole sweep, because the chain is
already ordered most-recent-first and the long matches it would stop on are
mostly found at the first probe anyway. Deleted.
_Revisit only if:_ the matcher stops walking outward in distance order.

### Widening `HASH_BITS` to reduce chain work — **Rejected**

15 → 18 (an 8× table) yielded **−2.6%** chain work and **−0.26%** L3 size. The
reason it cannot do more: a counter on chain probes showed **92%** already match
the 4-byte needle at `HASH_BITS` 15 (99.9% at 18). They are genuine data
repeats, not hash collisions, so a wider table can only ever remove the other
8%.
_Revisit only if:_ a corpus appears whose needle-match rate on chain probes is
materially below 90%.

---

## Will not do

Distinct from _Rejected_ and _Declined_ above. Those were measured, and each
carries a condition under which the measurement could change. **These are design
commitments.** They are not waiting on better numbers — doing them would break
correctness, compatibility, or a stated product boundary. Do not "improve" any
of them without an explicit decision to change the product.

### Make `decompress(data, { out })` accept multiple data frames

Each frame writes from offset 0 of its own output, so frame _n_ has no defined
destination in a caller-supplied buffer. "Fixing" the rejection means inventing
that placement rule, and any rule silently changes what an existing caller's
buffer contains. The one-argument form already handles multi-frame input
correctly; that is the answer, and the restriction is documented in the JSDoc,
README and AGENTS.md rather than worked around.

### Narrow or remove skippable-frame support alongside `out`

Skippable frames produce no output, so they cannot collide with a caller buffer,
and they are the **common** multi-frame shape in the wild — the seekable-zstd
format appends one, and tools use them for embedded metadata. Rejecting them
when `out` is supplied would break seekable-zstd readers for no gain.
`api_test` pins them leading, trailing and both, with and without `out`.

### Emit frames only our own decoder can read

The >128 MiB single-segment window bug was exactly this shape and went unnoticed
because no corpus payload was large enough. Any framing change ships with a
cross-decode against **zrip and the host `zstd` CLI**, and `node:zlib` where the
shape differs. An encoder-side "optimization" that no other decoder accepts is
not an optimization.

### Let a non-`ZstdError` escape the decoder

`ZstdError` is the documented error type. The wide bitstream reads can throw
`RangeError` on corrupt input, so both entry points convert it
(`src/decompress.ts`, the two `instanceof RangeError` guards). This is enforced
in code, not merely asserted in a test. Adding a new failure mode means adding
its conversion.

### Claim corruption is detected on a frame that carries no checksum

**Superseded in part** — the decoder now verifies the frame content checksum
when a frame has one (see the XXH64 entry under Decoder). What survives is the
half that is still true, and it is the half that trips people up:

A zstd frame is only checkable if the encoder wrote a digest, and nothing else in
the format is redundant. On a frame without one, damaged input decodes to
_different bytes_ and returns successfully — measured at **190 of 400** single-bit
flips (an earlier run on a different payload said 156 of 200).

**Both halves of the conditional are now closed on our own path by default.** Our
encoder emits a digest on every frame, and verification defaults on — only an
explicit `{ checksum: false }` skips the hash, and the property tests pin is
that you cannot skip it by accident. So for a wzstd frame decoded by wzstd with
the default path, detection _is_ unconditional.

It is still conditional in general, and that is what to keep in mind: a frame
from an encoder that wrote no digest (`node:zlib`'s one-shot API, `zstd
--no-check`) cannot be checked by anyone. Never write a doc or test implying
detection is unconditional **for arbitrary input** — an earlier test did, and was
wrong.

### Ship a streaming compressor that buffers until flush

**Still forbidden** — and this is now a regression test, not an open question.
`CompressFast` / `CompressStrong` emit 128 KiB blocks as they fill. A
`TransformStream` that accumulated every chunk and emitted one frame at flush
would satisfy the type signature while providing none of the property callers
want, and would quietly defeat the memory ceiling it appears to lift. Streaming
compress means a real sliding-window matcher or nothing. Ultra stays one-shot.

**And before building the real one, note what actually binds.** Measured on
`federal_house-tx.geojsonl`, whole file, one process per case:

| level | input    | encode time | MB/s | peak RSS | (baseline 62 MiB) |
| ----- | -------- | ----------: | ---: | -------: | ----------------- |
| L1    | 15.5 MiB |      1.34 s | 12.1 |  245 MiB | +183              |
| L3    | 15.5 MiB |      7.23 s |  2.2 |  158 MiB | +96               |
| L3    | 8 MiB    |      3.90 s |  2.2 |  126 MiB | +64               |

**The ceiling on a memory-capped runtime is CPU, not residency.** Streaming
does not make encoding faster; it only removes the need to hold the payload. At
L3's 2.2 MB/s, a Cloudflare Worker's 30 s CPU budget buys ~65 MB whether or not
the encoder streams — and 15.5 MB already costs 7.2 s. At L1's 12 MB/s it buys
~350 MB, so **L1 is the level for which streaming would change anything.** If
the goal is large payloads on edge runtimes, L3 encode throughput is the
prerequisite, not streaming.

The hash chain is already bounded (`chainSlots` caps at `WINDOW_SIZE`), so the
resident growth is input + block outputs + the concat copy, not unbounded
matcher state. Note the RSS figures include GC laziness and ~62 MiB of Node
baseline; they are an upper bound on what a capped isolate would need, not a
live-set measurement.

Shipped Fast and Strong (2026-08-14) because the decode stream existed and
there is no portable `CompressionStream` for zstd. Ultra is still one-shot:
its 8 MiB window is the wrong resident set for the tier streaming is meant to
serve, and the CPU bind above is unchanged.

### Add compression levels beyond L1 and L3

Deliberate product surface: no L2, no L4+, no level parameter. Every encoder
change so far has stayed inside it.

### Tune a shared cost constant to a single global value

L1 and L3 respond in opposite directions; `offsetSurcharge16` is 52 for L3 and 0
for L1 because a single value cost L1 17%. Any new cost knob is a
`MatcherConfig` field, never a module constant.

## Benchmark and corpus methodology

These were themselves the fix for wrong conclusions, so they are part of the record.

### Truncated corpora invalidate ratio claims

commit `963d325`

The corpus previously truncated files to 2 MB at line boundaries. That keeps
every feature intact and still **invalidates the result**: a byte _prefix_
changes the ratio a codec reaches, and here it **flipped the wzstd/zrip verdict
on 2 of 3 files** spot-checked (zstd's larger window keeps finding matches past
where the prefix ends).

Whole files only for ratio. A truncated sample may still be useful for a quick
local speed check, but it must be named `-part` so the bench can print a
warning. **Ratio is measured on whole payloads; throughput on a 4 MB slice** (a
per-byte rate, so slicing is legitimate there).

### The rule against one-process comparisons was not enforced anywhere — **Fixed**

`scripts/helpers/isolate.ts`, `scripts/helpers/isolate_child.ts`

This ledger has said **"never bench decoder variants in one process"** since the
decode work. Both harnesses did it anyway. `bench_summary.ts` timed all five
decoders and all six encoders inside the process that also built the frames;
`bench_decode.ts` timed wzstd, fzstd and zrip in one process — which is where its
`vs-fz` column, the only like-for-like comparison the project has, came from. The
previous handoff said to fix the former "as `bench_decode` does". `bench_decode`
did not do it either; that line was never checked against the file.

What it cost, on the real corpus: `bench_summary` put the no-verify decode row
**above** the verifying one on all four frame shapes, which is impossible.
Re-measured one process per variant, the order is right — verify 202–206 MB/s,
no-verify 226–228.

The fix is a shared harness, not a patch to each script. The parent builds frames
and computes ratios — both deterministic, and both unaffected by who else is in
the process — stages the buffers to one file, and spawns
`node isolate_child.ts <job.json> <out.json>` per implementation. Three
properties are load-bearing:

- **Results come back through a file, never a pipe.** Piped stdio has deadlocked
  this repo's helpers more than once. stderr stays inherited so a child that
  throws still says so, and a child that fails yields NaN — printed as `—` —
  rather than a plausible number.
- **The child imports only what its own subject needs**, lazily. The process
  measuring wzstd holds no WASM instance and no libzstd.
- **The unit of isolation is the implementation, not the payload.** One child
  still measures many buffers, as the in-process loops did; that was never the
  defect. What must not share a process is two things being _compared_.

Encoders are isolated too, though the rule named only decoders: `vs L3` is a
cross-encoder ratio, and the **L1:L3 multiple is a number this project makes
product decisions on** — a pooled median once put it at 1.27×, which would have
left L1 with no reason to exist.

`bench_decode` carried the **other** recorded defect at the same time: its
per-payload rows were fine, but the single `MEDIAN` line under them pooled the
synthetic fixtures with the real corpus — the exact weighting the "distribution,
not weighted average" entry rules out, and the reason the last fzstd figure had
to be thrown away. It now prints one median line per corpus, and takes `vs-fz`
and `zrip/us` (previously the unlabelled `gap`) as the **median of the
per-payload ratios**, not the ratio of the medians.

**Speed columns from before this change are not comparable to ones after it.**
Ratios, byte counts and probe counts are deterministic and stand.

**Revisit if** a harness needs an implementation `SubjectId` does not name: add
the id and its lazy import: an in-process shortcut for "just one more row" is how
this defect got in.

### The staging dir leaked on every unclean exit — **Fixed, with a known limit**

`scripts/helpers/isolate.ts`

`dispose()` was only ever reached by the explicit call at the bottom of each
bench, so the success path was the only path that cleaned up. A throw mid-run —
or the Ctrl-C you press when a four-minute job looks wedged — stranded a copy of
every staged payload in `tmpdir`, one dir per attempt. Found by inspection while
diagnosing an unrelated question: two orphans, 3.9 MB, from earlier killed runs.

`dispose` is now idempotent and registered on `exit`, `SIGINT` and `SIGTERM`.
Signals need their own handlers: Node's **default** SIGINT action terminates
without ever emitting `exit`, and installing a listener is what suppresses that
default — so each handler must re-exit itself, at 128 + signo.

**The limit, which is not fixable in-process:** `SIGKILL` cannot be caught by any
handler, so a `kill -9` or a tool harness force-killing the run still leaks. This
was observed immediately after the fix landed, on a run killed by a supervising
process rather than by a signal the process could see.

**Also shipped:** a best-effort sweep at `createIsolate` of `wzstd-bench-*` dirs
older than one hour (live runs are younger than a minute; an hour leaves room
for a long `bench:summary`). SIGKILL still cannot run dispose; the sweep is the
only recovery path for those orphans.

### The decode table hid that five of its columns were one decoder — **Fixed**

`scripts/bench_decode.ts`

The header read `own-L3 fast8 lvl3 lvl19 fzstd zrip`, which parses naturally as
six decoders. It is not: everything left of `fzstd` is **wzstd**, decoding frames
that differ only in who encoded them. A reader looking for "our decode speed"
could not find it, because it was there four times under names that sound like
other implementations. `gap` compounded it by never saying what it was a gap
_between_.

Now a grouped two-tier header (`wzstd decoding a frame from` / `peers on lvl3` /
`ratios`), built from the same width list as the columns so the two lines cannot
drift; `gap` → `zrip/us`; and a legend that states the median-of-ratios rule
outright. `vs-fz` **keeps its name** — six places in the docs refer to it, and
renaming for tidiness is how doc drift starts.

`own-L1` was added at the same time: both our levels ship and they are different
frame shapes, L1 trading ~2× the output for speed, which changes the
match/literal mix the decoder walks. It was the one frame this bench never fed to
the decoder. It is not redundant with `own-L3` — the first smoke run separated
them by 3.6× on `lorem-fixture`.

**Revisit if** a column is proposed for removal. `lvl19` looked redundant with
`lvl3` on synthetic data (medians 1.5% apart) — but `fast8` looked redundant too
until `skewed-binary-60k` put it **10×** above `own-L3`. Check `--extra` before
cutting; the trap entry on benching only our own frames is there for this.

### The timing loop re-calibrated its batch size on every trial — **Fixed**

`scripts/helpers/isolate_child.ts`

`rate()` ramps the batch size until one batch runs for `targetMs` (150 ms), long
enough that `performance.now()` granularity and scheduler noise are rounding
errors. That ramp sat **inside** the `trials` loop, so all five samples
rediscovered the same iteration count from scratch and threw the search away.

The waste scales with how small the payload is, because that is what makes the
batch large. A 2-byte fixture decodes in well under a microsecond, so it needs
~500k iterations to fill 150 ms and paid a ~300k-call ramp to find that out —
five times, for a row whose "MB/s" is really a per-call overhead number.

Now: calibrate once, then run `trials` timed batches at that size. The
calibration batch is **discarded rather than kept as a sample** — it is the first
run at that size and carries warmup the real samples should not.

**Speed numbers from before this change are not comparable to ones after it**,
for the same reason the isolation fix above says so. Ratios and byte counts are
deterministic and stand.

**Revisit if** small-payload rows still distort a **bench** median. Calibrating
once does not fix that **MB/s is the wrong unit** when fixed per-call cost
dominates. Tiny fixtures (e.g. `tiny-ok`, 2 B) still earn their place as
**correctness / extreme-size coverage** — tests and per-payload rows should keep
proving the codec does not fail open or special-case badly at the floor. What is
open is whether they should **vote in MEDIAN MB/s** on equal terms with megabyte
files. Candidate policies (neither measured as a product change): report ns/op
below some size, or exclude sub-1 KB from median lines only. Results-affecting —
decide deliberately; product claims already quote the **extra** corpus.

### A control variant is the only honest noise floor — **Adopted**

2026-08-03

Process isolation fixed _who_ runs where. It does not tell you **how small an
effect this machine can resolve today**, and without that number every ratio is
a Rorschach test. This cost most of a session, twice in opposite directions:

| run                          | reported for the same change |
| ---------------------------- | ---------------------------: |
| one repeat, not interleaved  |                    **1.25×** |
| 3 repeats, interleaved, busy |                    **0.97×** |
| 5 repeats, interleaved, calm |                    **1.02×** |

The 1.25× was a **cold machine**: absolute MB/s ran 130–190 in that run against
170–240 later, every column moved together, and the variant happened to run
second. The 0.97× was the same defect with the sign flipped. Both were read as
signal and one was nearly written up as a rejection.

**The fix is a control variant: measure a byte-identical copy of the reference
build as though it were a change.** Its ratio is the floor, in the same table,
under the same conditions, on the same payloads. On a quiet machine it came back
0.998–1.003 — so ±0.3%, and a +0.9% result is real while a −3% "result" from the
week before never existed. The control costs one extra child per repeat.

Three things fell out of it, all reusable:

- **Interleave variants within each repeat**, never sweep one variant to
  completion and then the next. Drift over minutes is the dominant term.
- **A degenerate payload has its own floor.** `million-zeros` swung the control
  to 1.047 while every real file held ±0.3%. Rows like that should not vote.
- **Report per-variant run-to-run drift** (`(max − min) / median`). It read
  0.5–1.1% on a calm machine and 10–30% on a busy one — a live "is this table
  worth reading" indicator, available before interpreting a single ratio.

**Synthetic fixtures screen, they do not decide.** Ordering matched the real
corpus, but magnitudes compressed — a change worth +2.4% on real files read
+1.0% synthetic, because small payloads sit in cache (so a saved load is free)
and per-call work is a larger share. Useful as a fast first look, and it would
have under-called every result here.

### Median of ratios, never ratio of medians — **Adopted**

2026-08-04

Every peer-relative cell (`vs-fz`, `nv/fz`, cost-by-shape) is the **median of
per-payload ratios**. The ratio of the median columns is a different number and
answers no question: it divides two figures that need not come from the same
payload — on the extra corpus our median lvl3 payload is `federal_house-nd` while
fzstd's is `county-hi`, so the "ratio" compares a 743 KB decode against a 108 KB
one. On this corpus the gap between the two statistics is about **5 points**
(1.06× against 1.12×), which is far larger than the ±2% the harness can resolve.

This is not theoretical: a published **1.11×** `vs-fz` claim turned out to be the
ratio of medians sitting in the median-of-ratios cell, and three quiet runs of
unchanged code put the real figure at 1.06×. Full account in "Decode product
claims".

Two cheap tells before quoting any ratio:

- **Direction.** On this corpus median-of-ratios sits _below_ ratio-of-medians in
  every honest run. One that lands above, and lands almost exactly _on_ it, is
  the substitution.
- **Provenance.** Cross-check against the A/B that supposedly produced the move.
  A claim that jumps 11% on changes measured at ~1% is arithmetic, not a result.

Read ratios off the bench's own ratio cell. Never recompute one from the absolute
median columns printed next to it — they are in the same table precisely because
both are useful, not because they are two views of one number.

**Absolutes and ratios have different fragility.** Across three consecutive runs
here the absolute columns held within 1.6% while the peer ratio was the part that
had previously gone wrong. A single run is adequate evidence for an absolute and
is not adequate for a published ratio; reproduce ratios before quoting them.

### Three bench scripts, one question each — **Adopted**

`bench_compress.ts` and `bench_throughput.ts` are **deleted**. Both timed wzstd
against zrip inside one process, which is the defect above; both were written
before `bench_summary` existed, and everything they reported it reports better.
`bench_compress` also reported weighted averages — the statistic `bench_throughput`
was written to replace, and which no harness here should produce.

That left an asymmetry worth naming: there was a decode-only bench and no
encode-only one, so any matcher change had to pay for four frame shapes and five
decoders to find out whether it helped. `bench_encode.ts` closes it.

| script          | question                                        |
| --------------- | ----------------------------------------------- |
| `bench:summary` | where do we stand — ratio and speed, every peer |
| `bench:encode`  | did this encoder change help                    |
| `bench:decode`  | did this decode-loop change help                |

`bench_encode` reports L1 size, L3 size, L1 speed and L3 speed together, plus the
worst single payload per encoder and the L1:L3 multiple in words. That layout is
deliberate: the levels are a **product constraint**, a change that pulls them
together removes L1's reason to exist, and a total ratio hides a regression that
one file is carrying. Peers are behind `--peers` because zrip's and libzstd's
numbers do not move while you iterate, and timing them is most of the wall clock.

**Do not resurrect the deleted two.** If something they showed is missing, it is
a column on one of these three, in a child process, not a fourth script that
quietly compares implementations in the parent.

### The extra corpus is generic, opt-in, and errors when missing — **Adopted**

`scripts/helpers/corpora.ts`, `extra-bench-data/`

Three changes, one idea: **the second corpus is the user's data, not ours.**

`bench-data/` is now **`extra-bench-data/`**, and nothing reads it as GeoJSONL —
any file is a payload and the extension is only stripped for a row label.
`WZSTD_CORPUS_DIR` points the benches at any directory. The question that decides
whether someone adopts a codec is "how does it do on _my_ data", and it should
not require editing a script.

Both corpora used to load on every run. That is tens of MB through four to seven
encoders before a single measurement, for a question the in-repo fixtures answer.
Now every bench takes `--extra` / `--extra-only`, and defaults to synthetic.

**Asking for the extra corpus and not having it is an error.** The earlier
behaviour was a printed warning and a synthetic-only table, which is the worst of
both: the heading says what you asked for and the numbers read ~1.6× high,
because the fixtures are small enough to sit in cache. Tests keep the opposite
rule and skip — a correctness check with no data has nothing to report, and a
fresh clone must not fail.

The residual risk is quoting a synthetic number by accident, so a synthetic-only
run prints that nothing in it is quotable, and the extra corpus stays one flag
away rather than a different script.

**No sync script, no provenance, no backup.** `sync_corpus.ts` and
`corpus_sources.ts` went with `pnpm bench:sync-corpus`. Sampling a corpus out of
another repo was machinery in service of one machine's dataset, and it made the
directory feel like an artifact the project owned — which is what produced a
standing "irreplaceable archive, back it up" chore nobody wanted. The directory
is a slot; filling it is a copy. The dataset here is local and unpublished on
purpose. The one real consequence is that the ledger's per-file rows describe the
files that were there when they were written, so a different dataset means re-run
rather than compare.

**Revisit if** anyone proposes a second directory, a config file, a per-bench
corpus flag, or a script to populate it. One directory, one env var, one pair of
flags, shared by every bench, is the whole interface.

### Every bench knob is a flag, and every flag composes — **Adopted**

`scripts/helpers/corpora.ts`, `scripts/helpers/encoders.ts`

The knobs used to be a mix: `--extra` was a flag, `WZSTD_BENCH_LVL19` and
`WZSTD_BENCH_LIMIT` were environment variables read only by `bench_summary`, and
the encoder roster was written out twice. That is three separate problems —
inconsistent surface, capability trapped in one script, and duplication that will
drift.

Now `selectCorpora(extraOptions)` parses everything through one `parseArgs`, so a
bench declares its own flags and gets the shared ones free:

| flag           | where                           | what                                          |
| -------------- | ------------------------------- | --------------------------------------------- |
| `--extra`      | all three                       | add the extra corpus                          |
| `--extra-only` | all three                       | extra corpus alone                            |
| `--limit N`    | all three                       | first N payloads per corpus; announces itself |
| positional `N` | all three                       | per-payload byte cap for speed                |
| `--peers`      | `bench:encode`                  | add zrip and `node:zlib`                      |
| `--lvl19`      | `bench:encode`, `bench:summary` | add the `node:zlib -19` ratio reference       |

Verified by composition, not by assertion: every pairing was exercised in a
throwaway script (`--peers --lvl19 --extra-only --limit 1 500000` and friends),
including the failures.

Two properties worth keeping:

- **Parsing is strict.** A flag a bench does not define throws
  `ERR_PARSE_ARGS_UNKNOWN_OPTION`. A silently ignored flag means the run measured
  something other than what was asked for and nothing says so — the same failure
  shape as the config value that was inert by coincidence.
- **`--lvl19` is no longer summary-only.** "How much ratio is left on the table"
  is an _encode_ question, and the bench for encode questions could not ask it.

`ENCODER_OPTIONS` / `encoderList()` hold the roster once. `bench_summary` takes
peers unconditionally — a summary without the ceilings is not a summary —
`bench_encode` asks, and neither can drift from the other.

### `pnpm test` does not touch the extra corpus — **Adopted**

`tests/external_corpus_test.ts`, `scripts/run_test.ts`, `pnpm test --extra`

It used to run whenever the directory existed. Once that directory is defined as
_whatever the user put there_, that is wrong on its own terms: `pnpm test` would
mean different things on two machines, take however long those files happen to
weigh, and a failure could be a bug or one odd input. It is also the only part of
the suite that drives `zstd -19` through `spawnSync`, which is the known way to
wedge the runner.

So the correctness suite is hermetic by default — synthetic fixtures only — and
`pnpm test --extra` / `--extra-only` (same flag names as the benches; sets
`WZSTD_TEST_EXTRA=1` internally) runs the real-data round-trip. Absent directory
still skips rather than fails, so `--extra` on a fresh clone is a no-op. The old
`pnpm test:extra` script is gone; one runner, two flags.

Ratio-direction and multi-block asserts only fire when the inventory looks
compressible / large enough — the directory is a generic slot, and already-
compressed user data must still pass round-trip without being failed for ratio.

**The cost is real and must not be forgotten:** real files find frame shapes
fixtures do not, which is why this corpus exists. **Run `pnpm test --extra`
before shipping any format change** — literal framing, weight headers, sequence
tables, window handling. `AGENTS.md` says so too.

**Revisit if** a regression ever reaches a commit that `pnpm test --extra` would
have caught. That is the signal the default is wrong, and it is worth paying the
hermeticity to find out.

### A pure function's microbench can be hoisted out of the timing loop

`.tmp` throwaway, but the lesson is permanent

The first XXH64 variant bench reported **13×**. It was not real, and the tell was
that the number did not move when the obvious guard was added.

The variant's whole point was that the hash no longer writes to any module-level
slot. That also makes it **pure** — so with a loop-invariant input, V8 hoists the
entire computation out of the timing loop and times an empty loop. The baseline,
whose slot writes are observable side effects, could not be hoisted, so the
comparison was measuring one variant working and one not.

Two guards, and **the first one alone is not enough**:

1. Consume the result — `sink = (sink * 31 + fn(i)) | 0`, printed at the end. Do
   not fold with `^=` over identical inputs: an even number of equal digests
   XORs to zero, which both hides the bug and reads as a plausible value.
2. **Make the input depend on the iteration index** (`d[0] = i & 0xff`). This is
   the one that matters. Consuming the output stops dead-code elimination; only a
   varying input stops loop-invariant hoisting.

The honest confirmation was end-to-end: the same change measured through
`decompress`, where the digest is compared against the frame's stored value and a
mismatch throws, so the work cannot be elided. It agreed with the corrected
microbench. **A speedup this large should always be re-measured through the real
consumer before it is believed.**

### Bench the pure-JS peer, not only the WASM one

`fzstd` is the implementation `src/decompress.ts` is derived from, it is pure JS,
and until then it was **never benchmarked** — the decode bench compared
against zrip (Rust→WASM), the `zstd` CLI and `node:zlib`, all of which are native
and all of which we lose to by construction. That left the one like-for-like
comparison unmeasured, and with it the only number that says whether the decoder
is good rather than merely "slower than C."

It also mattered for a specific reason: **fzstd does not verify the content
checksum at all.** It reads the flag and skips 4 bytes
(`bt = st.b + (st.c * 4)`) without hashing. So a default-configuration comparison
had us doing strictly more work, and the gap it showed was the XXH64 tax, not a
decoder deficit. Run `ours` and `ours-noverify` as separate columns or the two
effects are indistinguishable.

### Extra corpus content profile

`scripts/profile_corpus.ts` · on this machine

This describes what is in `extra-bench-data/` **on this machine**. The directory
itself is a generic slot for whoever is benching — see "The extra corpus is
generic, opt-in, and errors when missing".

Whole GeoJSONL district layers, held locally and not published or backed up.
Profile axes are bytes per feature, digit share, order-0 entropy, and repeat
share (`pnpm bench:profile-corpus`).

**These rows describe these files.** Point `WZSTD_CORPUS_DIR` at a different
dataset, or replace what is in the directory, and every per-file number below
stops applying — re-run the profile rather than comparing against it.

**8 files / 11,911,042 B.** Chosen by profile extremes under a 5 MB per-file
cap (bytes per feature, entropy, digit share, repeat share, size). Each file is
the sole occupant of at least one extreme:

| file                 |     bytes |  B/feat | entropy | digit | repeat | role                                             |
| -------------------- | --------: | ------: | ------: | ----: | -----: | ------------------------------------------------ |
| `county-hi`          |   108,126 |  21,625 |    3.89 |  0.70 |   0.26 | smallest file; few features                      |
| `school_district-hi` |   130,201 | 130,201 |    3.82 |  0.81 |   0.14 | single feature; lowest repeat                    |
| `federal_house-wy`   |   204,291 | 204,291 |    3.80 |  0.70 |   0.41 | one dense feature; lowest entropy                |
| `federal_house-nd`   |   743,450 | 743,450 |    3.84 |  0.69 |   0.35 | highest bytes per feature                        |
| `municipality-ak`    |   813,121 |   5,457 |    4.06 |  0.68 |   0.36 | highest entropy; many small features             |
| `municipality-nd`    | 1,822,600 |   5,134 |    4.03 |  0.79 |   0.25 | many-small-records (355 features); lowest B/feat |
| `state_house-ma`     | 3,945,199 |  24,657 |    3.90 |  0.69 |   0.57 | highest repeat share                             |
| `school_district-wy` | 4,144,054 |  88,889 |    3.81 |  0.82 |   0.34 | largest file; highest digit share                |

Files are whole layers — do not truncate. A byte prefix changes the ratio a
codec achieves and can flip comparisons against peers with larger windows.

### The synthetic corpus must be representative on its own

commit `c2b1188`

It was ASCII-only, which is exactly what hid the Huffman weight-header cliff for
an entire session. Any new format work needs a synthetic payload that reaches it.
`multilingualLines` (three non-ASCII densities) and `skewedBinary` exist for this.

### Distribution, not weighted average

`scripts/bench_throughput.ts` (deleted) · commit `efbc54e`

The competitive bench reported weighted averages, which a few huge
highly-compressible payloads dominate. The throughput bench replaced them with
the per-payload distribution — median MB/s over repeated trials, plus quartiles
and the wzstd:zrip ratio spread. **Decode is measured in bytes of output** so the
two decoders compare fairly despite different frame sizes.

Both scripts are gone (see "Three bench scripts, one question each"); the principle is not.
`bench:summary` reports medians per corpus and `bench:decode` reports every
payload as its own row — neither ever collapses to a weighted average.

### Cost constants are never tuned globally

L1 and L3 respond differently, often in opposite directions. Changing
`SEQ_OVERHEAD_BITS16`, `LITERAL_COST_MARGIN16`, or the surcharges moves output on
every payload — re-run `pnpm bench:encode --extra` and check **both** levels.

### oxfmt reflows code, so verify a patch landed

`perl`/`python` patches keyed on multi-line source silently miss after a format
run. A no-op sweep looks exactly like "the knob does nothing." Confirm the edit
is in the file before trusting a sweep result.

### Format changes need external interop, not just our own round-trip

A mis-shifted size or window field still round-trips through our own decoder for
some inputs. Anything touching framing must be cross-decoded by **zrip and the
host `zstd` CLI** over whole files.

---

## Decoder

`src/decompress.ts` is derived from fzstd (MIT) and had received **no
optimization attention** through commit `963d325`. It is the smallest gap to
zrip and therefore the cheapest remaining gain.

Baseline at `963d325` (median across payloads, `pnpm bench:throughput` — since
deleted — Node 22):

|           | median MB/s | vs zrip         |
| --------- | ----------- | --------------- |
| encode L1 | 24.2        | 11× slower      |
| encode L3 | 12.6        | 33× slower      |
| decode    | 125         | **5.7× slower** |

**Cumulative result of this round of decode work**, `963d325` → now. Isolated
A/B, 4 MB slices, median of 7 trials per process, Node 24.18.0 (MB/s of output):

| frame                               | `963d325` |   now | gain      |
| ----------------------------------- | --------: | ----: | --------- |
| CLI level 19 `school_district-ak`   |      28.4 | 156.5 | **5.51×** |
| CLI level 19 `federal_house-tx`     |      45.8 | 168.8 | 3.68×     |
| CLI level 19 `municipality-oh`      |      54.8 | 129.5 | 2.36×     |
| CLI level 3 `federal_house-tx`      |      71.2 | 152.2 | 2.13×     |
| CLI level 3 `municipality-oh`       |      71.8 | 148.7 | 2.07×     |
| own L3 `municipality-oh`            |      93.8 | 169.6 | 1.80×     |
| CLI `--fast=8` `municipality-oh`    |     260.7 | 383.5 | 1.47×     |
| CLI `--fast=8` `school_district-ak` |     271.2 | 336.2 | 1.23×     |

Two changes produced it: the growing output buffer (which the level 19 column is
dominated by) and word-at-a-time bitstream reads (which the level 3 and own-L3
columns are dominated by). The negative band moved least because those frames
are copy-bound rather than bitstream-bound.

### Measuring decode

`pnpm bench:decode` (`scripts/bench_decode.ts`) exists because the competitive
and throughput benches spend nearly all their wall clock in the **encoder**,
which makes them unusable for iterating on a decode loop.

It decodes frames from **three encoders** — ours (L3), the host `zstd` CLI at level 3
and level 19, and zrip — because the product decodes arbitrary zstd, not only what we
emit. That distinction turned out to matter more than anything else here; see
below.

Two measurement traps, both hit during this work:

- **Never bench decoder variants in one process.** A threshold sweep run that way
  produced ±15% noise and an obvious outlier, and read as signal. Isolated
  process per variant, median of repeated trials, is the only harness that
  resolved a 6% effect. `bench:decode` and `bench:summary` now enforce this
  themselves through `scripts/helpers/isolate.ts` — until then they did
  not, and `bench:decode` showed run-to-run drift large enough to move zrip's own
  column by 2×. See the methodology entry.
- **A CPU profile's hottest line can be a red herring.** 64–68% of decode
  self-time attributed to `at()` — but that line contains the actual memory
  loads, which happen regardless. See the rejected entry below.

### Decode into one growing buffer when content size is absent — **Adopted**

`src/decompress.ts`

**`zstd` reading a pipe emits no Frame_Content_Size**, and neither does any
streaming producer. One-shot `compressFast` / `compressStrong` / `compressUltra`
still write FCS; `CompressFast` / `CompressStrong` write the pipe shape. The
two decode paths used to be structurally different, and only the FCS-present
one was fast. Benching solely against one-shot own frames hid this completely.

Without FCS the decoder used to, per block: allocate a fresh 128 KiB buffer,
slice-copy the finished block out of it, `copyWithin` the **entire window** to
shift it, and append the block — then concatenate every block at the end. The
window shift alone is O(window) per block, so cost scaled with the _declared
window_, not the data.

Now that path allocates one output buffer, grows it by doubling, and uses it as
its own history — exactly what the known-size path already did. The per-block
allocation, the slice, the window shift, and the final concat all disappear.
`rzfh` also stops allocating a window buffer it would immediately discard.

Isolated A/B, 4 MB slices, median of 7 trials each in its own process, **Node
24.18.0** (the `963d325` baselines above were taken on Node 22 — V8 differs, so
compare only within a row):

> **CLI level 19:** `school_district-ak` 45.8 → 149.4 MB/s (**3.26×**),
> `federal_house-tx` 64.8 → 133.8 (2.06×), `municipality-oh` 75.4 → 116.1
> (1.53×), `place-municipality-ia` 94.3 → 139.4 (1.47×).
> **CLI level 3:** 1.18–1.19× across the same files.
> **Our own L3 frames:** unchanged (0.99×) — they already took the fast path.

The level 19 gain is the largest because level 19 declares an **8 MiB** window: 64
blocks × 8 MiB ≈ 512 MB of memmove to produce 4 MB of output. At level 3 the
window is 2 MiB and the same effect is worth only ~9%, which is why the first
measurement of this idea looked unpromising — memmove bandwidth is high enough
that a 2 MiB window shift hides in the noise while an 8 MiB one dominates.

Streaming `Decompress` is deliberately unchanged: it genuinely needs a bounded
window and cannot grow an output buffer it does not own.

### Amortized streaming window compaction — **Adopted**

`src/decompress.ts`

The one-shot decoder stopped shifting a window per block when it moved to a
growing output buffer. `Decompress` could not follow: it hands each block to a
callback and never owns the output, so it needs a real bounded sliding window.
It therefore kept the per-block `copyWithin` — and inherited the whole cost the
one-shot path had shed.

Measured before fixing, streaming vs one-shot on the same frame:

> level 19 `school_district-ak` **0.22×** (49.0 vs 226.4 MB/s), `municipality-oh`
> **0.56×**. `--fast=8` and level 3 and our own frames were already at parity, because
> their declared windows are small.

The window buffer is now oversized by 8 blocks; blocks append at the head and
the window compacts only when that slack runs out, keeping `st.g` bytes of
history. Same memory order, 8× fewer shifts:

> level 19 **0.90–0.98×** of one-shot (`school_district-ak` 49.0 → 209.5 MB/s,
> **4.3×**; `municipality-oh` 96.1 → 156.0). Negative band and own frames
> unchanged at 0.83–1.00×.

This is the same lesson as the one-shot fix, in a second place: the cost scales
with the _declared window_, not the data, so it is invisible on small-window
frames and dominant on large ones.

### Web Streams adapter — **Adopted**

`src/stream.ts`

`decompressStream()` wraps `Decompress` in a `TransformStream`. Measured at
**0.91–1.05×** of the push API across every frame shape — the adapter itself
costs nothing, so there is no reason to keep callers on the lower-level surface.

Two decisions worth not relitigating:

- **In the barrel, not a subpath.** The earlier argument for `wzstd/stream` was
  that the core must not touch host APIs — but `TransformStream` is only a
  problem if evaluated at module load. Referenced lazily inside the factory, the
  barrel still imports cleanly where it is absent. The existing subpaths exist
  to physically guarantee L1 has no Huffman in its graph; that reason does not
  apply here, and the wrapper is ~200 B in a `sideEffects: false` package.
- **Compress counterpart is Fast/Strong only, and it is real.** Ultra stays
  one-shot. A stream that buffered everything until flush is still forbidden.

`TransformStream` is a **host API, not an ES2022 feature** — the language target
carries no information about whether it exists. What matters is the runtime
roster (Node 18+, Deno, Bun, Workers, browsers: all present), plus the fact that
`DecompressionStream` supports no zstd anywhere and Node's zstd is `node:zlib`,
which is Node-only. That gap is the reason this adapter is worth shipping.

### Streaming Fast/Strong encode — **Adopted**

`src/compress/shared.ts` (`EncodeStream`) · `fast.ts` / `strong.ts` · 2026-08-14

Push API + lazy `TransformStream` for Fast and Strong. Ultra stays one-shot.
One instance is one frame. Frames omit FCS, declare 1 MiB, always checksum.
Blocks emit at 128 KiB. The data buffer starts at `2 × 128 KiB` and doubles
toward `window + 8` blocks; history past the window is dropped and the hash
chain is **rebuilt** from what remains (it is indexed by `pos & chainMask`, so
it cannot be remapped). The matcher must see `buf.subarray(0, end)`, not the
allocation — otherwise the last three bytes of a flushed block hash leftover
tail. `grow` must not escape the cap with `cap = want`; a single large `push`
emits and compactifies instead of retaining the remainder.

`tests/stream_test.ts` pins the header, early emit, a match on the 128 KiB
seam, and a 1.4 MiB single push. `decode_no_fcs_test` uses `CompressFast` as
the hermetic no-FCS source.

### Lazy streaming window growth — **Adopted**

`src/decompress.ts`

The streaming decoder allocated the frame's **declared** window up front. A
declared window is attacker-controlled and need bear no relation to the payload:
a **27-byte frame declaring 128 MiB allocated 129 MiB**, and the decoder's own
limit permits ~2046 MB, so a tiny hostile frame could reserve ~2 GB. One-shot
never had this — it sizes from the content.

Streaming now starts at `min(window, 2 blocks)` and grows toward
`window + 8 blocks` only as data actually arrives, compacting once there. Same
27-byte frame: **~1 MB**. Level-19 streaming throughput is unchanged
(0.96–0.99× of one-shot).

Found while checking a documentation claim, not by benchmarking — the decode
benches all use payloads whose windows are proportionate, so nothing in the
harness would ever have surfaced it.

### Documented decode limits were wrong — **Fixed**

The README claimed a **2²⁵** maximum backreference and excluded ultra 20–22.
Both were inherited from fzstd and neither matched the code: `rzfh` rejects only
above ~2046 MB, and 64 MiB / 128 MiB windows — including `--ultra -22
--long=27` — decode correctly one-shot _and_ streaming.

Wrong in the conservative direction, which is why it went unnoticed: nothing
failed, we just under-claimed. `tests/large_window_test.ts` now pins the real
behaviour in both directions, including rejection above the limit, so the claim
cannot drift again.

**Follow-up: the "rejection above the limit" test passed for the wrong reason.**
See the next entry. A test that asserts only `throws()` cannot tell you _which_
failure it caught, and this one was catching a different bug than the one it
named.

### The window-size limit check never ran — **Fixed**

`src/decompress.ts` · audit of the two entries above

`rzfh` computed the declared window as `1 << (10 + exponent)`. The exponent
field is 5 bits, so Window_Log runs to 41, and **a JS shift wraps at 32**:

| Window_Log | true window | computed   | what happened                            |
| ---------- | ----------- | ---------- | ---------------------------------------- |
| 31         | 2 GiB       | **−2 GiB** | negative, so `ws > 2145386496` was false |
| 32         | 4 GiB       | 1 B        | wrapped to a 1-byte window               |
| 41         | 2 TiB       | 512 B      | wrapped to a 512-byte window             |

So the documented `WindowSizeTooLarge` rejection **never fired on any frame that
needed it**. What happened instead: Window_Log 31 reached `new u8(negative)` and
threw a raw `RangeError` out of `Decompress.push` — the header parse sits outside
that method's `instanceof RangeError` guard — violating "let a non-`ZstdError`
escape the decoder" in Will not do. Window_Log 41 was worse: a tiny window
silently truncated a 95000-byte frame to **512 bytes, streamed, with no error**.

Fix: `2 **` and `/ 8` rather than `1 <<` and `>> 3`, once per frame header. Every
descriptor at Window_Log 31+ is now `WindowSizeTooLarge` on both paths, matching
the stock CLI, and Window_Log 30 mantissa 7 (2013265920 B, the largest legal
declaration) still decodes.

The test that should have caught this asserted `assert.throws(() =>
decompress(frame))` on a Window_Log 41 frame. It passed — on `InvalidData` from
an undersized block buffer, in the one code path that happened not to be the
broken one. **Assert the error code, and assert both decode paths.**

### A block may not regenerate past the declared window — **Fixed**

`src/decompress.ts` · same audit

`Block_Maximum_Size` is min(128 KiB, `Window_Size`) — `st.m`. The streaming
decoder sized its per-block buffer at `st.m` and then let a larger block write
past the end of the `Uint8Array`, which **JS drops silently**. A frame whose
declared window is smaller than its blocks therefore streamed truncated output
and reported success: 95000 bytes in, 1024 bytes out, no error. One-shot caught
it only incidentally, via `need()` re-checking the total against the caller's
buffer. `zstd -d` rejects the same frame ("Destination buffer is too small").

Two O(1) checks per block, both cold: `sz > st.m` at the block header (raw and
RLE regenerate exactly `sz`, and it bounds `new u8(sz)` too) and
`oubt > buf.length` after a compressed block's sequences. No measurable decode
cost — a comparison per 128 KiB of output.

The shape to remember: **a silent write past the end of a typed array is a
truncation bug, not a crash.** Anywhere a header field sizes a buffer, either
validate the field or check the cursor afterwards.

**Follow-up (2026-10-27): "afterwards" was too late.** The `oubt > buf.length`
check ran after the whole sequence loop, so a 40 KB compressed block of 20000
maximum-length matches (ML code 52, all three code streams in RLE mode) ran
1.3 GB of byte copies whose writes all fell off the end — **2.3 s per block** —
before failing. Replaced by a per-sequence bound, `spl + ll <= buf.length` and
`oubt + ml <= spl`, which also caught a second bug: a sequence consuming more
literals than the block carried **decoded to wrong bytes with no error**. The
end-of-loop check became unreachable and was removed. Cost: the two-branch `||`
form measured ~7% slower on dickens lvl3 (205 → 185–192 MB/s, two runs each,
`bench:ab-decode --silesia-only`); folding both into one sign test,
`((buf.length - spl - ll) | (spl - oubt - ml)) < 0`, measured 207 — parity.

### Output cap, 128 MiB window limit, streaming block scratch — **Adopted**

`src/decompress.ts` · security review, 2026-10-27

- **`maxSize`, default 64 MiB, `Infinity` to opt out.** 10 KB of RLE blocks
  (4 bytes → 128 KiB each) decoded to 327 MB. The cap spans every frame of the
  input, on `decompress`, `Decompress` and `decompressStream`; one-shot checks
  it per block and stops buffer doubling at the budget, streaming checks before
  `ondata`, and a declared content size above it fails before allocation. Same
  option name and default as wgzip.
- **Declared content size no longer drives the preallocation on its own.** It
  is honoured up to `min(maxSize left, input length × 65536)` — no block
  regenerates more than 128 KiB from its 3-byte header — and otherwise the
  growing buffer takes over and the size is checked against real output.
- **Window limit 2²⁷ (128 MiB)**, libzstd's `ZSTD_WINDOWLOG_LIMIT_DEFAULT`, down
  from ~2046 MB. Matches `zstd -d` and `node:zlib` without `--memory`;
  `--ultra -22` and `--long=27` still decode. Applies to single-segment frames
  too (their window is their content size), as libzstd streaming does.
- **Streaming reuses one block scratch per frame.** A fresh 128 KiB buffer per
  compressed block made a stream of empty 5-byte blocks cost ~300 ms per MB of
  input; now ~18 ms, the same as one-shot. Output is still copied out per block,
  so `ondata` chunks remain caller-owned.

`tests/limits_test.ts` reproduces each one with a hand-built frame.

### XXH64 content checksum verification — **Adopted, default on**

`src/xxh64.ts`, `src/decompress.ts`

The decoder skipped the 4 checksum bytes. That made corruption undetectable in
the common case, since nothing else in the format is redundant. Measured on one
payload, 200 single-bit flips deep in the compressed body:

| frame              | errored | returned **wrong bytes** |
| ------------------ | ------: | -----------------------: |
| with a checksum    | 200/200 |                        0 |
| without a checksum |  44/200 |                  **156** |

**It cost 2.4–3.0× of decode** (4 MB payload, median of 5, one process:
CLI level 3 181.7 → 76.7 MB/s, `--fast=8` 257.7 → 85.2, level 19 207.6 → 79.7). Pure-JS XXH64 was
simply slower than this decoder, so the hash — not the decode — set the pace.
**Superseded: the tax is now 1.08–1.26×** — see "XXH64 stripe loop: keep every
64-bit intermediate in a local" below. Everything about the _default_ still
holds; only the cost changed.
Frames without a digest pay nothing.

> **Superseded again.** At the time our encoder emitted no digest, so
> wzstd → wzstd round-trips were unaffected and the option was the safety valve
> for the cost. Both halves changed: the encoder now emits on every frame, and
> `verifyChecksum` was removed — see "Emit a content checksum, and always verify
> one". The reasoning below is kept because the _ordering_ argument still holds:
> correct before performant, and a cost is recoverable where silent wrong bytes
> are not.

**Both reference implementations verify, and we were the outlier.** Same 1.74 MB
payload, one checksummed CLI level 3 frame, median of 7; "detects" flips only the
stored digest, leaving the content perfectly decodable:

| implementation        |  MB/s | detects a bad digest |
| --------------------- | ----: | -------------------- |
| wzstd, verify on      |  79.4 | yes                  |
| wzstd, verify off     | 236.8 | **no**               |
| zrip (Rust → WASM)    | 440.8 | yes                  |
| node:zlib (C libzstd) | 978.6 | yes                  |

Native XXH64 runs at GB/s, so for zrip and libzstd verification is nearly free
and default-on is uncontroversial; in JS it is the pacing item. That is an
argument about _cost_, not about _default_: shipping default-off would make this
the only one of the three that silently returns corrupt data.

Three things took the hash from 36 MB/s to 141:

- **Specialise the multiplies.** XXH64's inner loop only ever multiplies by P1
  and P2. Folding each prime's 16-bit limbs in as constants removes four limb
  extractions and four multiplies per 64-bit multiply.
- **Read lanes with a `DataView`,** not four byte loads and three shifts.
- **Hash each block as it is produced,** not the finished frame. Same bytes,
  but they are still in cache; a second pass over a cold multi-megabyte buffer
  measurably costs more.

Correctness oracle is the `zstd` CLI's own digest, not test vectors written from
memory — `tests/checksum_test.ts` compares against frames the CLI produced, at
every size around the 32-byte stripe boundary (0, 1, 3, 4, 7, 8, 31, 32, 33, 63,
64, 65) because the tail path is where an XXH64 goes wrong.

One trap: a JS shift count is taken mod 32, so `h >>> 33` silently means
`h >>> 1`. The avalanche step needs the high half of that shift written as zero.

### Emit a content checksum, and always verify one — **Adopted** (opt-out returned later)

`src/compress/shared.ts`, `src/decompress.ts`, `src/stream.ts`

Every frame the encoder produces carries the 4-byte content checksum, and the
decoder verifies by default. The original landing removed every options bag and
made verification unconditional; an explicit `{ checksum: false }` returned on
2026-08-03 under hard constraints — see "Checksum opt-out returned, default-safe"
below. The encode half of this entry is unchanged.

The two halves are one change. A digest on encode is what makes verification
matter, and once it matters an accidental opt-out is a footgun — compressed data
carries almost no redundancy, so a damaged frame decodes to different
valid-looking bytes rather than erroring.

**What each decoder catches**, 400 single-bit flips per frame on a whole real
payload, classified as rejected vs returned-as-success-with-different-bytes.
Re-run this before reopening any of it.

With a checksum present, verifying is decisive and the only question is whether
a decoder bothers:

| decoder   |  caught | silently wrong |
| --------- | ------: | -------------: |
| wzstd     | **400** |              0 |
| zrip      |     400 |              0 |
| node:zlib |     400 |              0 |
| **fzstd** |  **82** |        **317** |

Without one, detection is purely structural — bounds, offsets, table validity:

| decoder   |  caught | silently wrong |
| --------- | ------: | -------------: |
| zrip      |     212 |            188 |
| **wzstd** | **210** |            190 |
| fzstd     |     135 |            265 |
| node:zlib |      88 |            312 |

Two things fall out. **fzstd never verifies at all** — the largest correctness
difference between us and the pure-JS peer we are most often benchmarked
against, and it belongs beside any speed comparison, since verifying is strictly
more work. And **structurally we are at parity with zrip and 2.4× stricter than
libzstd itself**, which is coherent: libzstd is tuned for throughput and leans on
the digest, while `DistanceTooFarBack`, `WindowSizeTooLarge`, FSE accuracy and
block bounds all fire here.

**Why the original landing had no opt-out.** zrip and `node:zlib` both verify
unconditionally and neither exposes a way off; only fzstd skips. The option was
defensible when the hash was slower than the decoder (2.4–3.0×) and looked less
so at ~1.11× — that was the reasoning that removed it. It came back later as a
labelled comparison tool and a deliberate trade for transports that already
guarantee integrity; default still verifies, and the product claim is still the
verifying path.

> Cost, interleaved A/B, one process per variant, whole files on the real corpus:
> **L3 encode 0.6–1.2%** (9.57/9.66 → 9.51/9.54 MB/s), **L1 encode 0.7–2.0%**
> (23.80/23.69 → 23.63/23.22), decode **~1.11×**, output **+4 bytes per frame**.
>
> Artifact cost is the one that is not negligible, and it lands on L1. `dist`
> total grows 151 B, but `compressL1` now pulls in `xxh64` (516 lines, 4,918 B
> raw / 1,510 gzipped), so an **L1-only bundle goes 12,501 → 17,634 B raw,
> 4,853 → 6,363 gzipped**. L3 and `decompress` already shipped it. That is ~1.5 KB
> gzipped on the level whose reason to exist is being small and fast — accepted,
> but it is the number to quote if anyone revisits this.

Verified against the reference implementations rather than only round-tripping
ourselves: zrip and `node:zlib` both accept our frames, and both verify the
digest themselves, so acceptance is independent confirmation the bytes are right.
Empty frames included — XXH64 of zero bytes is a defined value and the flag is
set, so a decoder trusting the flag reads four bytes either way.

### XXH64 stripe loop: keep every 64-bit intermediate in a local — **Adopted**

`src/xxh64.ts` · **7.0–8.8× on the hash, 2.4–4.4× on decode**

The entry above concluded that a faster XXH64 was worth more than a faster
decoder, and that "XXH64 does 8 64-bit multiplies per 32 bytes and that is
inherent, so do not assume another 4× is sitting there." The arithmetic was
indeed near its floor. **The cost was not the arithmetic — it was the calling
convention.**

`mulP1`/`mulP2` returned their 64-bit result through the module-level `rh`/`rl`
slots. Those are heap slots, not registers, and a `>>> 0` result above 2^30
cannot be a Smi — so every 64-bit multiply stored a tagged, probably freshly
allocated number. At eight multiplies per 32-byte stripe that is roughly
allocation-per-multiply, and it swamped the multiplies themselves. Writing both
multiplies out inline in the stripe loop, so no intermediate leaves a local,
removes all of it. The arithmetic is unchanged, byte for byte.

Two changes, measured separately, one process per variant, median of 3:

| variant                                        | 16 KiB | 128 KiB |   4 MB |     gain |
| ---------------------------------------------- | -----: | ------: | -----: | -------: |
| baseline (prime-specialised, via `rh`/`rl`)    |  212.1 |   166.2 |  131.7 |        — |
| six-multiply `mulP1`/`mulP2` (still via slots) |  258.3 |   204.0 |  161.7 |    1.22× |
| **both multiplies inlined into the loop**      | 1862.2 |  1168.9 | 1022.9 | **7.8×** |

The smaller change is worth recording on its own because it is real and
independent: a 64×64→64 multiply by a constant needs 16-bit limbs **only for
`al * CL`**, because only that partial product's high half survives. `al * CH`
and `ah * CL` contribute low 32 bits alone, which is exactly `Math.imul`. Ten
multiplies become six. But it is worth 1.22× against the inlining's 7.8×, which
is the whole point of the entry: **the limb count was never what this cost.**

End-to-end decode, verification **on** (the default), real-data corpus median,
one process per variant, median of 3 — and the checksum tax that remains:

| frame          | before | after |      gain | tax before | tax after |
| -------------- | -----: | ----: | --------: | ---------: | --------: |
| CLI `--fast=8` |  105.4 | 460.1 | **4.37×** |      5.49× |     1.26× |
| CLI level 3    |   84.4 | 223.2 | **2.65×** |      2.92× |     1.10× |
| CLI level 19   |   84.4 | 205.9 | **2.44×** |      2.69× |     1.10× |
| own L3         |  232.1 | 235.0 |     1.01× |          — |         — |

**Own L3 was the control in this row**, because the encoder emitted no digest at
the time and those frames never hashed; 1.01× is what "the change is entirely in
the hash" looks like. That control no longer exists — our encoder now emits a
digest on every frame, so `own-L3` pays the hash like every other shape. Future
XXH64 work needs a control built the other way: the same frames decoded with
`{ checksum: false }`, which is what `bench:decode` table 3 reports.

Verification is **no longer the pacing item on any frame shape.** The `--fast=8` row is
where it mattered most and still matters most: those frames are copy-bound and
decode so fast that even a 1.26× hash shows up.

Revisit condition: the hash is now within ~26% of no-verify on the fastest frame
shape, so further XXH64 work has little headroom left. Reopen only if a frame
shape appears where the tax is above ~1.5×.

### The redundant state carry in `dhu` — **Adopted**

`src/decompress.ts` · 2026-08-03

`dhu`'s inner loop was `st = ((st << btr) | val) & msk`. That OR is inherited
from fzstd, where it was **load-bearing**: fzstd assembled `val` from two byte
loads, so after shifting by `pos & 7` it held as few as 9 valid bits and could
not span an 11-bit code — the high end of the state had to come from the state
it already had. Since wide loads shipped, `val` is a `getUint32` and carries at
least 25 valid bits, so the field at `pos` arrives whole and the OR contributes
**the same bits the load already has**: the two reads overlap by construction,
because `pos` moved down by exactly `btr`, so `val`'s bits `[btr, b)` are `st`'s
bits `[0, b - btr)`. Now just `st = val & msk`, which also drops `btr` as a
loop-carried local.

Measured against a byte-identical control (5 repeats, quiet machine, floor
±0.2%): **+2.4% extra own-L3, +1.0% extra lvl3, +1.0% synthetic own-L3.** `dhu`
is ~20% of decode, so that is the Huffman loop itself getting ~12% faster from
dropping two ops — the plain reading, and the one that survived measurement.

The general lesson is worth more than the change: **wide loads invalidated an
assumption three lines away from where they landed, and nothing failed.** The
old code stayed correct, just wasteful. Re-read the loops a wide load feeds for
narrow-load workarounds that are now dead.

### Two bitstream fields per wide load in the sequence loop — **Adopted**

`src/decompress.ts` · 2026-08-03

The sequence loop took six wide loads per sequence. Adjacent fields are narrow
enough that two pairs each fit in one:

|                     | bits | floor a load guarantees |
| ------------------- | ---: | ----------------------: |
| ll extra + LL state | ≤ 25 |                      25 |
| ML state + OF state | ≤ 17 |                      25 |

A byte-unaligned `getUint32` shifted by `spos & 7` carries `32 - (spos & 7)`
valid bits, so **at least 25**. Both pairs clear that unconditionally, which is
the whole point: no guard, no branch, no cached word — the three shapes that
made every earlier load-saving attempt here cost more than it saved (packed
Huffman, packed FSE, the `r32` word cache). Six loads become four.

**+0.7–0.9% on CLI frames, 0.999× (neutral) on our own**, both outside a ±0.2%
floor. The asymmetry is the mechanism showing itself: this touches only the
sequence loop, and our own L3 output is literal-heavier, so more of its decode
sits in `dhu`. It does not lose on any row.

Signed `>>` was measured as a variant, on the theory that keeping the shared
word an int32 rather than an Unsigned32 above 2^31 would avoid a boxed
intermediate. **Dead heat** (1.007–1.008× vs 1.008–1.009×), so the `>>>` form
shipped: same result, and it keeps the file's single documented rule instead of
adding a sign-extension carve-out to the hottest loop. TurboFan was already
keeping that value in a register.

_Do not widen the pairs._ 25 bits is the floor, and LL+ML+OF states together are
26 — fusing all three needs a guard, which is what loses.

### Unguarded reads of derived structures — **Adopted**

`src/decompress.ts` · 2026-08-03

The decoder now reads its **own derived structures** — FSE and Huffman tables,
the code tables, the offset history, the output buffer — with raw indexing, and
keeps the guarded `at()` on every read of **untrusted input** (`dat`, `chunk`,
and `rb`/`b4`'s `d`). 45 sites raw, 66 guarded.

**+4.4% own-L3, +5.2% fast8, +6.4% lvl3**, against a byte-identical control
(floor ±0.2%). The largest decode win on the board.

Three corrections to the record came out of getting here, and they matter more
than the number:

**1. The cost is the call, not the guard, and not the type flag.** Dropping the
`?? 0` while keeping the helper is worth **1.000×** — nothing, on every shape.
Removing the _call_ is worth 5–8%. `noUncheckedIndexedAccess` **stays `true`**
repo-wide; the sites use `!` under the file-scoped lint override
`src/decompress.ts` already carried. That emits **byte-identical JS** to a build
with the flag off, which is how we know the flag was never the price. The
old entry framed this as a gain-versus-durability trade. There was no trade.

**2. The safety question is where the value flows, not whether the index is in
range.** `at` maps OOB to **0**; raw indexing yields `undefined`:

| flow                      | `at` | raw                   | same?  |
| ------------------------- | ---- | --------------------- | ------ |
| typed-array store         | 0    | `undefined` → **0**   | yes    |
| bitwise (`\|`, `&`, `<<`) | 0    | `undefined` → **0**   | yes    |
| arithmetic (`+`, `*`)     | 0    | `undefined` → **NaN** | **no** |

That third row is why raw-indexing _everything_ was rejected even though it
measured slightly faster. `rb()` does `o += d[b + i] * 256 ** i`, so a truncated
header yields `NaN`; and `NaN > 2145386496` is **false**, so the window-size
check fails open, `Math.min(131072, NaN)` is `NaN`, and `new Uint8Array(NaN)` is
length 0. Two fail-closed checks turned fail-open. All 493 tests passed on that
build.

**3. Sizing to the index domain beats checking the index.** `llbl[llc] + extra`
is an arithmetic consumer, and `llc` comes from an FSE table a corrupt frame can
make **any value to 255**, against tables of 36 and 53. The four static code
tables (`llb`, `llbl`, `mlb`, `mlbl`) are now **256 entries**, zero past the
valid codes — in bounds by construction, yielding the same 0 the guard did.
Baselines are computed on the narrow table first so the padding is genuinely
zero. This is the same move `pad()` makes for the bitstream: establish the
invariant once, then never check. It costs ~1% against the unpadded version
(1 KB arrays instead of 212 B) and buys the removal of a fail-open class.

> **Superseded 2026-08-03** by "Bound the symbol, not the table" below. Widening
> the array was the right instinct pointed at the wrong end: the index is
> bounded at its source now, the tables are narrow again, and the ~1% came
> back — on the shape that actually runs the sequence loop.

**How it was verified, which is the reusable part.** A `?? 0` silently absorbs
exactly the bug you are looking for, so tests cannot see it — 493 of them
passed while these reads were going out of bounds. The evidence came from an
**instrumented build where every unguarded read throws on `undefined`**, driven
through the full suite and the extra corpus. It fired only on `buf`, only at
exactly one past the end, and only where the value's single destination is a
`Uint8Array` store — the provably-equivalent row above. Everything else was
silent. `tests/unguarded_reads_test.ts` is the standing version: byte-flip,
truncation, NaN-length and streaming-agreement sweeps.

_Revisit only if:_ a change makes an unguarded read feed arithmetic. Rebuild the
trap variant rather than trusting the suite.

### Checksum opt-out returned, default-safe — **Adopted**

`src/decompress.ts`, `src/stream.ts`, `src/index.ts` · 2026-08-03

`ZstdDecodeOptions` is the single options bag for one-shot and streaming decode:
`{ out?, checksum? }`. Default for `checksum` is `true`; leaving it out, passing
`undefined`, or passing `{}` all verify; only an explicit `false` skips the hash.
No positional second argument, no positional boolean, no separate "fast" entry
point. `out` is one-shot only (streaming does not own the output). The opt-out
disables **the hash only** — truncation before the digest still throws
`UnexpectedEOF`, and every structural check stays on.

**Default-safe by construction.** Integrity you have to remember to ask for is
integrity nobody has — that is still the default path. The opt-out is a
**named, deliberate** trade (transport already guarantees integrity, or a
labelled like-for-like bench against fzstd), not a silent second mode.
`tests/checksum_test.ts` pins every safe spelling still throws, and that naming
`false` does reach the bytes.

**Two comparison numbers, never conflated.** Current values are the three-run
row in "Decode product claims" under Open threads — `vs-fz` **1.06×**, `nv/fz`
**1.18×**, verification cost **1.12×** on lvl3. The figures first recorded here
(1.11× / 1.25× / 1.125×) were taken from a single run and did not survive
remeasurement; that entry has the detail.

`bench:decode` layout: (1) shape sweep (2) peers + vs-fz (3) cost-by-shape
including own-L1 (4) nv/fz. Full-set noverify so cost is fair. State both speed
claims labelled; never quote `nv/fz` as "our decode speed vs fzstd" unqualified.

**`bench:summary` is not a second source of `vs-fz`.** That table builds frames
via `node:zlib` with FCS (exact output buffer) and prints absolute medians per
decoder × shape. `bench:decode` builds CLI frames over a pipe (no FCS → growing
buffer) and reports median-of-per-payload ratios. A same-day run had summary
absolutes at wzstd-lvl3 250.9 vs fzstd 255.3 — which is **not** a 0.98× claim and
must not be written as one. The verification cost is the part that agrees across
both harnesses (~1.13× on lvl3 either way); the peer-relative claim lives only
in `bench:decode`. Footer on both scripts now says so.

Artifact: `decompress.js` ~9.67 kB after the option + bag API.

_Revisit only if:_ a safer default spelling is found that still lets a deliberate
skip; or if a second option is proposed — add it only when it has its own
default-safe story.

### Bound the symbol, not the table (`rfse` symbol-range validation) — **Adopted**

`src/decompress.ts` · 2026-08-03

`rfse` now takes the largest symbol its code space admits — **LL 35, ML 52,
OF 31**, and **11** for the Huffman weight alphabet — and rejects a table
description above it. With every producer bounded at its source, the four static
code tables go back to their real widths (36 and 53 entries), undoing the 256-entry
padding of the entry above.

**Measured against a byte-identical control, extra corpus, 5 interleaved repeats:**

| shape  | control |    change | per-file sign test |
| ------ | ------: | --------: | ------------------ |
| own-L3 |  0.9991 |     1.000 | scattered          |
| lvl3   |  1.0005 | **1.010** | **8 of 8 up**      |
| fast8  |  1.0031 |     1.002 | scattered          |

**+1.0% on CLI level-3 frames, neutral elsewhere** — not the ~1% on every shape
the old entry projected. The 8/8 per-file consistency is what carries the lvl3
row, since the median alone is only ~3× the control's deviation; on `fast8` the
control drifted further than the effect being looked for, so that row cannot
vote either way.

The asymmetry is the mechanism showing itself, and it is the **same signature as
the two-fields-per-load change** ("+0.7–0.9% on CLI frames, 0.999× on our own"):
this touches only the sequence loop. `llbl` + `mlbl` drop from 2,048 B to 356 B
of hot static data (2,560 → 445 B across all four tables), our own L3 output is
literal-heavier so more of its decode sits in `dhu`, and `fast8` frames are
copy-bound. Artifact: `decompress.js` 9,474 → 9,424 B minified.

**The correctness half is the larger half, and it found a live bug.** Two frames
were accepted that the host `zstd` CLI rejects, both returning **wrong bytes as
success** on a frame carrying no checksum to catch it:

| frame                              | before               | now         | host `zstd` |
| ---------------------------------- | -------------------- | ----------- | ----------- |
| OF **RLE** sequence table, code 32 | returned `"abcdddd"` | `ZstdError` | rejects     |
| LL FSE table naming symbol **36**  | returned `"abcdabc"` | `ZstdError` | rejects     |

**The RLE path is the one the design note missed.** `Symbol_Compression_Mode 1`
takes its single code straight from an input byte and never passes through
`rfse`, so bounding `rfse` alone would have left the narrow tables indexed by an
unchecked 0–255 value — reintroducing exactly the `NaN` fail-open the padding
existed to close. Both entry points are checked now. Note also that padding
never protected the OF path at all: there is no OF code table, `ofc` is used
directly as a shift, and `1 << 32` wraps to `1`.

**How it was verified.** Hand-built minimal frames (4 raw literals + 1 sequence),
because our encoder emits neither an RLE sequence table nor an over-range symbol,
so nothing in either corpus reaches these paths. The in-range fixtures are
checked against the **host `zstd` CLI**, not just our own decoder — the first
draft's "valid" FSE fixture left one bit unconsumed in the sequence bitstream and
`zstd` rejected it too, which would have made every rejection below it vacuous.
The over-range FSE fixture is otherwise well-formed: 31 of its 32 states carry a
legal code, and it decodes to the correct bytes on a build without the bound.
`tests/sequence_tables_test.ts`, "sequence codes are bounded at their source".

Matches libzstd, which bounds the same value in `FSE_readNCount` and rejects an
out-of-range RLE byte. The spec forbids these symbols, so no valid frame is
affected — and the new rejections are frames `zstd` already refuses, which makes
this an interop fix rather than added strictness.

_Revisit only if:_ a new `Symbol_Compression_Mode`, or any other path, can put a
code into the sequence loop without passing one of these two checks. The bound is
now load-bearing for the table widths — narrowing a table further, or widening a
code space, has to move together.

### Decoder — rejected and declined

**Two Huffman symbols per wide load (`dhu` pairing) — Rejected.**
`src/decompress.ts` · 2026-08-03

The closest thing to the long-parked "bit accumulator on top of wide loads": a
code is at most `hu.b` ≤ 11 bits, so a symbol and its successor span ≤ 22 and
one `r32` can feed both, halving loads in the Huffman loop. Implemented as a
paired loop guarded by `pos > 0` (which makes the second symbol's position
legitimate without re-testing it) plus the existing scalar loop as the tail,
which keeps ownership of the exit checks. Correct — 492 + extra corpus green.

**~1.8% slower than plain `dhu`** (1.006× vs 1.024× against the same base,
extra own-L3). The second loop and its tail cost more than the loads saved.
That is now the sixth load-reducing reshape to lose here, and the pattern is
firm: **on this decoder, work removed pays and work traded does not.** The
adopted fusion above is not a counterexample — it removes loads without adding a
loop, a branch, or an unpack.
_Revisit only if:_ a form appears with no second loop and no tail — which for a
variable-length code is close to a contradiction.

**Packed Huffman table `(nbits<<8)|symbol` for `dhu` — Rejected.**
One `at()` per symbol instead of two (`s` then `n`). Built a parallel
`Uint16Array` in `rhu` and a `dhu` path that unpacks it. Isolated A/B on
own-L3 frames of the four largest extra files (200ms target, 7 trials): median
**0.99×** of the split-table path — noise or a slight loss (extra table build

- branch). Not shipped.
  _Revisit only if:_ a reshape that also removes a load from the sequence loop
  (where FSE hits `s`/`n`/`t` three streams deep) shows a real gain. **See
  "Packed FSE sequence tables" below — that revisit was tried and rejected.**

**Packed FSE sequence tables `(t<<16)|(n<<8)|s` — Rejected.**
`src/decompress.ts` · 2026-08-03

The open-thread hypothesis after packed Huffman failed: three FSE streams ×
three arrays (`s`/`n`/`t`) is nine loads per sequence; one `Uint32Array` per
stream is three. Implemented end-to-end (rfse builds packed, weight-header FSE
and the sequence loop unpack, RLE mode packs a single entry). Correctness green
(492 + extra corpus). Throughput was not:

|                         | own-L3 |  lvl3 | vs-fz |
| ----------------------- | -----: | ----: | ----: |
| baseline (extra median) |  225.9 | 201.5 | 0.99× |
| packed FSE              |   99.4 |  89.0 | 0.42× |

~0.44× of the prior decoder. fzstd/zrip columns held steady, so this is our
code, not machine load. The unpack shifts cost more than the loads they save —
same shape as the Huffman pack, just worse because the sequence loop also pays
for three streams' worth of masking. Reverted.
_Revisit only if:_ a layout that needs no per-field unpack (e.g. three parallel
typed arrays already the right shape for a SIMD-style gather JS does not have).

**Cached `r32` word in the sequence / Huffman loops — Rejected.**
`src/decompress.ts` · 2026-08-03

Idea: consecutive bitfields often share a byte address, so remember the last
`getUint32` by its byte index. Tried as (a) a `bitsAt(pos, n)` closure in the
sequence loop and (b) an inlined cache in `dhu`. Both correct; both slower on
the extra-corpus isolate bench (vs-fz **0.63×**, own-L3 172 vs 226 baseline).
The branch + helper call is more expensive than a second unguarded `getUint32`
on this path. Reverted.
_Revisit only if:_ measured with a fully inlined cache and a counter showing the
hit rate is actually high (it may not be once field widths are random).

**Hoisting FSE table properties out of the sequence loop — Noise.**
`llt.s` → local `llts` etc. before the loop. Extra-corpus isolate run was
indistinguishable from baseline (vs-fz still 0.99×; columns moved within the
run-to-run band). Not worth the visual weight. Reverted.

**Raw indexing instead of the OOB-guarded `at()` helper — Declined, then
adopted in a different form after the diagnosis turned out to be wrong.**
`at(d, i)` is `d[i] ?? 0`, present only to satisfy `noUncheckedIndexedAccess`;
fzstd indexed directly. The profile attributes 64–68% of decode self-time to that
line, which makes it look like the obvious target. Replacing it with an unchecked
read across the whole decoder is worth **1.03–1.08×** — the line is hot because
it contains every memory load in the decoder, not because of the `?? 0`. Not
worth weakening the type guarantees for.

**Superseded 2026-08-03.** The size was right and the attribution was wrong. See
"Unguarded reads of derived structures" — the cost is the **call**, not the
`?? 0` and not the tsconfig flag, and the flag did not have to move.

**Splitting `at` into one helper per element type — Rejected.**
`src/decompress.ts` · 2026-08-03

Hypothesis for the above: `at` is typed `ArrayLike<number>` and called with
Uint8Array, Uint16Array, Int16Array and Int32Array — four maps at one load site,
exactly V8's polymorphic limit, so the read goes megamorphic. Split into
`at`/`atw`/`ati`/`atl`, one per element type, each with a single monomorphic
load. The type checker confirmed the classification at all 111 sites (92 u8, 9
u16, 1 i16, 9 i32) and it passed 493 tests.

Measured **0.834× own-L3, 0.869× fast8, 0.851× lvl3** — not "no help", 15%
_slower_ than the generic helper. V8 handles one general small function better
than four specialised ones; the likely cause is inlining budget in an already
enormous `rzb`. Refuted cleanly and worth recording, because the hypothesis is
the one any reader of the megamorphic-IC literature would form next.
_Revisit only if:_ someone has a V8 trace showing the IC state, rather than an
inference from the type signature.

**Bit accumulator for the sequence bitstream — Rejected.**
Standard native-decoder technique: hold 32 bits and refill, instead of a fresh
3–4 byte load per field. Measured **~1.5× slower** than the current per-field
loads (297ms vs 198ms on a representative field-width mix). Per-byte refill
shifts and the refill loop's branches cost more than JS unaligned byte loads do.
_Revisit only if:_ paired with a wide-load refill (below) rather than byte loads.
**That revisit is now closed.** The wide-load path shipped, and the two things
it enables were both measured end-to-end in 2026-08-03: a **word cache** (0.63×)
and **`dhu` pairing** (0.98× of plain `dhu`), which is an accumulator holding
exactly two symbols. Both lose for the same reason the byte-refill form did —
the state a refill needs costs more than JS unaligned loads do. What _did_ pay
was taking two fields out of one load with no state at all (see the adopted
entry above). Treat "hold bits across iterations" as refuted on this decoder;
"take more out of a load you already made" is the live idea.

### Wide bitstream loads via `DataView` — **Adopted**

`src/decompress.ts` (previously declined; see the entry below for
why the first attempt failed)

Every bit-field read assembled a word from 2–4 separate byte loads. One
`getUint32` replaces each. The blocker was bounds: **any per-read guard erases
the whole gain** (74ms guarded vs 65ms for the byte-load loop it replaces, 27ms
unguarded — the branch costs more than the loads it saves). So the check is
hoisted out of the loop entirely and paid once, per call, as an invariant:
`pad()` copies the input into a zero-filled buffer with `PAD = 8` bytes of slack
on **both** sides, and every hot read is unguarded.

Both sides matter, and the leading side is the subtle one:

- **Trailing** slack, because a read loads a 32-bit word at the byte holding its
  lowest wanted bit and so reaches 3 bytes past it. Those bytes are masked off —
  they only need to be _readable_.
- **Leading** slack, because the backward bit readers let `pos` go slightly
  negative on a stream's final symbols. `at()` returned 0 there and the decoded
  value **depends on that zero**, so the leading bytes must genuinely be zero,
  not merely readable. This is why a padded view is always a fresh copy rather
  than a reuse of an input that happens to have room — and why the first
  implementation, which only padded the tail, broke 20+ tests.

Isolated A/B, 4 MB slices, median of 7 trials per process, two runs:

> **CLI level 3:** 1.64–1.93× · **CLI level 19:** 1.51–1.71× · **our own L3:** 1.55–1.66×
> · **CLI `--fast=8` (negative band):** 1.02–1.17×

The negative band gains least, which is the expected shape: those frames are
mostly raw literals and long matches, so they lean on the copy paths rather than
the bitstream. That column was added to `bench:decode` in the same session and
justified itself immediately.

Cost: **+40 B raw / +72 B gzipped**, plus one copy of the _compressed_ input per
call (well under 1% of decode).

Corrupt input can drive the bitstream position far outside the padded slack,
where `getUint32` throws `RangeError` instead of the documented `ZstdError`.
Both entry points convert it. 24,000 corrupted-frame trials produce no
non-`ZstdError` escape.

**`DataView.getUint32` for wide bitstream loads — first attempt, superseded.**
Recorded because the failure mode is the reusable lesson: the gain is real
(1.29× on a realistic multi-field mix, 2.4× single-field) but **evaporates the
moment a bounds check goes inside the loop**. Three guard shapes were measured —
ternary 74ms, index clamp 403ms, try/catch 82ms — against 65ms for the plain
byte-load loop and 27ms unguarded. Only hoisting the check out of the loop
worked (29ms). See the adopted entry above.

**Bulk-copy threshold (the `>= 16` cutoffs) — Declined.**
Swept 4/8/12/16/24/32/64 for the literal, window, and match copy loops. No
reliable signal; 16 is already at or near the best value, and the sweep's spread
was dominated by same-process measurement noise.
_Revisit only if:_ re-run with the isolated-process harness and a specific
hypothesis (e.g. separate thresholds for overlapping vs non-overlapping matches).
**That revisit is now closed (2026-08-12).** Isolated A/B on cached Silesia
frames (`scripts/ab_decode.ts`, same blob for every variant):

| variant                                         | vs-fz | own-Fast | fast8 |  lvl3 |
| ----------------------------------------------- | ----: | -------: | ----: | ----: |
| baseline                                        | 1.13× |    367.1 | 490.9 | 247.6 |
| chunked `copyWithin` for overlapping `off ≥ 16` | 1.12× |    360.7 | 488.4 | 244.4 |
| `off == 1` → `fill`                             | 1.11× |    358.2 | 483.4 | 242.4 |
| skip zero-width OF/ML extras + `dhu` locals     | 1.11× |    362.5 | 488.8 | 244.8 |

The overlapping-chunk idea was the specific hypothesis the declined entry named.
It is work _traded_ (a second loop) and lost like every other trade on this
decoder. Distance-1 fill and skipping empty extra-bit loads add a branch per
sequence; both lost. Reverted. `pnpm bench:ab-decode` stays as the cached-frame
harness so the next attempt does not rebuild CLI frames.
_Revisit only if:_ a copy reshape with **no** extra loop and **no** per-sequence
branch.

---

## Open threads

### Decode product claims — **three runs, 2026-08-04**

`pnpm bench:decode --extra-only`, quiet machine, MEDIAN extra, MB/s of output.
**These are the numbers to quote.** Three consecutive full runs of unchanged
source at `dbbaf79`, nothing else on the machine; the row below is the median of
the three.

| own-L1 | own-L3 | fast8 |  lvl3 | lvl19 | fzstd |  zrip | lvl3-nv |     nv/fz |     vs-fz | zrip/us |
| -----: | -----: | ----: | ----: | ----: | ----: | ----: | ------: | --------: | --------: | ------: |
|  275.5 |  250.0 | 427.7 | 243.4 | 238.6 | 217.1 | 845.0 |   272.5 | **1.18×** | **1.06×** |    3.3× |

Per-run, to show the spread rather than assert a single reading:

| run |  lvl3 | fzstd |  zrip | vs-fz | nv/fz |
| --- | ----: | ----: | ----: | ----: | ----: |
| 1   | 243.9 | 217.1 | 844.6 | 1.06× | 1.19× |
| 2   | 240.1 | 216.9 | 847.6 | 1.05× | 1.18× |
| 3   | 243.4 | 219.6 | 845.0 | 1.06× | 1.17× |

Run-to-run drift on our lvl3 column is **1.6%**, and the peer columns move under
1.3%, so ±2% is the resolution here and the 0.01 spread on `vs-fz` is noise.

**`vs-fz` is 1.06×** — ahead on a typical payload **while we verify the content
checksum and fzstd never does**. That is the default claim. **`nv/fz` is 1.18×**
— both sides skipping; like-for-like, labelled, never quoted bare as "vs fzstd".

`vs-fz` has a strong size gradient, and quoting the median alone hides it:

| payload            |     bytes |      vs-fz |
| ------------------ | --------: | ---------: |
| county-hi          |   108,126 | 1.22–1.25× |
| school_district-hi |   130,201 | 1.15–1.19× |
| federal_house-wy   |   204,291 | 1.04–1.11× |
| federal_house-nd   |   743,450 | 1.04–1.06× |
| municipality-ak    |   813,121 | 1.05–1.06× |
| municipality-nd    | 1,822,600 | 1.05–1.06× |
| state_house-ma     | 3,945,199 | 1.01–1.03× |
| school_district-wy | 4,000,000 |      1.04× |

We are clearly ahead on ~100 KB payloads and near parity on multi-megabyte ones,
which is the expected shape: per-call setup is a larger share of a small decode,
and that is where the two implementations differ most.

Cost of verification by shape (table 3, median of the three runs):

| own-L1 | own-L3 |  fast8 |   lvl3 |  lvl19 |
| -----: | -----: | -----: | -----: | -----: |
| 1.147× | 1.116× | 1.238× | 1.118× | 1.120× |

`fast8` pays most because it is copy-bound — there is less decode work for the
hash to hide behind, not a more expensive hash.

#### The 1.11× that was not there

The previously recorded claim was **`vs-fz` 1.11× / `nv/fz` 1.25×**. It does not
reproduce, and the code did not change: the working tree was clean at the very
commit that recorded it. The absolute columns reproduce fine (lvl3 243.5 → 243.4;
fzstd 221.4 → 217.1). Only the ratio moved, which localises the fault to the
statistic rather than the machine or the build.

The mechanism: **1.11× is the ratio of the medians** (243.5 ÷ 221.4 = 1.100),
written into a cell that holds the **median of per-payload ratios**. Two
independent checks agree it was the substitution and not a real reading:

- Every other recorded run has median-of-ratios _below_ ratio-of-medians —
  0.98× against 1.021, and 1.00× against 1.035. The disputed row is the only one
  above, and it sits almost exactly _on_ the ratio of medians.
- The ledger attributed the 1.00× → 1.11× move to the `rfse` symbol bound plus
  machine variance, but that bound measured **+1.0%**, and the checksum opt-out
  does not touch the default verifying path at all. An 11% claim resting on a 1%
  measurement.

The lesson generalises past this number: the repo already knew that _a recorded
explanation is a hypothesis_. This is the same failure one level down — **a
recorded measurement is only evidence of what was measured**, and a ratio copied
from the wrong column is not a measurement of anything. Ratios published from a
single run should be reproduced before they are quoted; absolutes were stable
across every run here while the ratio was the fragile part.

`bench:summary --extra-only`, same session (encode side):

| encoder         |  ratio | saved |   MB/s |  vs L3 |
| --------------- | -----: | ----: | -----: | -----: |
| wzstd L1        | 0.4793 | 52.1% |   27.1 |  1.97× |
| wzstd L3        | 0.2213 | 77.9% |   13.8 |  1.00× |
| zrip -1         | 0.3566 | 64.3% |  259.9 | 18.86× |
| zrip -3         | 0.3318 | 66.8% |  224.2 | 16.27× |
| node:zlib fast8 | 0.6993 | 30.1% | 1017.6 | 73.84× |
| node:zlib -3    | 0.3319 | 66.8% |  350.7 | 25.45× |

Encode reproduces the prior row on every cell — ratios are deterministic and the
speeds land within 1.5%. Nothing on the encode side needed correcting.

Decode absolute medians from summary are **not** a second `vs-fz` (CLI-no-FCS vs
node:zlib-with-FCS frames; different aggregation). Streaming decode held at
0.92–0.99× of one-shot verifying on the four shapes.

### Result-grade re-measure (after the two decode changes, pre-opt-out) — **2026-08-03**

`pnpm bench:decode --extra-only`, quiet machine, MEDIAN extra, MB/s of output.
Predates the `rfse` symbol bound and the checksum opt-out; kept for the A/B
corroboration note.

| own-L1 | own-L3 | fast8 |  lvl3 | lvl19 | fzstd |  zrip |     vs-fz |  zrip/us |
| -----: | -----: | ----: | ----: | ----: | ----: | ----: | --------: | -------: |
|  254.2 |  236.3 | 405.9 | 223.7 | 226.5 | 216.1 | 843.3 | **1.00×** | **3.5×** |

**Read the peer columns first.** `fzstd` 216.1 against 211.3 on 2026-07-31 and
`zrip` 843.3 against 838.2 — both untouched code, both within ~2%, so this
machine is comparable to the one that produced the reference row and our columns
mean something. That check is not decoration: the **first** attempt at this run
came back with every column at 0.67–0.75× of reference, fzstd and zrip included,
because Chrome was using ~190% CPU. A uniform sag across implementations we do
not maintain is machine state, and the run was discarded rather than published.

**`vs-fz` reached 1.00×** at this point — parity on a typical payload while we
verify the content checksum and fzstd never does. The `rfse` symbol bound landed
after this row and carried it to the current **1.06×**; see "Decode product
claims" above for the three-run measurement.

It also **corroborated the A/B independently**, which is the reason to trust it:
the controlled A/B put the two changes at 1.010 × 1.009 ≈ **+1.9%** on lvl3
frames, and `vs-fz` moved 0.98× → 1.00×, **+2.0%**. Two different harnesses,
two different statistics, same answer.

Do not read the absolute deltas against 2026-07-31 as the size of the change —
that is a cross-run comparison, and the peer columns show this machine running
~1–2% quicker. The A/B against a byte-identical control is the measurement; this
table was the product-facing statement at the time.

### Result-grade re-measure (fixed isolate harness) — **2026-07-31**

First full run after process isolation, once-per-run `rate()` calibration, and
per-corpus medians. Load averages ~3–6 (not quiet-ideal; not the old 36–95).
Quote the **extra** rows; synthetic still sits in cache and reads high.

**Decode** (`pnpm bench:decode --extra`, MEDIAN extra, MB/s of output):

| own-L1 | own-L3 | fast8 |  lvl3 | lvl19 | fzstd |  zrip |     vs-fz |  zrip/us |
| -----: | -----: | ----: | ----: | ----: | ----: | ----: | --------: | -------: |
|  251.1 |  224.5 | 399.0 | 215.7 | 219.9 | 211.3 | 838.2 | **0.98×** | **3.6×** |

`vs-fz` is the median of per-payload ratios (wzstd lvl3 / fzstd lvl3). At
parity while we verify and fzstd never does — state it that way.

**Encode** (`pnpm bench:encode --extra --peers`, whole-file ratio + median MB/s):

| encoder         |  ratio | saved | MB/s | vs L3 |
| --------------- | -----: | ----: | ---: | ----: |
| wzstd L1        | 0.4793 | 52.1% | 25.9 | 2.02× |
| wzstd L3        | 0.2212 | 77.9% | 12.8 | 1.00× |
| zrip -1         | 0.3566 | 64.3% |  260 | 20.3× |
| zrip -3         | 0.3318 | 66.8% |  220 | 17.1× |
| node:zlib fast8 | 0.6993 | 30.1% | 1004 | 78.4× |
| node:zlib -3    | 0.3319 | 66.8% |  360 | 28.1× |

L1 is **2.02×** L3 speed for **2.17×** the output on real data. L3 **beats**
zrip -3 and libzstd -3 on ratio (0.221 vs 0.332). Absolute L3 encode ~13 MB/s
vs ~220–360 peer — the ~17–28× gap that open thread #1 still owns.

Pre-isolation MB/s figures in older rows of this ledger are **not comparable**.

1. **L3 encode throughput** — still the headline item, but **2.14× closer**: the
   minimum-length filter, the contiguous candidate ring and `patience` 2 together
   cost +0.24% of size (see the three adopted entries). The `HASH_BITS` lead that
   sat here is now measured and rejected — 92% of chain probes are genuine data
   repeats, not collisions.
   What binds now, and where to go next:
   - **Extensions are no longer the cost.** They were ~43% of L3 encode time and
     are down 83%. The chain walk is what is left — ~601M probes, one hash-array
     read each.
   - Reducing probes costs ratio. That curve is priced in the `patience` entry.
     `nullPatience` 12 (**3.02× for +2.11%**) is **taken and in the tree** — the
     competitive ratio table it was waiting on now exists and clears it (L3
     0.221 vs `node:zlib -3` 0.332 on the 2026-07-31 re-measure). What is still
     unresolved is **speed**, not size.
   - Absolute MB/s re-measured on the fixed harness (extra corpus): L3 **~13 MB/s**,
     L1 **~26 MB/s**, zrip -3 **~220**, node:zlib -3 **~360**.
   - **CPU profile (2026-07-31):** own process, `municipality-nd` (1.82 MB), one-shot
     after warmup → **~9.3 MB/s**, ratio 0.272. Minified self-time is **~80% in
     `dist/shared-*.js`** (matcher / chain walk), ~3% in the L3 chunk, ~1% in
     XXH64 stripes — consistent with "extensions are no longer the cost; the
     chain walk is what is left."
   - **Probe counters + lever sweep (2026-07-31):** `pnpm bench:match-stats
     --extra-only --sweep`. See "L3 `patience` 2 → 1" and "Match work counters"
     entries below. `chainLimit` never exits the walk under current patience
     budgets; lazyDepth cuts cost ratio hard; `nullPatience` 10 is still the
     paid side of the curve. Remaining headroom is still the nullPatience /
     genuine-repeat chain, not free.

### Match work counters (`withMatchStats`) — **Adopted (instrumentation)**

`src/compress/shared.ts`, `pnpm bench:match-stats`

Optional counters around `bestMatchAt`: searches (primary vs lazy), chain
probes, filter/needle passes, improvements, and walk exit reasons. Enabled only
inside `withMatchStats(() => …)` so the shipped encode path pays a null check.
Deterministic — use these before wall-clock for "does this do less work?".

Baseline on the extra corpus (8 files / 11,911,042 B), shipped L3 before the
patience-1 change:

| metric                      |                     value |
| --------------------------- | ------------------------: |
| probes                      |                51,902,341 |
| searches (primary / lazy)   | 6,787,745 (66.2% / 33.8%) |
| exit nullPatience           |                     54.0% |
| exit patience (after a hit) |                     40.1% |
| exit chainLimit             |                      0.0% |
| exit noCandidate            |                      5.9% |
| filter+needle pass / probes |                     25.3% |

**Read of the exit mix:** both patience budgets are live; `chainLimit` is not
binding at 24 under `nullPatience` 12 / `patience` 2. Lazy look-ahead is a third
of all searches. The old "92% of probes match the needle" figure was a different
counter definition; under the joint minLen-1 + 4-byte filter, 25% of probes
enter `matchLengthAt`.

### L3 `patience` 2 → 1 — **Adopted**

`src/compress/l3.ts`

After a match is found, abandon the walk after **one** non-improving probe
instead of two. Measured with the counters above on the extra corpus:

| config             |   Δsize | Δprobes |
| ------------------ | ------: | ------: |
| **patience 1**     | +0.015% |  −5.41% |
| nullPatience 10    | +0.447% | −13.64% |
| pat1 + null10      | +0.459% | −19.06% |
| pat1 + lazyDepth 2 | +0.578% |  −9.98% |
| lazyDepth 2 alone  |  +0.57% |   −5.8% |
| lazyDepth 1        |  +3.91% |   −9.8% |
| lazyDepth 0        |  +11.8% |  −11.3% |
| chainLimit 20/16   |   0.00% |    0.0% |

**patience 1 is nearly free work** — ship it. nullPatience 10 is still the
paid side of the curve already priced in the asymmetric-cutoff entry. lazyDepth
cuts cost more size than work. chainLimit is a no-op at current budgets (0% of
exits).

_Revisit if:_ a corpus appears where exit chainLimit is material, or where
patience-after-hit exits fall well below ~40%.

### Lazy look-ahead score floor — **Adopted**

`src/compress/shared.ts` · `bestMatchAt`

Lazy look-ahead called `bestMatchAt` as if hunting a first find: `bar = 1` and
`nullPatience` 12, then the outer loop discarded anything that did not beat
`kept.score + deferred-literal bias`. A third of all searches are lazy
(match-stats), so most of that nullPatience budget was spent on matches the
caller would throw away.

Push the score the lazy match must beat into the walk as `scoreFloor`:

1. minLen uses that bar from probe 0 (same exact filter as an incumbent of that
   score — never rejects a winner).
2. The short post-hit `patience` budget applies from the start, because a usable
   match already exists outside the call.
3. Only matches strictly above the floor are returned.

A/B on the extra corpus (deterministic, vs patience-1 baseline):

|                 |                  probes |                     size |
| --------------- | ----------------------: | -----------------------: |
| before          |              49,095,444 |                2,635,332 |
| **score floor** | **45,420,768 (−7.48%)** | **2,635,503 (+0.0065%)** |

Nearly free on **work and size**. Stacks with patience 1. Primary searches are
unchanged; lazy searches stop early instead of burning nullPatience.

**Wall-clock follow-up (extra-only encode, isolated, quiet-ish machine):** L3
median **13.7 MB/s** with the floor vs **13.9 MB/s** without — within noise, not
a demonstrated throughput win. Probe count is the reliable signal here; do not
quote a speedup from the score floor until a quieter multi-run median says so.

_Revisit if:_ a change to the lazy bias or cost model makes the floor diverge
from the outer accept test.

2. **Decode throughput, continued.** Scalar-JS-bound; loads are the cost.
   Checksum tax **1.12–1.24×** by shape. **2026-08-03 profile** (extra corpus, CLI lvl3 +
   own-L3 frames, 4 s, minified self-time): **`rzb` ~46%**, **`dhu` ~20%**,
   **XXH64 `stripes` ~8%**. So `dhu` is larger than the earlier ~8% estimate
   on this mix — Huffman-heavy own-L3 frames pull it up. Packed Huffman
   (~0.99×), packed FSE sequence tables (~0.44×), and an r32-word cache
   (~0.63×) are all rejected; see "Decoder — rejected and
   declined".

   **2026-08-03, second pass — two changes adopted, one lever closed.** The
   redundant `dhu` state carry (+1.0–2.4%) and two-fields-per-load in the
   sequence loop (+0.7–0.9% on CLI frames, neutral on ours) both shipped;
   `dhu` pairing was rejected at 0.98× of plain `dhu`. Together that closes the
   **bit accumulator** lever in every form anyone has proposed for it — see
   that entry. What is left:

   - **"Take more out of a load you already made"** — the only load-side idea
     still winning. The two adopted pairs are the ones a 25-bit floor admits;
     anything wider needs a guard, and guards lose.
   - Load-removing reshapes that are not "pack then unpack" (those lose) and
     do not add a loop or a branch (those lose too).
   - ~~The declined unchecked-index 1.03–1.08×~~ — **taken 2026-08-03**, and
     the type-guarantee tradeoff it was declined for did not exist. See
     "Unguarded reads of derived structures".

   Product position: extra-corpus **vs-fz 1.06× while verifying**, **nv/fz 1.18×**
   both skipping. Faster-while-doing-more-work is the default claim; the
   like-for-like number is labelled and secondary.

   **(a) Symbol-range validation in `rfse` — done 2026-08-03.** Adopted; see
   "Bound the symbol, not the table". Worth **+1.0% on lvl3 and neutral on the
   other two shapes**, not the ~1% across the board projected here — and it
   closed two frames that returned wrong bytes as success. The projection's
   magnitude survived; its breadth did not.

   **(b) Checksum opt-out — done 2026-08-03.** Adopted; see "Checksum opt-out
   returned, default-safe". Default verifies; only `{ checksum: false }` skips.
   Product numbers: **vs-fz 1.06×**, **nv/fz 1.18×**, verification cost **1.118×**
   on lvl3. `bench:decode` table 3 prints cost for all five shapes, own-L1
   included, and all five are result-grade off the three-run measurement in
   "Decode product claims".

3. **Offset-code frequency pricing — closed, refuted.** See "What the offset
   surcharge actually is". Do not reopen without a monotone floor in distance.
4. **Throughput distribution chart.** Parked. `pnpm bench:decode` still emits
   per-payload JSON with `WZSTD_BENCH_JSON=1`.
5. **Encoder-side checksum — decided and done.**
6. **Synthetic tiny payloads in bench medians — open.** Keep them for
   correctness extremes; deciding whether they vote in MEDIAN MB/s is a
   separate policy (see "once-per-run calibration" revisit).

Product surface is **Fast, Strong, and Ultra** as separate exports — no
combined `compress(level)`, no L1/L3 aliases, no L2/L4 numeric ladder.

---

## Encoder — Compress Ultra — **Adopted** (2026-08-06; policy revised same day)

`src/compress/ultra.ts` + strategy-local fields on `MatcherConfig` in `shared.ts`

Separate package entry `compressUltra` (barrel + `./compressUltra` subpath).
Public names are **`compressFast` / `compressStrong` / `compressUltra` only**
(renamed from L1/L3; no dual aliases). Internal fixed `ULTRA_CONFIG` is not a
public level API — same pattern as `STRONG_CONFIG` for experiment scripts only.

**Shipped Ultra policy (lean greedy — multi-arm dropped):**

1. Same primary search as Strong (`nullPatience` 24, `lazyDepth` 0, Huffman, surcharge)
2. **Secondary 8-byte long-hash** (`longHashBits: 17`, `longChainLimit: 4`)
3. **8 MiB window** (Strong stays 1 MiB)

**Tried then rejected for product Ultra / Strong (same session):**

| idea                                         | result                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Multi-arm (floor + BT + optimal DP)          | ~2–3 pts for multi‑× encode — not worth                                                  |
| Binary tree alone                            | real ratio (~0.775× old Strong) but ~6–10× slower even with skip-ahead                   |
| Optimal parse                                | few pts on top of long-hash; wrong cost curve in JS                                      |
| Long-hash lim32                              | diminishing returns vs lim4                                                              |
| Long-hash on Strong (lim2/lim4 / size gates) | lim4 fixes rep-friendly; **~33% slower** for **~0.5 pts** synthetic total — **reverted** |
| Primary-8 instead of secondary long-hash     | only ~4.5% size; drops length 4–7 matches                                                |

**Measured (lean Ultra vs Strong on expanded synthetic, 2026-08-06):** totals
Ultra ~0.148–0.149 vs Strong ~0.154 (byte-weighted); equal-weight group mean
Ultra ~0.257 vs Strong ~0.263. zlib level 19 still ahead on structured text.
Quote Ultra per-profile (prose/farecho/mixed mid-size), not total-saved alone.

**Synthetic corpus:** generators in `tests/helpers/corpus.ts` — ~**78** payloads /
~**141 MB** after widen (ndjson, csv, prose, far-echo, larger GIS/JSONL;
`randomBytes` fixed to xorshift32). `extra-bench-data/` opt-in only (empty on
fresh clone).

**Rejected (still):** dictionaries; full length-enumeration in DP (zeros explode).
`probeReps` is on all three tiers — the Ultra-dissection "alone" rejection does
not apply to Fast/Strong (see the 2026-08-12 climb).
---

## Encoder — Ultra lever dissection — 2026-08-06

Expanded synthetic corpus (~78.9 MB, size + probe counters via
`scripts/ultra_lever_sweep.ts`; directional same-process wall-clock for speed
shape only — not isolated).

### Is the binary tree implemented correctly?

Structurally **yes enough to work**: content-ordered BST re-root on insert,
smaller/larger child split by the first differing byte, find walks the same
order, long-hash still runs after BT. Compared to zstd `ZSTD_insertBt1` /
`ZSTD_BtFindBestMatch`:

- Equal-to-end / budget exhaustion nullifies dangling slots (same conservative
  choice zstd makes to keep the tree consistent).
- **Underpowered, not “wrong”:** `btLimit = chainLimit` (24) vs zstd L19
  `1 << searchLog` (128); no skip-ahead on long matches (zstd advances
  `nextToUpdate` past repetitive regions); insert is every position, not
  batch-forward.
- **Probe counters lie about BT cost:** search probes ≈ L3 (1.06×) but insert
  does a full string-compare walk per position. Directional wall-clock: BT-only
  **~10× slower** than L3 for **0.775×** size. Ratio is real; cheapness is not.

Shipped Ultra no longer uses BT (greedy + long-hash only). BT remains an
experiment flag.

### Primary 8-byte hash instead of secondary long-hash?

**No.** Primary-8 alone: **0.955×** L3 size at ~0.9× speed — only ~4.5% smaller,
because matches of length 4–7 that do not share an 8-byte prefix disappear.
Secondary long-hash (4-byte primary + 8-byte table): **0.744×**. Primary-8 +
secondary long-hash ≈ long-hash alone. The dual-table design is the point:
short matches stay findable; long matches get a separate index.

### 8 MiB window

| config                 | vs L3 size | notes                                  |
| ---------------------- | ---------- | -------------------------------------- |
| win8 alone             | **1.000×** | chain never reaches far under patience |
| long-hash full @ 1 MiB | 0.744×     |                                        |
| long-hash full + win8  | 0.742×     | +0.2% more on this corpus              |

Window is **required for matches past 1 MiB to be legal**, but on the expanded
synthetic set almost all long-hash wins sit inside 1 MiB. Keep 8 MiB for Ultra
/ large structured inputs; do not pay it on Strong. Throughput cost of win8
with long-hash is small (~5% in the directional run) once long-hash is already
on.

### Deep search / lazy

| lever                   | vs L3 size     | probes       | note                                           |
| ----------------------- | -------------- | ------------ | ---------------------------------------------- |
| chainLimit 48 / 64      | **1.000×**     | 1.00×        | byte-identical; chainLimit already non-binding |
| nullPatience 24 (or 48) | **0.889×**     | 1.53×        | saturates at 24; **~11% free-ish residual**    |
| lazyDepth 0             | 0.979×         | 0.94×        | slightly smaller than shipped lazy 3           |
| lazyDepth 5 / 8         | 1.003 / 1.029× | 1.03 / 1.08× | regresses                                      |

Deeper chain does nothing. **nullPatience 12 → 24 is the main residual on the
primary finder** (~11% size for ~1.14× directional encode time). Deeper lazy is
not a win on this corpus.

### Long-hash budget knee (product path)

| config         | vs L3 size | probes | dir. speed vs L3                       |
| -------------- | ---------- | ------ | -------------------------------------- |
| lh bits17 lim4 | **0.833×** | 1.40×  | ~0.56× (~1.8× slower)                  |
| lh bits17 lim8 | 0.808×     | 1.72×  | ~0.48×                                 |
| lh bits15 lim8 | 0.811×     | 1.91×  | ~0.48×                                 |
| lh full lim32  | 0.744×     | 2.63×  | ~0.31×                                 |
| adaptive full  | 0.832×     | 2.28×  | worse ratio / probe trade than lim4    |
| BT only        | 0.775×     | 1.06×* | **~0.10×** (*probes undercount insert) |

**Best fit for “~15% smaller at ~1.6× encode”:** long-hash with **lim4**
(~17% smaller, ~1.8× slower directional) or lim8 (~19%, ~2.1×). Adaptive
long-hash did not pay. Combining nullPatience 24 with a cheap long-hash is the
next measurement if Strong should absorb some of the win.

Experiment knobs left on `MatcherConfig` for scripts: `primaryHashBytes`,
`longHashOnlyIfShort` (default 4 / false on shipped paths).

### Follow-up A/B (alone, not stacked) + BT skip-ahead — **shipped 2026-08-06**

Directional same-process on expanded synthetic (~78.9 MB); sizes deterministic.

| config                    | vs old L3 size    | dir. slowdown         |
| ------------------------- | ----------------- | --------------------- |
| **nullPatience 24 alone** | **0.889× (−11%)** | 1.14×                 |
| **lazyDepth 0 alone**     | **0.979× (−2%)**  | **0.91× (faster)**    |
| **nullPat24 + lazy0**     | **0.868× (−13%)** | **1.02× (parity)**    |
| lh lim4 on old L3         | 0.833×            | 1.63×                 |
| lh lim8 on old L3         | 0.808×            | 2.07×                 |
| nullPat24+lazy0+lh lim4   | 0.827×            | 1.47×                 |
| nullPat24+lazy0+lh lim8   | 0.819×            | 1.61×                 |
| BT lim24 + skip-ahead     | 0.775×            | **6.07×** (was ~10×)  |
| BT lim32 / 64 + skip      | 0.775×            | 7–10× (no extra size) |
| prim8 only                | 0.955×            | 1.11×                 |
| prim8 + nullPat24 lazy0   | 0.862×            | 1.10×                 |

**Shipped Strong:** `nullPatience: 24`, `lazyDepth: 0` — the 11% is real alone;
stacking lazy0 adds ~2 more points and recovers the encode time to parity.

**Shipped Ultra:** Strong base + `longHashBits: 17`, `longChainLimit: 4`, 8 MiB
window. Incremental Ultra vs _new_ Strong is only ~5% (nullPatience already
absorbs part of the old long-hash gap); still the right Ultra lever, lim4 not
lim32. lim8 is +1 pt size for more slowdown — not shipped.

**BT skip-ahead adopted in code** (zstd-style forward on long matches) but BT
stays off for product: 6× is still wrong side of the curve; deeper searchLog
does not move size past lim24.

**prim8 + Huffman rewrite rejected:** dual tables are not "two kills" if Ultra
only pays long-hash; prim8 alone never exceeds ~4.5% and does not replace
secondary long-hash. Huffman prices literals, not needle length.

### Strong long-hash lim4 (rep-friendly gap) — **tried, reverted 2026-08-06**

`rep-friendly-*` compresses near-zero on Fast/Ultra; Strong without long-hash
sits ~0.05 ratio (~20× larger) while round-tripping. Cause is match discovery
(primary chain), not surcharge/lit pricing alone — see the patience entry
below for the real root cause (found after this A/B).

| policy          | pts raw vs no-lh | probes          | same-proc slowdown | rep-friendly-30k          |
| --------------- | ---------------- | --------------- | ------------------ | ------------------------- |
| lim2 always     | 0.34             | 1.095×          | ~22%               | **1229** (not fixed)      |
| lim4 always     | 0.52             | 1.173×          | ~33%               | **73** (fixed)            |
| lim2/4 ≥256 KiB | ~0.3–0.5         | ~same as always | ~20–29%            | 30k still broken if gated |

Size gates barely help because most synthetic mass is already multi‑100 KiB.
**Not worth ~⅓ encode tax for half a point of total** as a Strong product lever.
Reverted Strong to `longHashBits: 0`. Long-hash stays Ultra-only (with 8 MiB
window). Long-hash still _masks_ the patience bug on this shape; it is not the
cheapest fix.

### Strong `patience: 1` vs rep-friendly — **root cause + shipped fix, 2026-08-06**

Not a broken bench. `repFriendly` is short phrase cycles
(`ALPHA_BLOCK_` / `BETA_SEGMENT_` / `GAMMA_CHUNK_`, ~12–13 B) — the same
"schema-ish reuse" structure as NDJSON/CSV/HTML token streams, only denser.

**Mechanism in `bestMatchAt`:** after an improvement sets `sinceImprove = 0`,
the _same_ loop iteration does `++sinceImprove` and compares to the post-hit
budget. With `patience: 1` that is:

1. first positive-score chain hit → `sinceImprove = 0`
2. same iteration → `sinceImprove` becomes 1 → `1 >= 1` → **exit**

So Strong was **first positive chain hit wins** — zero further candidates. The
ledger that shipped patience 1 claimed "abandon after **one non-improving**
probe"; the code never grants that probe. Fast's derived `patience = chainLimit
= 4` walks the rest of its shallow chain; Ultra's secondary 8-byte long-hash
found the real needles after the primary stopped early.

**A/B on rep-friendly-30k (compressed bytes, round-trips all):**

| config                                         |             size |
| ---------------------------------------------- | ---------------: |
| Fast                                           |               73 |
| Strong `patience: 1`                           |         **1502** |
| Strong surcharge 0 / no Huffman / no preferRep | 1502 (unchanged) |
| Strong window **2 MiB**                        | 1502 (unchanged) |
| Strong `nullPatience` 4…12 (keep pat 1)        |             1502 |
| Strong `chainLimit` 4 with pat 1               |             1502 |
| Strong **`patience: 2` only**                  |           **73** |
| Strong long-hash lim4                          |               73 |
| Ultra                                          |               73 |

**Full synthetic re-measure before shipping (78 payloads, ~141 MB):**

|                          |       pat1 |                                pat2 |
| ------------------------ | ---------: | ----------------------------------: |
| byte-weighted compressed | 21,742,206 |             **21,358,746 (−1.76%)** |
| equal-weight mean ratio  |     0.3362 |                          **0.3294** |
| payloads worse           |          — |                               **0** |
| payloads better          |          — |                   44 (34 identical) |
| chain probes             |   baseline |                          **+0.75%** |
| searches                 |   baseline | **−0.80%** (longer matches advance) |

Biggest wins beyond rep-friendly: `mixed-*` (−15…−28%), `geojsonl-*` (−15…−18%),
`json-lines-*` (−19…−22%). **No payload regressed.**

**Does this undo the nullPatience / lazy free lunch?** No — orthogonal budgets:

| check (full synthetic)               | result                                                           |
| ------------------------------------ | ---------------------------------------------------------------- |
| nullPatience 24 vs 12 **under pat2** | null12 is **+3.57%** larger — null24 still pays                  |
| nullPatience 24 vs 12 **under pat1** | null24 wins **5.42%** on this corpus                             |
| lazyDepth 0 vs 3 under pat2          | lazy3 is −0.77% size (lazy 0 stays for throughput; not reopened) |

The historical ~11% nullPatience 12→24 and lazyDepth 0 wins remain product;
patience 2 only undoes the first-hit-final micro-cut that was sold as +0.015%
size / −5% probes on the _extra_ corpus.

**Shipped:** Strong + Ultra primary `patience: 2`. Long-hash stays Ultra-only.
2 MiB Strong window not taken (no help on this class). Optional later: count
only non-improving probes so `patience: 1` matches the prose.

### Strong window 2 MiB — **not a rep-friendly lever**

Random idea, measured: `windowSize: 2 MiB` with shipped Strong leaves
rep-friendly-30k/1m **unchanged** (1502 / 49707). The gap is post-hit search
depth, not history length — phrases live tens of bytes apart. 2 MiB would only
matter for legal matches past 1 MiB (farecho / longrange / multi-MB NDJSON
structure); that is Ultra's job today (8 MiB + long-hash). Raising Strong's
window without better far-match discovery is mostly free memory and a larger
declared window on multi-MiB frames, not a ratio win on this corpus.

### Workloads where long matches fire (100 KB–few MB)

Product map for **Ultra long-hash + window** and for synthetic profiles in
`tests/helpers/corpus.ts` (`benchPayloads`). Separate from short-period
phrase reuse (`rep-friendly-*`), which is primary-chain / post-hit patience.

| Workload              | Synthetic stand-in                                         | Description / purpose                                                                                        |
| --------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| JSONL / NDJSON logs   | `ndjsonSchema` → `ndjson-*`                                | Same keys/schema every line; values vary. Mid-range structure for Strong Huffman + Ultra long-hash.          |
| GeoJSON / GIS         | `geojsonlLike` → `geojsonl-*`                              | Repeated property bags and ring structure. Large multi-MB mass; patience-2 also helped Strong here.          |
| HTML / XML            | `htmlLike` → `html-*`                                      | Tags, attributes, boilerplate reused across the document.                                                    |
| Source code / bundles | `sourceLike` → `source-*`                                  | Imports, API names, formatting patterns.                                                                     |
| CSV / TSV exports     | `csvExport` → `csv-*`                                      | Header-like tokens in every row; Strong Huffman ≫ Fast raw on column tokens.                                 |
| API response dumps    | `jsonLines` → `json-lines-*`                               | Shared envelope + field names (same family as NDJSON).                                                       |
| Prose / docs          | `proseLike` → `prose-*`                                    | Vocabulary reuse without a pure low-entropy alphabet — separates Ultra without drowning in random/LE mass.   |
| Far structural echo   | `farEcho` / `longRangeSparse` → `farecho-*`, `longrange-*` | Motif repeated past 1 MiB; needs Ultra’s 8 MiB window + long-hash (Strong cannot legally match past 1 MiB).  |
| Dense short phrases   | `repFriendly` → `rep-friendly-*`                           | Short cycling phrases (~12–13 B). Stresses post-hit chain depth; fixed by Strong `patience: 2` (not window). |

### Fast L1 `chainLimit` 4 — **shipped 2026-08-06**

User call: ~**0.79×** single-slot size at ~**1.04×** encode on expanded
synthetic is an excellent Fast trade; L1 long-hash (−13% @ 1.16×) is not.

Shipped `L1_CHAIN_LIMIT = 4` with **derived** `patience`/`nullPatience` (= 4).
nullPatience 24 remains a no-op at this depth without rewriting L1's cost model.
Long-hash stays Ultra-only.

Note: Fast can beat Strong on _some_ individual shapes (raw 8-bit match pricing
vs order-0 entropy pricing). Strong still wins expanded synthetic **totals**
(~1.48× smaller compressed than Fast). Tests pin totals / round-trip, not
per-payload L3 < L1.

### Synthetic corpus: tier gaps vs speed steps — 2026-08-06

Isolated encode (pre-widen) showed clear **~33% speed steps** (L1 55 / L3 42 /
U 28 MB/s) but **tiny saved-% steps** on totals (84.2 / 89.3 / 89.8). Cause is
not "tiers are fake" — it is **byte-weighted totals**:

- Ultra wins concentrate on mid-size structured files (mixed-40k ΔL3−U ~8 pts of
  raw; prose ~2.5 pts). Large low-entropy / skewed / pure random show **Δ≈0**.
- Strong vs Fast is huge on Huffman shapes (low-entropy ~32 pts) and modest on
  JSON/CSV (~6–10 pts); Fast can win individual files.
- Histogram (pre-widen, n≥256): **43/62** payloads had Ultra gap in 0–1%; only
  10 in 3–8%. Totals therefore look like "same ratio, different speed."

**Corpus fixes / widen (`tests/helpers/corpus.ts`):**

1. **`randomBytes` was a lie** — `f(i) = imul(i+seed,…) & 0xff` has flat
   histogram (H≈8) but is match-compressible (2 MiB → 471 B). Replaced with
   xorshift32 state. `random-*` and far-echo benches are honest now (~1.0 ratio).
2. **New profiles:** `ndjsonSchema`, `csvExport`, `farEcho` (motif every 1.5 MiB),
   `proseLike`, larger `geojsonl` / `json-lines`. Corpus ~**78 → 141 MB**.
3. After widen+fix: totals still only **~0.6 pts Ultra over Strong** (Ultra is
   not free on most mass). Per-profile Ultra is real on farecho (~2.3 pts) and
   prose (~2.5 pts). Strong–Fast gap remains the clearer ratio story.

Product read: quote **per-profile** or median-of-ratios for Ultra claims; do not
read Ultra off the total-saved cell alone. Speed steps can stay; ratio steps need
either better Ultra or a corpus/report that does not drown them in random/LE mass.

---

### Fast/Strong Silesia hill climb — **shipped 2026-08-07**

Goal from `HANDOFF.md`: move Fast and Strong toward fflate gzip on the Silesia
subset without hiding regressions in the synthetic half. Ultra stayed frozen.
Sizes and probes below are deterministic `pnpm bench:ab --stats` results.

**Strong — shallower total walk, slightly longer post-hit walk:**

| config                     | synthetic size | synthetic probes | Silesia size | Silesia probes |
| -------------------------- | -------------: | ---------------: | -----------: | -------------: |
| old: chain 24 / patience 2 |       baseline |         baseline |     baseline |       baseline |
| chain 20 / patience 2      |         +0.26% |           −12.4% |       +0.09% |         −14.3% |
| **chain 20 / patience 4**  |     **−0.50%** |       **−11.2%** |   **−0.25%** |     **−14.2%** |

The interaction is the result: the depth cut removes fruitless tail work while
two more post-hit probes recover more ratio than the cut costs. Chain 16 looked
excellent on Silesia (−29.5% probes for +0.21% size) but broke `mixed-*` by up
to 229%; it was rejected. Ultra keeps chain 24 / patience 2 because this climb
explicitly excluded it and its long-hash was tuned with that primary search.

**Fast — wider primary hash + repeat preference:**

| config                                    | synthetic size | synthetic probes | Silesia size | Silesia probes |
| ----------------------------------------- | -------------: | ---------------: | -----------: | -------------: |
| old: hash 15 / row 32 / no rep preference |       baseline |         baseline |     baseline |       baseline |
| prefer reps only                          |         −0.63% |            −0.1% |       −0.03% |           0.0% |
| hash 16 + prefer reps                     |         −1.18% |            −6.0% |       −1.38% |         −12.1% |
| **hash 17 / row 4 + prefer reps**         |     **−1.41%** |       **−14.3%** |   **−2.27%** |     **−27.2%** |

At hash 17 every changed payload got smaller: 54/0/24 better/worse/equal on
synthetic and 4/0/0 on Silesia. `rowBits: 2` is output- and probe-identical to
larger rows because Fast's chain depth is exactly four; it restores contiguous
layout at 512 KiB while using a 2 MiB row instead of the old 4 MiB row.

Hashes 18/19 continued reducing probes, but the ratio gain past 17 was tiny,
the head table grew, five synthetic payloads regressed by up to 0.14%, and the
isolated speed trade split by corpus: 18 → 49.3 / 28.3 MB/s and 19 → 47.9 /
30.7 (synthetic / Silesia), versus 17 → 50.1 / 27.1. The 17-bit point is the
durable knee: bulk of the ratio win, no payload regressions, compact rows.

**Isolated shipped-candidate speeds** (`bench:encode --wzstd-only`, peers not
rerun): Fast 50.1 MB/s synthetic / 27.1 Silesia; Strong 38.2 / 12.9. Captured
pre-change synthetic controls were Fast 51.7 and Strong 38.5, close enough that
the small deltas are not product speed claims. Fixed controls from the same
baseline run: fflate 68.1, host gzip 188 MB/s; reuse them.

Harness work adopted during the climb: `bench:ab --base fast`, fixed documented
comma-combined overrides, and `bench:encode --wzstd-only --encoder <tier>` so
unchanged gzip/zstd controls are not repeatedly timed.

---

### Fast/Strong remaining hills — **shipped 2026-08-12**

Ultra search stays at chain 24 / patience 2 + long-hash; `probeReps` turns on
so Ultra stays ≤ Strong on mixed. Decoder source is unchanged.

**Explicit rep probes** (`probeReps`). The 4-byte chain only surfaces a rep when
the hash collides with it. Three extra u32 compares before the walk:

| tier   |       synthetic size | synthetic probes |       Silesia size | Silesia probes |
| ------ | -------------------: | ---------------: | -----------------: | -------------: |
| Fast   | **−2.91%** (49/0/29) |            +1.0% | **−0.23%** (4/0/0) |           0.0% |
| Strong | **−2.04%** (44/0/34) |            −2.1% | **−0.13%** (3/1/0) |          −0.2% |

Biggest Fast/Strong wins are geojsonl (−22 to −32%) and csv. The Ultra-era
"probeReps alone" rejection does not apply here: Fast/Strong have no long-hash
to cover those finds.

**Strong hash 15 → 17**, stacked with probeReps. At 15 bits `chainLimit` was
55.9% / 76.4% of walk exits (synthetic / Silesia) — the table was collision-
bound. Combined:

| config                  |       synthetic size | synthetic probes |       Silesia size | Silesia probes |
| ----------------------- | -------------------: | ---------------: | -----------------: | -------------: |
| hash 17 only            |               −0.15% |           −40.8% |             −0.14% |         −25.9% |
| **hash 17 + probeReps** | **−1.24%** (45/0/33) |       **−42.5%** | **−0.27%** (3/1/0) |     **−26.1%** |

probeReps alone is the bigger synthetic size win; combined is strictly better on
Silesia, has zero synthetic regressions vs shipped, and keeps the probe cut.
That is the product pick.

**Do not shrink the Strong row or chain to keep the contiguous ring at hash 17.**
`hashSize × row` at 17/5 is 4 MiB and `slots` max is 1 MiB, so rows never
activate — the A/B already measured the linked-chain form. Forcing rows via
`rowBits: 3` or `chainLimit` 16/12 blows up `mixed-*` by **+120–186%**, the same
class as the rejected chain-16 cut.

**Fast `searchSkipShift` 8.** After a miss, advance `((pos − anchor) >> 8) + 1`
and still index the skipped positions. Synthetic probes **−55%** for **+0.008%**
size (0/7/71). Silesia is a no-op (matches keep the step at 1). Shifts 6 and 7
cut the same work with more tiny regressions. Isolated Fast synthetic 46.0 →
49.1 MB/s; Silesia held at 25.8.

**Not taken**

- Fast hash 16: +0.2 / +0.9% size, +10 / +21% probes.
- Fast chain 5/6 without a wider row: no-op (row already caps at 4).
- Strong long-hash / BT / optimal parse / window > 1 MiB: still the expensive
  Silesia-ratio levers. Residual vs fflate on Silesia is 0.485 vs 0.423.

Decoder unchanged. Main-set `bench:decode` after the new frames: **vs-fz
1.31× synthetic / 1.13× Silesia** (we verify; fzstd never hashes). `nv/fz`
1.73× / 1.21×. Not comparable to the extra-corpus 1.06× claim (different
files). No new decoder source change — the remaining load-side ideas are the
ones already rejected.

Isolated encode (`--no-ultra`, same session as fflate; machine ~0.7× the
2026-08-07 absolute MB/s — quote ratios):

| encoder      | synthetic ratio | synthetic MB/s | Silesia ratio | Silesia MB/s |
| ------------ | --------------: | -------------: | ------------: | -----------: |
| wzstd Fast   |          0.1885 |           49.1 |        0.5080 |         25.8 |
| wzstd Strong |          0.1486 |           36.8 |        0.4853 |         14.2 |
| fflate gzip  |          0.2044 |           69.8 |        0.4227 |         39.6 |

---

## Current product snapshot — **2026-08-14** (authoritative)

Keep this section in step with `README.md` / `AGENTS.md` / package exports.
Historical rows above may still say L1/L3 — that was the old public name.

| Export                                           | File                                 | Matcher / notes                                                                   |
| ------------------------------------------------ | ------------------------------------ | --------------------------------------------------------------------------------- |
| `compressFast`                                   | `src/compress/fast.ts`               | one-shot; FCS + checksum; chain 4, hash 17 / row 4, skip-shift 8, raw lits, 1 MiB |
| `CompressFast` / `compressFastStream`            | `src/compress/fast.ts`               | stream; no FCS, 1 MiB window, checksum; wraps `EncodeStream`                      |
| `compressStrong`                                 | `src/compress/strong.ts`             | one-shot; FCS + checksum; chain 20, patience 4, Huffman + FSE, 1 MiB              |
| `CompressStrong` / `compressStrongStream`        | `src/compress/strong.ts`             | stream; same framing as streaming Fast                                            |
| `compressUltra`                                  | `src/compress/ultra.ts`              | one-shot only; chain 24 / patience 2 + long-hash lim4 + 8 MiB                     |
| `decompress` / `Decompress` / `decompressStream` | `src/decompress.ts`, `src/stream.ts` | checksum verify **default on**; `{ checksum: false }` only opt-out                |

**Known residual gaps (not blockers):**

- Fast can still beat Strong on some shapes (raw 8-bit match pricing vs entropy).
- Byte-weighted synthetic totals flatten Ultra; equal-weight group means and
  per-profile tables tell the truth.
- Workload ↔ synthetic map: "Workloads where long matches fire" table above.

**Standing constraints.** Strong `patience` 4 keeps `rep-friendly-*` from
first-hit-final. Fast hash 17 is the knee (18/19 regress small synthetic).
Strong hash 17 keeps `chainLimit` 20 / `rowBits` 5 — shrinking either blows up
`mixed-*`. Decoder source is the verifying path already in the ledger; copy-loop
and extra-bit-skip reshapes lose on cached Silesia frames.

**Harness.** Encode benches isolate per subject; `bench:summary` encodes first,
then decodes. Matcher size A/B: `pnpm bench:ab`. Decode A/B against cached
frames: `pnpm bench:ab-decode`. Probe work: `--stats` or `pnpm bench:match-stats`.
