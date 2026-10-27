---
name: zstd
description: Compress or decompress Zstandard (zstd) in pure TypeScript with wzstd — on Workers, edge runtimes, browsers, Deno, Bun or Node. Load when code reads or writes .zst data, zstd Content-Encoding, or decodes zstd from an untrusted source.
---

# zstd with wzstd

## When to use / when not to

- Use for **on-the-fly** zstd where no native zstd exists: Cloudflare Workers, edge functions, browsers handling `.zst` bytes in code, Deno/Bun without a binding.
- On **Node 22.15+ / 23.8+**, prefer `node:zlib` (`zstdCompressSync`, `zstdDecompressSync`, `createZstdDecompress`) — native and faster; still marked experimental in Node docs.
- **Build-time static assets**: do not use a JS encoder. Precompress with the native `zstd` or `brotli` CLI at a high level and serve the files.
- **Browser fetch of `Content-Encoding: zstd`**: the browser decodes it already (Chrome 123+, Firefox 126+, Safari 26.3+ on OS 26.3). Do not decode `response.body` again. `DecompressionStream` does not support zstd anywhere.
- **Serving HTTP**: only send zstd when `Accept-Encoding` lists it; otherwise gzip (sibling package `wgzip`, or built-in `CompressionStream`) or brotli. Image uploads (resize / re-encode) are the sibling `wimgs`, not this.

## Happy path

```ts
import { decompress, decompressStream } from "wzstd";
import { compressFast } from "wzstd/compressFast"; // or compressStrong for better ratio

const frame = compressFast(bytes);
const plain = decompress(untrusted); // checksum verified, output capped at 64 MiB
const body = res.body!.pipeThrough(decompressStream({ maxSize: 16 * 1024 * 1024 }));
```

Tiers: **`compressFast`** for latency (API responses, logs), **`compressStrong`** when ratio matters more (uploads, storage). Streaming: `compressFastStream()` / `compressStrongStream()` or the `CompressFast` / `CompressStrong` push classes.

## Rules

- Never pick `compressUltra`. It is an experiment kept for research: slower than Strong for ~0.6 points of ratio, and one-shot only.
- There is no `compress(level)` and no level numbers. Do not invent one; import the tier from its subpath.
- Keep the default `maxSize` (64 MiB) or set a smaller one for untrusted input. Use `maxSize: Infinity` only for data you produced. It must be `Infinity` or a non-negative safe integer.
- Never pass `checksum: false` for untrusted data; it disables the only reliable corruption check.
- `out` (pre-sized buffer) accepts a single data frame only; omit it for concatenated frames.
- Encoders emit 1 MiB windows (Fast/Strong), within RFC 9659's 8 MiB limit for HTTP zstd.
- Dictionaries are not supported, either direction. Frames declaring windows above 128 MiB are rejected (same default as libzstd).
- Import the decoder from `wzstd` (decode-only root); importing it never loads an encoder.

## Errors

Every decode failure is a `ZstdError` with `code` from `ZstdErrorCode`:

- `OutputTooLarge` — output would exceed `maxSize` (or the declared content size does). Reject the input, or raise the cap if the source is trusted.
- `ChecksumMismatch`, `InvalidData`, `InvalidBlockType`, `FSEAccuracyTooHigh`, `DistanceTooFarBack` — corrupt or hostile input. Reject; do not retry.
- `UnexpectedEOF` — truncated input (streams raise it at the final push / flush).
- `WindowSizeTooLarge` — window above 128 MiB (e.g. `zstd --long=28`). Re-encode with a smaller window.

Invalid options (`maxSize: -1`, `NaN`, a string) throw `TypeError` at call time. Catch with `e instanceof ZstdError` and branch on `e.code`.

## More

`references/context.md`: why these defaults, platform facts, what was measured and rejected.
