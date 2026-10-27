/**
 * Node-friendly init for @paddor/zrip (pure Rust zstd → WASM).
 *
 * The package's async `init()` uses `fetch(file://...)`, which Node undici
 * does not implement. Load the SIMD/scalar binary from disk instead.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initSyncFromBytes } from "@paddor/zrip";

// Minimal WASM that uses v128 — same probe as @paddor/zrip.
const SIMD_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b, 0x03,
  0x02, 0x01, 0x00, 0x0a, 0x0a, 0x01, 0x08, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0xfd, 0x62, 0x0b,
]);

let ready: Promise<void> | undefined;

function loadZripWasm(): void {
  const modUrl = import.meta.resolve("@paddor/zrip");
  const pkgDir = dirname(fileURLToPath(modUrl));
  const simd = WebAssembly.validate(SIMD_PROBE);
  const name = simd ? "zrip_simd.wasm" : "zrip_scalar.wasm";
  const bytes = readFileSync(join(pkgDir, "pkg", name));
  initSyncFromBytes(bytes);
}

export function ensureZrip(): Promise<void> {
  ready ??= Promise.resolve().then(loadZripWasm);
  return ready;
}
