import { defineConfig } from "tsdown";

/**
 * Library build (Rolldown/tsdown — the lib piece of the Vite+ stack).
 * ESM-only ES2022 emit for multi-runtime consumers (Node, Workers, Convex, …).
 */
export default defineConfig({
  // Separate entries give physical isolation:
  // - compressFast must not contain Huffman
  // - compressStrong is the quality path
  // - compressUltra is the ultra-band path (may share Strong packing chunks)
  // - decompress stays independent; decompressStream is the TransformStream adapter
  // - index is the decode-only root (`import { decompress } from "wzstd"`)
  entry: {
    index: "src/index.ts",
    compressFast: "src/compress/fast.ts",
    compressStrong: "src/compress/strong.ts",
    compressUltra: "src/compress/ultra.ts",
    decompress: "src/decompress.ts",
    decompressStream: "src/stream.ts",
  },
  format: ["esm"],
  platform: "neutral",
  target: "es2022",
  outDir: "dist",
  clean: true,
  dts: true,
  // No sourcemaps: `files` ships only dist/, so maps would point at src/
  // files consumers never receive.
  sourcemap: false,
  minify: true,
  treeshake: true,
  // Per-entry pure library — no runtime deps to externalize.
  unbundle: false,
});
