/**
 * XXH64, streaming, for zstd's frame content checksum.
 *
 * zstd stores the **low 32 bits** of XXH64(decompressed content, seed 0) in the
 * 4 bytes after the last block. Verifying it is the only way this decoder can
 * detect corruption: without it, damaged input decodes to different bytes and
 * returns successfully, which is what `zstd -d` reports as "Restored data
 * doesn't match checksum".
 *
 * 64-bit arithmetic is done as two 32-bit halves rather than with `BigInt`.
 * BigInt allocates per operation and is roughly an order of magnitude slower;
 * the halves version is plain Smi math the JIT keeps in registers. Every
 * intermediate is kept unsigned with `>>> 0`, since JS bitwise operators return
 * signed 32-bit values.
 *
 * The `rh`/`rl` helper convention below is for the digest tail and the
 * partial-stripe path, which run once per digest and once per undersized update.
 * The bulk path is {@link Xxh64.stripes}, which does not use it — see the comment
 * there, because returning 64-bit values through module slots is what used to
 * cost this hash most of its throughput.
 */

// XXH64 primes, as [high, low] 32-bit halves.
const P1H = 0x9e3779b1,
  P1L = 0x85ebca87;
const P2H = 0xc2b2ae3d,
  P2L = 0x27d4eb4f;
const P3H = 0x165667b1,
  P3L = 0x9e3779f9;
const P4H = 0x85ebca77,
  P4L = 0xc2b2ae63;
const P5H = 0x27d4eb2f,
  P5L = 0x165667c5;

/**
 * The 64-bit accumulator, as a pair of 32-bit halves.
 *
 * Returning a fresh array or object per operation would allocate in the inner
 * loop, so every helper writes here instead and callers read it out before the
 * next call. Single-threaded, single-digest-at-a-time by construction: `update`
 * never yields between a write and its read.
 */
let rh = 0;
let rl = 0;

/** `rh:rl = a * b`, 64x64 → low 64 bits, via 16-bit limbs. */
function mul64(ah: number, al: number, bh: number, bl: number): void {
  const a48 = ah >>> 16,
    a32 = ah & 0xffff,
    a16 = al >>> 16,
    a00 = al & 0xffff;
  const b48 = bh >>> 16,
    b32 = bh & 0xffff,
    b16 = bl >>> 16,
    b00 = bl & 0xffff;
  let c00 = a00 * b00;
  let c16 = c00 >>> 16;
  c00 &= 0xffff;
  c16 += a16 * b00;
  let c32 = c16 >>> 16;
  c16 &= 0xffff;
  c16 += a00 * b16;
  c32 += c16 >>> 16;
  c16 &= 0xffff;
  c32 += a32 * b00;
  let c48 = c32 >>> 16;
  c32 &= 0xffff;
  c32 += a16 * b16;
  c48 += c32 >>> 16;
  c32 &= 0xffff;
  c32 += a00 * b32;
  c48 += c32 >>> 16;
  c32 &= 0xffff;
  c48 += a48 * b00 + a32 * b16 + a16 * b32 + a00 * b48;
  c48 &= 0xffff;
  rh = ((c48 << 16) | c32) >>> 0;
  rl = ((c16 << 16) | c00) >>> 0;
}

/** `rh:rl = a + b`. */
function add64(ah: number, al: number, bh: number, bl: number): void {
  const l = (al >>> 0) + (bl >>> 0);
  rl = l >>> 0;
  rh = (ah + bh + (l > 0xffffffff ? 1 : 0)) >>> 0;
}

/** `rh:rl = rotl(a, n)` for 0 < n < 32. */
function rotl64(ah: number, al: number, n: number): void {
  const m = 32 - n;
  rh = ((ah << n) | (al >>> m)) >>> 0;
  rl = ((al << n) | (ah >>> m)) >>> 0;
}

/** XXH64's `round`: `rotl(acc + lane * P2, 31) * P1`. */
function round(ah: number, al: number, lh: number, ll: number): void {
  mul64(lh, ll, P2H, P2L);
  add64(ah, al, rh, rl);
  rotl64(rh, rl, 31);
  mul64(rh, rl, P1H, P1L);
}

/**
 * Incremental XXH64 digest.
 *
 * Holds the four accumulators plus a 32-byte stripe buffer, so content can
 * arrive in blocks of any size — which is the streaming decoder's whole shape.
 */
export class Xxh64 {
  // Four accumulators, high/low halves.
  private v1h = 0;
  private v1l = 0;
  private v2h = 0;
  private v2l = 0;
  private v3h = 0;
  private v3l = 0;
  private v4h = 0;
  private v4l = 0;
  /** Total bytes seen; only the low 32 bits can matter below 4 GiB. */
  private len = 0;
  /** Partial stripe carried between updates. */
  private readonly buf = new Uint8Array(32);
  private held = 0;

  constructor() {
    // seed 0: v1 = P1 + P2, v2 = P2, v3 = 0, v4 = -P1.
    add64(P1H, P1L, P2H, P2L);
    this.v1h = rh;
    this.v1l = rl;
    this.v2h = P2H;
    this.v2l = P2L;
    this.v3h = 0;
    this.v3l = 0;
    // -P1 as two's complement in 64 bits.
    this.v4l = (~P1L + 1) >>> 0;
    this.v4h = (~P1H + (this.v4l === 0 ? 1 : 0)) >>> 0;
  }

  update(data: Uint8Array): void {
    const n = data.length;
    if (n === 0) return;
    this.len += n;
    let p = 0;

    // Top up a held partial stripe first.
    if (this.held > 0) {
      const want = 32 - this.held;
      if (n < want) {
        this.buf.set(data, this.held);
        this.held += n;
        return;
      }
      this.buf.set(data.subarray(0, want), this.held);
      this.stripe(this.buf, 0);
      this.held = 0;
      p = want;
    }

    const limit = n - 32;
    if (p <= limit) {
      this.stripes(data, p, limit);
      p += Math.floor((limit - p) / 32 + 1) * 32;
    }

    if (p < n) {
      this.buf.set(data.subarray(p), 0);
      this.held = n - p;
    }
  }

  /** One 32-byte stripe: four lanes, one `round` each. */
  private stripe(d: Uint8Array, p: number): void {
    round(this.v1h, this.v1l, u32(d, p + 4), u32(d, p));
    this.v1h = rh;
    this.v1l = rl;
    round(this.v2h, this.v2l, u32(d, p + 12), u32(d, p + 8));
    this.v2h = rh;
    this.v2l = rl;
    round(this.v3h, this.v3l, u32(d, p + 20), u32(d, p + 16));
    this.v3h = rh;
    this.v3l = rl;
    round(this.v4h, this.v4l, u32(d, p + 28), u32(d, p + 24));
    this.v4h = rh;
    this.v4l = rl;
  }

  /**
   * The stripe loop: same arithmetic as {@link stripe}, with every 64-bit
   * operation written out so that **no intermediate leaves a local**.
   *
   * That is the whole point, and it is worth more than the arithmetic. `rh`/`rl`
   * are module-level slots, so a helper that returns through them stores a
   * tagged value on every 64-bit result — and a `>>> 0` result above 2^30 cannot
   * be a Smi, so each store is a candidate heap allocation. At eight multiplies
   * per 32-byte stripe that is allocation-per-multiply. Locals are Word32 in
   * registers, and removing the round-trip is worth **7.6-7.8x** on a 4 MB
   * digest; the helpers it replaced were themselves already prime-specialised.
   *
   * Two further things this shape buys: lanes come from one `DataView` load each
   * instead of four byte loads and three shifts, and each 64-bit multiply is six
   * multiplies rather than ten. Only `al * CL` needs its high half, so limbs are
   * required there alone; `al * CH` and `ah * CL` contribute only their low 32
   * bits, which is exactly `Math.imul`. That part alone was worth 1.2x.
   */
  private stripes(d: Uint8Array, from: number, to: number): void {
    const dv = new DataView(d.buffer, d.byteOffset, d.length);
    let v1h = this.v1h,
      v1l = this.v1l;
    let v2h = this.v2h,
      v2l = this.v2l;
    let v3h = this.v3h,
      v3l = this.v3l;
    let v4h = this.v4h,
      v4l = this.v4l;
    let ll = 0,
      lh = 0,
      a0 = 0,
      a1 = 0,
      t0 = 0,
      t1 = 0,
      t2 = 0,
      t3 = 0,
      mid = 0,
      l = 0,
      h = 0,
      al = 0,
      ah = 0;
    for (let p = from; p <= to; p += 32) {
      // Lane 1
      ll = dv.getUint32(p + 0, true);
      lh = dv.getUint32(p + 4, true);
      // l = lane * P2
      a1 = ll >>> 16;
      a0 = ll & 0xffff;
      t0 = a0 * 0xeb4f;
      t1 = a1 * 0xeb4f;
      t2 = a0 * 0x27d4;
      t3 = a1 * 0x27d4;
      mid = (t0 >>> 16) + (t1 & 0xffff) + (t2 & 0xffff);
      l = ((mid << 16) | (t0 & 0xffff)) >>> 0;
      h =
        (t3 +
          (t1 >>> 16) +
          (t2 >>> 16) +
          (mid >>> 16) +
          Math.imul(ll, 0xc2b2ae3d) +
          Math.imul(lh, 0x27d4eb4f)) >>>
        0;
      // acc += l, then rotl 31
      al = (v1l + l) >>> 0;
      ah = (v1h + h + (al < l ? 1 : 0)) >>> 0;
      l = ((al << 31) | (ah >>> 1)) >>> 0;
      h = ((ah << 31) | (al >>> 1)) >>> 0;
      // acc = acc * P1
      a1 = l >>> 16;
      a0 = l & 0xffff;
      t0 = a0 * 0xca87;
      t1 = a1 * 0xca87;
      t2 = a0 * 0x85eb;
      t3 = a1 * 0x85eb;
      mid = (t0 >>> 16) + (t1 & 0xffff) + (t2 & 0xffff);
      v1l = ((mid << 16) | (t0 & 0xffff)) >>> 0;
      v1h =
        (t3 +
          (t1 >>> 16) +
          (t2 >>> 16) +
          (mid >>> 16) +
          Math.imul(l, 0x9e3779b1) +
          Math.imul(h, 0x85ebca87)) >>>
        0;
      // Lane 2
      ll = dv.getUint32(p + 8, true);
      lh = dv.getUint32(p + 12, true);
      // l = lane * P2
      a1 = ll >>> 16;
      a0 = ll & 0xffff;
      t0 = a0 * 0xeb4f;
      t1 = a1 * 0xeb4f;
      t2 = a0 * 0x27d4;
      t3 = a1 * 0x27d4;
      mid = (t0 >>> 16) + (t1 & 0xffff) + (t2 & 0xffff);
      l = ((mid << 16) | (t0 & 0xffff)) >>> 0;
      h =
        (t3 +
          (t1 >>> 16) +
          (t2 >>> 16) +
          (mid >>> 16) +
          Math.imul(ll, 0xc2b2ae3d) +
          Math.imul(lh, 0x27d4eb4f)) >>>
        0;
      // acc += l, then rotl 31
      al = (v2l + l) >>> 0;
      ah = (v2h + h + (al < l ? 1 : 0)) >>> 0;
      l = ((al << 31) | (ah >>> 1)) >>> 0;
      h = ((ah << 31) | (al >>> 1)) >>> 0;
      // acc = acc * P1
      a1 = l >>> 16;
      a0 = l & 0xffff;
      t0 = a0 * 0xca87;
      t1 = a1 * 0xca87;
      t2 = a0 * 0x85eb;
      t3 = a1 * 0x85eb;
      mid = (t0 >>> 16) + (t1 & 0xffff) + (t2 & 0xffff);
      v2l = ((mid << 16) | (t0 & 0xffff)) >>> 0;
      v2h =
        (t3 +
          (t1 >>> 16) +
          (t2 >>> 16) +
          (mid >>> 16) +
          Math.imul(l, 0x9e3779b1) +
          Math.imul(h, 0x85ebca87)) >>>
        0;
      // Lane 3
      ll = dv.getUint32(p + 16, true);
      lh = dv.getUint32(p + 20, true);
      // l = lane * P2
      a1 = ll >>> 16;
      a0 = ll & 0xffff;
      t0 = a0 * 0xeb4f;
      t1 = a1 * 0xeb4f;
      t2 = a0 * 0x27d4;
      t3 = a1 * 0x27d4;
      mid = (t0 >>> 16) + (t1 & 0xffff) + (t2 & 0xffff);
      l = ((mid << 16) | (t0 & 0xffff)) >>> 0;
      h =
        (t3 +
          (t1 >>> 16) +
          (t2 >>> 16) +
          (mid >>> 16) +
          Math.imul(ll, 0xc2b2ae3d) +
          Math.imul(lh, 0x27d4eb4f)) >>>
        0;
      // acc += l, then rotl 31
      al = (v3l + l) >>> 0;
      ah = (v3h + h + (al < l ? 1 : 0)) >>> 0;
      l = ((al << 31) | (ah >>> 1)) >>> 0;
      h = ((ah << 31) | (al >>> 1)) >>> 0;
      // acc = acc * P1
      a1 = l >>> 16;
      a0 = l & 0xffff;
      t0 = a0 * 0xca87;
      t1 = a1 * 0xca87;
      t2 = a0 * 0x85eb;
      t3 = a1 * 0x85eb;
      mid = (t0 >>> 16) + (t1 & 0xffff) + (t2 & 0xffff);
      v3l = ((mid << 16) | (t0 & 0xffff)) >>> 0;
      v3h =
        (t3 +
          (t1 >>> 16) +
          (t2 >>> 16) +
          (mid >>> 16) +
          Math.imul(l, 0x9e3779b1) +
          Math.imul(h, 0x85ebca87)) >>>
        0;
      // Lane 4
      ll = dv.getUint32(p + 24, true);
      lh = dv.getUint32(p + 28, true);
      // l = lane * P2
      a1 = ll >>> 16;
      a0 = ll & 0xffff;
      t0 = a0 * 0xeb4f;
      t1 = a1 * 0xeb4f;
      t2 = a0 * 0x27d4;
      t3 = a1 * 0x27d4;
      mid = (t0 >>> 16) + (t1 & 0xffff) + (t2 & 0xffff);
      l = ((mid << 16) | (t0 & 0xffff)) >>> 0;
      h =
        (t3 +
          (t1 >>> 16) +
          (t2 >>> 16) +
          (mid >>> 16) +
          Math.imul(ll, 0xc2b2ae3d) +
          Math.imul(lh, 0x27d4eb4f)) >>>
        0;
      // acc += l, then rotl 31
      al = (v4l + l) >>> 0;
      ah = (v4h + h + (al < l ? 1 : 0)) >>> 0;
      l = ((al << 31) | (ah >>> 1)) >>> 0;
      h = ((ah << 31) | (al >>> 1)) >>> 0;
      // acc = acc * P1
      a1 = l >>> 16;
      a0 = l & 0xffff;
      t0 = a0 * 0xca87;
      t1 = a1 * 0xca87;
      t2 = a0 * 0x85eb;
      t3 = a1 * 0x85eb;
      mid = (t0 >>> 16) + (t1 & 0xffff) + (t2 & 0xffff);
      v4l = ((mid << 16) | (t0 & 0xffff)) >>> 0;
      v4h =
        (t3 +
          (t1 >>> 16) +
          (t2 >>> 16) +
          (mid >>> 16) +
          Math.imul(l, 0x9e3779b1) +
          Math.imul(h, 0x85ebca87)) >>>
        0;
    }
    this.v1h = v1h;
    this.v1l = v1l;
    this.v2h = v2h;
    this.v2l = v2l;
    this.v3h = v3h;
    this.v3l = v3l;
    this.v4h = v4h;
    this.v4l = v4l;
  }

  /** Low 32 bits of the digest — the only part zstd stores. */
  digest32(): number {
    let hh: number;
    let hl: number;
    if (this.len >= 32) {
      rotl64(this.v1h, this.v1l, 1);
      hh = rh;
      hl = rl;
      rotl64(this.v2h, this.v2l, 7);
      add64(hh, hl, rh, rl);
      hh = rh;
      hl = rl;
      rotl64(this.v3h, this.v3l, 12);
      add64(hh, hl, rh, rl);
      hh = rh;
      hl = rl;
      rotl64(this.v4h, this.v4l, 18);
      add64(hh, hl, rh, rl);
      hh = rh;
      hl = rl;
      hh = this.merge(hh, hl, this.v1h, this.v1l);
      hl = rl;
      hh = this.merge(hh, hl, this.v2h, this.v2l);
      hl = rl;
      hh = this.merge(hh, hl, this.v3h, this.v3l);
      hl = rl;
      hh = this.merge(hh, hl, this.v4h, this.v4l);
      hl = rl;
    } else {
      // Under one stripe the accumulators were never used: h = seed + P5.
      hh = P5H;
      hl = P5L;
    }

    add64(hh, hl, (this.len / 4294967296) >>> 0, this.len >>> 0);
    hh = rh;
    hl = rl;

    // Tail: the held bytes, 8 then 4 then 1 at a time.
    const d = this.buf;
    const n = this.held;
    let p = 0;
    for (; p + 8 <= n; p += 8) {
      round(0, 0, u32(d, p + 4), u32(d, p));
      hh = (hh ^ rh) >>> 0;
      hl = (hl ^ rl) >>> 0;
      rotl64(hh, hl, 27);
      mul64(rh, rl, P1H, P1L);
      add64(rh, rl, P4H, P4L);
      hh = rh;
      hl = rl;
    }
    if (p + 4 <= n) {
      mul64(0, u32(d, p), P1H, P1L);
      hh = (hh ^ rh) >>> 0;
      hl = (hl ^ rl) >>> 0;
      rotl64(hh, hl, 23);
      mul64(rh, rl, P2H, P2L);
      add64(rh, rl, P3H, P3L);
      hh = rh;
      hl = rl;
      p += 4;
    }
    for (; p < n; p++) {
      mul64(0, d[p] ?? 0, P5H, P5L);
      hh = (hh ^ rh) >>> 0;
      hl = (hl ^ rl) >>> 0;
      rotl64(hh, hl, 11);
      mul64(rh, rl, P1H, P1L);
      hh = rh;
      hl = rl;
    }

    // Avalanche. Each `h ^= h >> k` is done on the pair; note a JS shift count
    // is taken mod 32, so `hh >>> 33` would silently mean `hh >>> 1` — the
    // high half of a 33-bit shift is zero and must be written as such.
    hl = (hl ^ (hh >>> 1)) >>> 0;
    mul64(hh, hl, P2H, P2L);
    hh = rh;
    hl = rl;
    hl = (hl ^ ((hh << 3) | (hl >>> 29))) >>> 0;
    hh = (hh ^ (hh >>> 29)) >>> 0;
    mul64(hh, hl, P3H, P3L);
    hh = rh;
    hl = rl;
    hl = (hl ^ hh) >>> 0;
    return hl >>> 0;
  }

  /** XXH64's `mergeRound`, leaving the new high half returned and low in `rl`. */
  private merge(hh: number, hl: number, vh: number, vl: number): number {
    round(0, 0, vh, vl);
    const xh = (hh ^ rh) >>> 0;
    const xl = (hl ^ rl) >>> 0;
    mul64(xh, xl, P1H, P1L);
    add64(rh, rl, P4H, P4L);
    return rh;
  }
}

/** Little-endian u32 load; OOB lanes read as 0. */
function u32(d: Uint8Array, i: number): number {
  return (
    ((d[i] ?? 0) | ((d[i + 1] ?? 0) << 8) | ((d[i + 2] ?? 0) << 16) | ((d[i + 3] ?? 0) << 24)) >>> 0
  );
}
