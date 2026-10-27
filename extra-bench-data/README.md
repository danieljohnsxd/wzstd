# Extra bench corpus (opt-in)

Put any files here (or set `WZSTD_CORPUS_DIR` to another directory) and pass
`--extra` / `--extra-only` to benches and `pnpm test --extra`.

Payloads are **gitignored**. An empty directory is normal on a fresh clone.
The harness errors if you ask for `--extra` when nothing is present, so flags
never silently fall back to fixtures.

Default product benches use the **main set** (in-repo synthetic + pinned
Silesia subset under `bench-data/silesia/`). This directory is only for
_your_ optional data via `--extra`.

```bash
pnpm bench:encode --extra
pnpm bench:summary --extra-only
pnpm test --extra
```
