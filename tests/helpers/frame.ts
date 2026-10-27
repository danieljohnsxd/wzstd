/**
 * Frame header parsing for tests that walk block structure.
 *
 * Three test files used to hand-compute `5 + fcsBytes`, which silently assumed
 * every frame is single-segment. Frames above the match window carry a window
 * descriptor byte before the content size, so that assumption broke and read
 * block headers from the wrong offset. Parse it in one place instead.
 */

/** Byte offset of the first block header, i.e. the end of the frame header. */
export function frameHeaderSize(frame: Uint8Array): number {
  const fd = frame[4] ?? 0;
  const fcsFlag = fd >>> 6;
  const singleSegment = (fd >> 5) & 1;
  const dictFlag = fd & 3;
  // Frame_Content_Size is 1 byte when the flag is 0 *and* the frame is
  // single-segment; otherwise the flag selects 1/2/4/8.
  const fcsBytes = fcsFlag === 0 ? singleSegment : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
  const dictBytes = dictFlag === 3 ? 4 : dictFlag;
  // magic (4) + descriptor (1) + window descriptor (single-segment omits it)
  return 5 + (singleSegment ? 0 : 1) + dictBytes + fcsBytes;
}

export type BlockInfo = {
  /** Offset of the 3-byte block header. */
  pos: number;
  /** Block_Type: 0 raw, 1 RLE, 2 compressed. */
  type: number;
  /** Block_Size field (compressed size, or regenerated size for RLE). */
  size: number;
  last: boolean;
};

/** Every block in a single frame, in order. */
export function walkBlocks(frame: Uint8Array): Array<BlockInfo> {
  const blocks: Array<BlockInfo> = [];
  let pos = frameHeaderSize(frame);
  while (pos + 3 <= frame.length) {
    const h = (frame[pos] ?? 0) | ((frame[pos + 1] ?? 0) << 8) | ((frame[pos + 2] ?? 0) << 16);
    const last = (h & 1) === 1;
    const type = (h >> 1) & 3;
    const size = h >>> 3;
    blocks.push({ pos, type, size, last });
    // RLE blocks carry a single byte regardless of the regenerated size.
    pos += 3 + (type === 1 ? 1 : size);
    if (last) break;
  }
  return blocks;
}
