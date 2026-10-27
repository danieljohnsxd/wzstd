/**
 * LSB-first reverse bitstream writer (zstd FSE / Huffman style).
 * Callers write fields in reverse of decode order; finish with end-marker bit 1.
 */

export class ReverseBitWriter {
  private buffer = new Uint8Array(0);
  private outputSize = 0;
  private writePos = 0;
  private bitContainer = 0;
  private bitCount = 0;

  reset(bitLength: number): void {
    this.outputSize = (bitLength + 7) >>> 3;
    if (this.buffer.length < this.outputSize) {
      this.buffer = new Uint8Array(this.outputSize);
    }
    this.buffer.fill(0, 0, this.outputSize);
    this.writePos = 0;
    this.bitContainer = 0;
    this.bitCount = 0;
  }

  writeBits(n: number, bits: number): void {
    let remaining = n;
    let value = bits >>> 0;
    while (remaining > 0) {
      const take = remaining > 24 ? 24 : remaining;
      const partMask = ((1 << take) - 1) >>> 0;
      const part = value & partMask;
      this.bitContainer |= part << this.bitCount;
      this.bitCount += take;
      value >>>= take;
      remaining -= take;
      while (this.bitCount >= 8) {
        this.buffer[this.writePos++] = this.bitContainer & 0xff;
        this.bitContainer >>>= 8;
        this.bitCount -= 8;
      }
    }
  }

  finish(): Uint8Array {
    if (this.bitCount > 0 && this.writePos < this.outputSize) {
      this.buffer[this.writePos++] = this.bitContainer & 0xff;
      this.bitContainer = 0;
      this.bitCount = 0;
    }
    return this.buffer.slice(0, this.outputSize);
  }
}

/**
 * Encode fields listed in decode order by writing them reversed, then end bit 1.
 */
export function encodeReverseBitstream(
  bitCounts: ArrayLike<number>,
  bitValues: ArrayLike<number>,
  writer: ReverseBitWriter = new ReverseBitWriter(),
): Uint8Array {
  let bitLength = 1; // end marker
  for (let i = 0; i < bitCounts.length; i++) {
    const n = bitCounts[i] ?? 0;
    if (n > 0) bitLength += n;
  }
  writer.reset(bitLength);
  for (let i = bitCounts.length - 1; i >= 0; i--) {
    const n = bitCounts[i] ?? 0;
    if (n > 0) writer.writeBits(n, bitValues[i] ?? 0);
  }
  writer.writeBits(1, 1);
  return writer.finish();
}
