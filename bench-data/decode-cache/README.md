# Cached decode A/B frames

Used by `pnpm bench:ab-decode`. Frames are built once (own Fast/Strong,
CLI `--fast=8`, CLI level 3) and reused so decoder A/Bs do not re-encode.
Payloads in this directory are gitignored. `--rebuild-cache` recodes them.
