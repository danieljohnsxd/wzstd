/**
 * Strong/Ultra literals path: try Huffman, else raw/RLE.
 * Keep this module out of the Fast import graph for tree-shaking.
 */

import { tryEncodeHuffmanLiterals } from "./huffman.js";
import { encodeLiteralsRaw } from "./literals.js";

export function encodeLiteralsWithHuffman(literals: Uint8Array): Uint8Array {
  if (literals.length >= 16) {
    const huf = tryEncodeHuffmanLiterals(literals);
    if (huf) return huf;
  }
  return encodeLiteralsRaw(literals);
}
