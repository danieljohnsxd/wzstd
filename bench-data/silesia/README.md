# Pinned Silesia subset (main bench set)

Part of the default encode/decode/summary corpus next to in-repo
synthetic. **Downloaded on demand** into this directory; payloads are
gitignored. Do not hand-edit files — size and SHA-256 are pinned in
`scripts/helpers/silesia.ts`.

## Files

- dickens (~10.2 MB) — English literary prose
- xml (~5.3 MB) — structured markup
- osdb (~10.1 MB) — database-style dump
- x-ray (~8.5 MB) — medical/image binary

Total ~34 MB (not full Silesia).

## Provenance

Silesia compression corpus, Sebastian Deorowicz (Silesian University of Technology).
https://sun.aei.polsl.pl/~sdeor/index.php?page=silesia

Fetched as `.bz2` from that site; we keep the decompressed bytes after
hash verification. Cite the Silesia corpus when publishing figures that
include these rows.
