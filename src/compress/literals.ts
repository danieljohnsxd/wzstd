/**
 * Raw / RLE literal section encoding (no Huffman).
 * Used by Fast always; Strong/Ultra fall back here when Huffman is not beneficial.
 */

function writeRawLiterals(literals: Uint8Array): Uint8Array {
  const size = literals.length;
  if (size <= 31) {
    const out = new Uint8Array(1 + size);
    out[0] = (size << 3) | 0;
    out.set(literals, 1);
    return out;
  }
  if (size <= 0x0fff) {
    const out = new Uint8Array(2 + size);
    out[0] = ((size & 0x0f) << 4) | (1 << 2);
    out[1] = (size >>> 4) & 0xff;
    out.set(literals, 2);
    return out;
  }
  const out = new Uint8Array(3 + size);
  out[0] = ((size & 0x0f) << 4) | (3 << 2);
  out[1] = (size >>> 4) & 0xff;
  out[2] = (size >>> 12) & 0xff;
  out.set(literals, 3);
  return out;
}

function writeRLELiterals(value: number, size: number): Uint8Array | null {
  if (size <= 0) return null;
  if (size <= 31) return new Uint8Array([(size << 3) | 1, value & 0xff]);
  if (size <= 0x0fff) {
    return new Uint8Array([((size & 0x0f) << 4) | (1 << 2) | 1, (size >>> 4) & 0xff, value & 0xff]);
  }
  if (size <= 0x0fffff) {
    return new Uint8Array([
      ((size & 0x0f) << 4) | (3 << 2) | 1,
      (size >>> 4) & 0xff,
      (size >>> 12) & 0xff,
      value & 0xff,
    ]);
  }
  return null;
}

/** Encode literals as raw or RLE only (Fast path; Strong/Ultra fallback). */
export function encodeLiteralsRaw(literals: Uint8Array): Uint8Array {
  if (literals.length === 0) return new Uint8Array([0]);
  const first = literals[0] ?? 0;
  let allSame = true;
  for (let i = 1; i < literals.length; i++) {
    if ((literals[i] ?? 0) !== first) {
      allSame = false;
      break;
    }
  }
  if (allSame) {
    const rle = writeRLELiterals(first, literals.length);
    if (rle) return rle;
  }
  return writeRawLiterals(literals);
}
