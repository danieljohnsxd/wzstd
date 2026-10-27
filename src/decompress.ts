// Some numerical data is initialized as -1 even when it doesn't need initialization to help the JIT infer types

import { Xxh64 } from "./xxh64.js";

// aliases for shorter compressed code (most minifers don't do this)
const ab = ArrayBuffer,
  u8 = Uint8Array,
  u16 = Uint16Array,
  i16 = Int16Array,
  i32 = Int32Array;

// Huffman decoding table
interface HDT {
  // initial bits
  b: number;
  // symbols
  s: Uint8Array;
  // num bits
  n: Uint8Array;
}

// FSE decoding table
interface FSEDT extends HDT {
  // next state
  t: Uint16Array;
}

// decompress Zstandard state
interface DZstdState {
  // byte
  b: number;
  // out byte
  y: number;
  // dictionary ID
  d: number;
  // window
  w: Uint8Array;
  // max block size
  m: number;
  // uncompressed size
  u: number;
  // has checksum
  c: number;
  // offsets
  o: Int32Array;
  // window head
  e: number;
  // window size (streaming only): bytes of history kept behind `e` when the
  // buffer is compacted. The buffer itself is larger, so appends stay cheap.
  g: number;
  // last huffman decoding table
  h?: HDT;
  // last FSE decoding tables
  t?: [FSEDT, FSEDT, FSEDT];
  // last block
  l: number;
  // Streaming block scratch (st.m bytes), reused across blocks. Every block
  // handed to `ondata` is copied out of it, never a view of it.
  k?: Uint8Array;
}

/** Numeric index read. OOB → 0, matching JS bitwise coercion of undefined. */
const at = (d: ArrayLike<number>, i: number): number => d[i] ?? 0;

/**
 * Slack a padded view carries on each side, in bytes.
 *
 * Both bit readers load a 32-bit word at the byte holding their lowest wanted
 * bit, so a read reaches 3 bytes past that byte — hence the trailing slack.
 *
 * The leading slack is subtler. A backward bit reader walks `pos` down and the
 * loop bound lets it go slightly negative on the final symbols of a stream, so
 * reads land below index 0. The byte-load form returned 0 there (`at` maps OOB
 * to 0) and the decoded value depends on it, so those bytes must genuinely be
 * **zero**, not merely readable — which is why a padded view is always a fresh
 * zero-filled copy rather than a re-use of an input that happens to have room.
 *
 * 8 covers both: the trailing read reaches +3, and a stream's final state
 * updates can walk back about 26 bits (~4 bytes) below zero.
 */
const PAD = 8;

/**
 * A zero-padded copy of `d`, positioned so reads from `-PAD` to `length + PAD`
 * are in bounds and read as zero outside the data.
 *
 * This invariant is the whole reason the hot loops carry no bounds check. A
 * per-read guard costs more than the loads it saves: on the sequence loop's
 * access pattern a guarded wide read measured 74ms against 65ms for the
 * byte-load loop it replaces, and 27ms unguarded. Paying once, here, is what
 * makes the wide read worth doing.
 *
 * The copy is of the *compressed* bytes and is well under 1% of decode.
 */
const pad = (d: Uint8Array): Uint8Array => {
  const c = new u8(PAD + d.length + PAD);
  c.set(d, PAD);
  return c.subarray(PAD, PAD + d.length);
};

/**
 * DataView over a padded view, based `PAD` bytes before the data so that
 * {@link r32} can address the leading slack with a negative index.
 */
const view = (d: Uint8Array): DataView => new DataView(d.buffer, d.byteOffset - PAD);

/**
 * Little-endian 32-bit word at byte `i`, where `i` may be negative down to
 * `-PAD`. Only valid on a view from {@link view} over a {@link pad}ded buffer.
 */
const r32 = (dv: DataView, i: number): number => dv.getUint32(i + PAD, true);

const slc = (v: Uint8Array, s: number, e?: number): Uint8Array => v.slice(s, e);

const fill = (v: Uint8Array, n: number, s?: number, e?: number): Uint8Array => v.fill(n, s, e);

const cpw = (v: Uint8Array, t: number, s?: number, e?: number): void => {
  v.copyWithin(t, s ?? 0, e);
};

/**
 * Codes for errors generated within this library
 */
export const ZstdErrorCode = {
  InvalidData: 0,
  WindowSizeTooLarge: 1,
  InvalidBlockType: 2,
  FSEAccuracyTooHigh: 3,
  DistanceTooFarBack: 4,
  UnexpectedEOF: 5,
  ChecksumMismatch: 6,
  OutputTooLarge: 7,
} as const;

/** Numeric error code values from {@link ZstdErrorCode}. */
export type ZstdErrorCodeValue = (typeof ZstdErrorCode)[keyof typeof ZstdErrorCode];

// error messages indexed by ZstdErrorCodeValue
const ec: Record<ZstdErrorCodeValue, string> = {
  [ZstdErrorCode.InvalidData]: "invalid zstd data",
  [ZstdErrorCode.WindowSizeTooLarge]: "window size too large (>128 MiB)",
  [ZstdErrorCode.InvalidBlockType]: "invalid block type",
  [ZstdErrorCode.FSEAccuracyTooHigh]: "FSE accuracy too high",
  [ZstdErrorCode.DistanceTooFarBack]: "match distance too far back",
  [ZstdErrorCode.UnexpectedEOF]: "unexpected EOF",
  [ZstdErrorCode.ChecksumMismatch]: "content checksum mismatch",
  [ZstdErrorCode.OutputTooLarge]: "output exceeds maxSize",
};

/**
 * Largest Window_Size a frame may declare: 2^27 = 128 MiB.
 *
 * This is libzstd's default decoder limit, `ZSTD_WINDOWLOG_LIMIT_DEFAULT` (27),
 * which the `zstd` CLI and `node:zlib` both apply unless told otherwise. It is
 * a fixed limit, not an option — frames above it need `--long=28` or larger
 * (or `--memory`) on the native side too. A single-segment frame declares its
 * content size as its window, so this bounds those as well, exactly as libzstd
 * streaming decode does.
 */
const MAX_WINDOW = 2 ** 27;

/** Default output cap for every decode entry point: 64 MiB. */
const MAX_SIZE = 64 * 1024 * 1024;

/**
 * Output upper bound per input byte. A block regenerates at most 128 KiB and
 * its header alone is 3 bytes, so no frame can produce more than
 * `128 KiB / 3` bytes per input byte. Used only to keep a declared content
 * size from preallocating memory the input cannot possibly fill.
 */
const MAX_RATIO = 65536;

/**
 * An error generated within this library
 */
export class ZstdError extends Error {
  /**
   * The code associated with this error
   */
  readonly code: ZstdErrorCodeValue;

  constructor(code: ZstdErrorCodeValue, message?: string) {
    super(message ?? ec[code]);
    this.name = "ZstdError";
    this.code = code;
    // V8-only stack trim. @types/node declares it as always present, which is
    // true on Node but not on JSC (Safari, Bun) or SpiderMonkey — so widen to
    // optional rather than intersecting, keeping the runtime check honest
    // instead of merely unreachable-by-types.
    const capture = (Error as Partial<Pick<ErrorConstructor, "captureStackTrace">>)
      .captureStackTrace;
    if (capture) capture(this, ZstdError);
  }
}

function err(ind: ZstdErrorCodeValue, msg?: string | 0): never;
function err(ind: ZstdErrorCodeValue, msg: string | 0 | undefined, nt: 1): ZstdError;
function err(ind: ZstdErrorCodeValue, msg?: string | 0, nt?: 1): ZstdError {
  // `msg` is `string | 0 | undefined`; 0 is the "no message" sentinel.
  const e = new ZstdError(ind, msg || undefined);
  if (!nt) throw e;
  return e;
}

/** Little-endian unsigned read of `n` bytes (avoids signed `<<` for FCS ≥ 2³¹). */
const rb = (d: Uint8Array, b: number, n: number): number => {
  let o = 0;
  for (let i = 0; i < n; ++i) o += at(d, b + i) * 256 ** i;
  return o;
};

const b4 = (d: Uint8Array, b: number): number =>
  (at(d, b) | (at(d, b + 1) << 8) | (at(d, b + 2) << 16) | (at(d, b + 3) << 24)) >>> 0;

// read Zstandard frame header
const rzfh = (dat: Uint8Array, w?: Uint8Array | 1, cap = 0): number | DZstdState => {
  const n3 = at(dat, 0) | (at(dat, 1) << 8) | (at(dat, 2) << 16);
  if (n3 == 0x2fb528 && at(dat, 3) == 253) {
    // Zstandard
    const flg = at(dat, 4);
    //    single segment       checksum             dict flag     frame content flag
    const ss = (flg >> 5) & 1,
      cc = (flg >> 2) & 1,
      df = flg & 3,
      fcf = flg >> 6;
    if (flg & 8) err(0);
    // byte
    let bt = 6 - ss;
    // dict bytes
    const db = df == 3 ? 4 : df;
    // dictionary id
    const di = rb(dat, bt, db);
    bt += db;
    // Dictionary frames are not supported — fail closed rather than
    // producing silent wrong output without dictionary contents.
    if (di) err(0);
    // frame size bytes
    const fsb = fcf ? 1 << fcf : ss;
    // frame source size
    const fss = rb(dat, bt, fsb) + (fcf == 1 ? 256 : 0);
    // window size
    let ws = fss;
    if (!ss) {
      // Window descriptor. `2 **` and `/ 8`, never `1 <<` and `>> 3`: the
      // exponent field runs to Window_Log 41 and a 32-bit shift wraps, so
      // the check below was reached with a *wrong* window. Window_Log 31
      // came out negative and sailed past the limit; 32 and above wrapped
      // down to a 1–512 byte window, which the block reader then honoured.
      const wb = 2 ** (10 + (at(dat, 5) >> 3));
      ws = wb + (wb / 8) * (at(dat, 5) & 7);
    }
    if (ws > MAX_WINDOW) err(1);
    const mbs = Math.min(131072, ws);
    // w == 1 is the one-shot allocating path: it needs a frame-sized buffer
    // only when the content size is known, since decompress() grows its own
    // buffer otherwise. The declared size is attacker-controlled, so it is
    // honoured only up to `cap` (the caller's remaining maxSize, and what the
    // input could possibly regenerate); above that, decompress() falls back
    // to the growing buffer and the size is verified against real output.
    // Streaming starts small and grows toward the declared window as data
    // actually arrives — a frame may declare a window far larger than it ever
    // uses, and allocating it up front let a 27-byte frame reserve 129 MiB.
    const buf = new u8((w == 1 ? (fss <= cap ? fss : 0) : w ? 0 : Math.min(ws, mbs * 2)) + 12);
    ((buf[0] = 1), (buf[4] = 4), (buf[8] = 8));
    return {
      b: bt + fsb,
      y: 0,
      l: 0,
      d: di,
      w: w && w != 1 ? w : buf.subarray(12),
      // Empty history. Streaming previously started at `ws`, which made a
      // backreference before the frame's first byte read zeros instead of
      // failing; the one-shot path has always started at 0.
      e: 0,
      o: new i32(buf.buffer, 0, 3),
      u: fss,
      c: cc,
      g: ws,
      m: mbs,
    };
  }
  if (((n3 >> 4) | (at(dat, 3) << 20)) == 0x184d2a5) {
    // skippable
    return b4(dat, 4) + 8;
  }
  err(0);
};

/**
 * Largest symbol each code space admits, fixed by the format.
 *
 * `MAX_LL` / `MAX_ML` / `MAX_OF` are the sequence code sets (RFC 8878 §3.1.1.3.2);
 * `MAX_HW` is the Huffman weight alphabet, bounded by the 11-bit cap on code
 * lengths. These are the bounds `rfse` enforces and the exact widths `llb`,
 * `llbl`, `mlb` and `mlbl` are allocated to.
 */
const MAX_LL = 35,
  MAX_ML = 52,
  MAX_OF = 31,
  MAX_HW = 11;

/** The three sequence bounds in the order the table triple is held: ML, OF, LL. */
const MSV = [MAX_ML, MAX_OF, MAX_LL];

// most significant bit for nonzero
const msb = (val: number): number => {
  let bits = 0;
  for (; 1 << bits <= val; ++bits);
  return bits - 1;
};

/**
 * Read a finite state entropy table description.
 *
 * `mal` bounds the accuracy log and `mxs` the largest symbol the table may
 * describe. Both come from the code space the table is being built for, and
 * both are format constraints, not heuristics: the spec fixes the symbol sets
 * at LL ≤ 35, ML ≤ 52 and OF ≤ 31, and libzstd bounds the same value in
 * `FSE_readNCount`. Enforcing `mxs` here is what lets every consumer index its
 * code tables unguarded — see {@link llb}.
 */
const rfse = (dat: Uint8Array, bt: number, mal: number, mxs: number): [number, FSEDT] => {
  // table pos
  let tpos = (bt << 3) + 4;
  // accuracy log
  const al = (at(dat, bt) & 15) + 5;
  if (al > mal) err(3);
  // size
  const sz = 1 << al;
  // probabilities symbols  repeat   index   high threshold
  let probs = sz,
    sym = -1,
    re = -1,
    i = -1,
    ht = sz;
  // optimization: single allocation is much faster
  const buf = new ab(512 + (sz << 2));
  const freq = new i16(buf, 0, 256);
  // same view as freq
  const dstate = new u16(buf, 0, 256);
  const nstate = new u16(buf, 512, sz);
  const bb1 = 512 + (sz << 1);
  const syms = new u8(buf, bb1, sz);
  const nbits = new u8(buf, bb1 + sz);
  while (sym < 255 && probs > 0) {
    const bits = msb(probs + 1);
    const cbt = tpos >> 3;
    // mask
    const msk = (1 << (bits + 1)) - 1;
    let val =
      ((at(dat, cbt) | (at(dat, cbt + 1) << 8) | (at(dat, cbt + 2) << 16)) >> (tpos & 7)) & msk;
    // mask (1 fewer bit)
    const msk1fb = (1 << bits) - 1;
    // max small value
    const msv = msk - probs - 1;
    // small value
    const sval = val & msk1fb;
    if (sval < msv) ((tpos += bits), (val = sval));
    else {
      tpos += bits + 1;
      if (val > msk1fb) val -= msv;
    }
    freq[++sym] = --val;
    if (val == -1) {
      probs += val;
      syms[--ht] = sym;
    } else probs -= val;
    if (!val) {
      do {
        // repeat byte
        const rbt = tpos >> 3;
        re = ((at(dat, rbt) | (at(dat, rbt + 1) << 8)) >> (tpos & 7)) & 3;
        tpos += 2;
        sym += re;
      } while (re == 3);
    }
  }
  if (sym > mxs || probs) err(0);
  let sympos = 0;
  // sym step (coprime with sz - formula from zstd source)
  const sstep = (sz >> 1) + (sz >> 3) + 3;
  // sym mask
  const smask = sz - 1;
  for (let s = 0; s <= sym; ++s) {
    const sf = freq[s]!;
    if (sf < 1) {
      dstate[s] = -sf;
      continue;
    }
    // This is split into two loops in zstd to avoid branching, but as JS is higher-level that is unnecessary
    for (i = 0; i < sf; ++i) {
      syms[sympos] = s;
      do {
        sympos = (sympos + sstep) & smask;
      } while (sympos >= ht);
    }
  }
  // After spreading symbols, should be zero again
  if (sympos) err(0);
  for (i = 0; i < sz; ++i) {
    // next state
    const sy = syms[i]!;
    const ns = dstate[sy]!;
    dstate[sy] = ns + 1;
    // num bits
    const nb = (nbits[i] = al - msb(ns));
    nstate[i] = (ns << nb) - sz;
  }
  return [
    (tpos + 7) >> 3,
    {
      b: al,
      s: syms,
      n: nbits,
      t: nstate,
    },
  ];
};

// read huffman
const rhu = (dat: Uint8Array, bt: number): [number, HDT] => {
  //  index  weight count
  let i = 0,
    wc = -1;
  //    buffer             header byte
  const buf = new u8(292),
    hb = at(dat, bt);
  // huffman weights
  const hw = buf.subarray(0, 256);
  // rank count
  const rc = buf.subarray(256, 268);
  // rank index
  const ri = new u16(buf.buffer, 268);
  // NOTE: at this point bt is 1 less than expected
  if (hb < 128) {
    // end byte, fse decode table
    const [ebt, fdt] = rfse(dat, bt + 1, 6, MAX_HW);
    bt += hb;
    const epos = ebt << 3;
    // last byte
    const lb = at(dat, bt);
    if (!lb) err(0);
    //  state1   state2   state1 bits   state2 bits
    let st1 = 0,
      st2 = 0,
      btr1 = fdt.b,
      btr2 = btr1;
    // fse pos
    // pre-increment to account for original deficit of 1
    let fpos = (++bt << 3) - 8 + msb(lb);
    for (;;) {
      fpos -= btr1;
      if (fpos < epos) break;
      let cbt = fpos >> 3;
      st1 += ((at(dat, cbt) | (at(dat, cbt + 1) << 8)) >> (fpos & 7)) & ((1 << btr1) - 1);
      hw[++wc] = fdt.s[st1]!;
      fpos -= btr2;
      if (fpos < epos) break;
      cbt = fpos >> 3;
      st2 += ((at(dat, cbt) | (at(dat, cbt + 1) << 8)) >> (fpos & 7)) & ((1 << btr2) - 1);
      hw[++wc] = fdt.s[st2]!;
      btr1 = fdt.n[st1]!;
      st1 = fdt.t[st1]!;
      btr2 = fdt.n[st2]!;
      st2 = fdt.t[st2]!;
    }
    if (++wc > 255) err(0);
  } else {
    wc = hb - 127;
    for (; i < wc; i += 2) {
      const byte = at(dat, ++bt);
      hw[i] = byte >> 4;
      hw[i + 1] = byte & 15;
    }
    ++bt;
  }
  // weight exponential sum
  let wes = 0;
  for (i = 0; i < wc; ++i) {
    const wt = hw[i]!;
    // bits must be at most 11, same as weight
    if (wt > MAX_HW) err(0);
    wes += wt && 1 << (wt - 1);
  }
  // max bits
  const mb = msb(wes) + 1;
  // table size
  const ts = 1 << mb;
  // remaining sum
  const rem = ts - wes;
  // must be power of 2
  if (rem & (rem - 1)) err(0);
  hw[wc++] = msb(rem) + 1;
  for (i = 0; i < wc; ++i) {
    const wt = hw[i]!;
    const nv = wt ? mb + 1 - wt : 0;
    hw[i] = nv;
    rc[nv] = rc[nv]! + 1;
  }
  // huf buf
  const hbuf = new u8(ts << 1);
  //    symbols                      num bits
  const syms = hbuf.subarray(0, ts),
    nb = hbuf.subarray(ts);
  ri[mb] = 0;
  for (i = mb; i > 0; --i) {
    const pv = ri[i]!;
    fill(nb, i, pv, (ri[i - 1] = pv + rc[i]! * (1 << (mb - i))));
  }
  if (ri[0]! != ts) err(0);
  for (i = 0; i < wc; ++i) {
    const bits = hw[i]!;
    if (bits) {
      const code = ri[bits]!;
      fill(syms, i, code, (ri[bits] = code + (1 << (mb - bits))));
    }
  }
  return [
    bt,
    {
      n: nb,
      b: mb,
      s: syms,
    },
  ];
};

// Tables generated using this:
// https://gist.github.com/101arrowz/a979452d4355992cbf8f257cbffc9edd

// default literal length table
const dllt = /*#__PURE__*/ rfse(
  /*#__PURE__*/ new u8([
    81, 16, 99, 140, 49, 198, 24, 99, 12, 33, 196, 24, 99, 102, 102, 134, 70, 146, 4,
  ]),
  0,
  6,
  MAX_LL,
)[1];

// default match length table
const dmlt = /*#__PURE__*/ rfse(
  /*#__PURE__*/ new u8([
    33, 20, 196, 24, 99, 140, 33, 132, 16, 66, 8, 33, 132, 16, 66, 8, 33, 68, 68, 68, 68, 68, 68,
    68, 68, 36, 9,
  ]),
  0,
  6,
  MAX_ML,
)[1];

// default offset code table
const doct = /*#__PURE__ */ rfse(
  /*#__PURE__*/ new u8([32, 132, 16, 66, 102, 70, 68, 68, 68, 68, 36, 73, 2]),
  0,
  5,
  MAX_OF,
)[1];

// bits to baseline
const b2bl = (b: Uint8Array, s: number): Int32Array => {
  const len = b.length,
    bl = new i32(len);
  for (let i = 0; i < len; ++i) {
    bl[i] = s;
    s += 1 << b[i]!;
  }
  return bl;
};

/**
 * Literal-length and match-length code tables, exactly `MAX_LL + 1` and
 * `MAX_ML + 1` entries wide.
 *
 * These four tables are indexed by a symbol taken from an FSE table, and they
 * are read **unguarded** into arithmetic — `llbl[llc] + extra` — where an
 * out-of-bounds `undefined` becomes `NaN` rather than 0. `NaN` then walks
 * straight through `oubt > buf.length` and `need()`, because every comparison
 * against `NaN` is false, so two fail-closed checks would fail open.
 *
 * What makes the narrow width safe is that **every producer of a code symbol is
 * bounded at its source**: `rfse` rejects a table description above `mxs`, and
 * the RLE mode rejects its single byte the same way. So `llc <= MAX_LL` and
 * `mlc <= MAX_ML` hold by construction — the same move {@link pad} makes for
 * the bitstream, and the reason neither read needs a check.
 *
 * The tables were briefly padded to 256 entries instead, which bought the same
 * in-bounds guarantee by widening the array rather than bounding the index. It
 * cost ~1% of decode and, being a domain the format does not have, it silently
 * *decoded* corrupt tables as zero-length codes instead of rejecting them.
 */
// literal length bits
const llb = /*#__PURE__ */ new u8(
  /*#__PURE__ */ new i32([0, 0, 0, 0, 16843009, 50528770, 134678020, 202050057, 269422093]).buffer,
  0,
  MAX_LL + 1,
);

// literal length baseline
const llbl = /*#__PURE__ */ b2bl(llb, 0);

// match length bits
const mlb = /*#__PURE__ */ new u8(
  /*#__PURE__ */ new i32([
    0, 0, 0, 0, 0, 0, 0, 0, 16843009, 50528770, 117769220, 185207048, 252579084, 16,
  ]).buffer,
  0,
  MAX_ML + 1,
);

// match length baseline
const mlbl = /*#__PURE__ */ b2bl(mlb, 3);

// decode huffman stream
const dhu = (dat: Uint8Array, out: Uint8Array, hu: HDT): void => {
  const len = dat.length,
    ss = out.length,
    lb = at(dat, len - 1),
    msk = (1 << hu.b) - 1,
    eb = -hu.b;
  if (!lb) err(0);
  let st = 0,
    pos = (len << 3) - 8 + msb(lb) - hu.b,
    i = -1;
  // `dat` is a subarray of the padded frame, so it inherits the trailing
  // slack and the wide read below needs no bounds check.
  const dv = view(dat);
  for (; pos > eb && i < ss;) {
    // One load *is* the state. fzstd carried the previous state in as
    // `(st << btr) | val` because its 2-byte load held as few as 9 valid bits
    // and could not span an 11-bit code, so the high end had to come from the
    // state it already had. `r32` shifted by `pos & 7` always leaves at least
    // 25 valid bits and `hu.b` is at most 11, so the field at `pos` arrives
    // whole — and the bits the OR contributed were the same bits, since the
    // two reads overlap by construction (`pos` moved down by exactly `btr`).
    // Unsigned shift: getUint32 can exceed 2^31 and `>>` would sign-extend.
    st = (r32(dv, pos >> 3) >>> (pos & 7)) & msk;
    out[++i] = hu.s[st]!;
    pos -= hu.n[st]!;
  }
  if (pos != eb || i + 1 != ss) err(0);
};

// decode huffman stream 4x (sequential by design — sync, zero-dep library)
const dhu4 = (dat: Uint8Array, out: Uint8Array, hu: HDT): void => {
  let bt = 6;
  const ss = out.length,
    sz1 = (ss + 3) >> 2,
    sz2 = sz1 << 1,
    sz3 = sz1 + sz2;
  dhu(dat.subarray(bt, (bt += at(dat, 0) | (at(dat, 1) << 8))), out.subarray(0, sz1), hu);
  dhu(dat.subarray(bt, (bt += at(dat, 2) | (at(dat, 3) << 8))), out.subarray(sz1, sz2), hu);
  dhu(dat.subarray(bt, (bt += at(dat, 4) | (at(dat, 5) << 8))), out.subarray(sz2, sz3), hu);
  dhu(dat.subarray(bt), out.subarray(sz3), hu);
};

/** Ensure a write of `n` bytes at `y` fits in `out`. */
const need = (out: Uint8Array, y: number, n: number): void => {
  if (y + n > out.length) err(0);
};

// read Zstandard block
const rzb = (dat: Uint8Array, st: DZstdState, out?: Uint8Array): Uint8Array | undefined => {
  let bt = st.b;
  //    byte 0        block type
  const b0 = at(dat, bt),
    btype = (b0 >> 1) & 3;
  st.l = b0 & 1;
  const sz = (b0 >> 3) | (at(dat, bt + 1) << 5) | (at(dat, bt + 2) << 13);
  // Block_Maximum_Size is min(128 KiB, Window_Size), which is `st.m`, and the
  // header field reaches 2 MiB. For raw and RLE blocks `sz` *is* the
  // regenerated size, so this is that limit; for a compressed block the spec
  // bounds `sz` by the same value (it must be under the size it regenerates).
  // The check also keeps `new u8(sz)` below the window the frame declared.
  if (sz > st.m) err(0);
  // end byte for block
  const ebt = (bt += 3) + sz;
  if (btype == 1) {
    if (bt >= dat.length) return;
    st.b = bt + 1;
    if (out) {
      need(out, st.y, sz);
      fill(out, at(dat, bt), st.y, (st.y += sz));
      return out;
    }
    return fill(new u8(sz), at(dat, bt));
  }
  if (ebt > dat.length) return;
  if (btype == 0) {
    st.b = ebt;
    if (out) {
      need(out, st.y, sz);
      out.set(dat.subarray(bt, ebt), st.y);
      st.y += sz;
      return out;
    }
    return slc(dat, bt, ebt);
  }
  if (btype == 2) {
    //    byte 3        lit btype     size format
    const b3 = at(dat, bt),
      lbt = b3 & 3,
      sf = (b3 >> 2) & 3;
    // lit src size  lit cmp sz 4 streams
    let lss = b3 >> 4,
      lcs = 0,
      s4 = 0;
    if (lbt < 2) {
      if (sf & 1) lss |= (at(dat, ++bt) << 4) | (sf & 2 && at(dat, ++bt) << 12);
      else lss = b3 >> 3;
    } else {
      s4 = sf;
      if (sf < 2)
        ((lss |= (at(dat, ++bt) & 63) << 4), (lcs = (at(dat, bt) >> 6) | (at(dat, ++bt) << 2)));
      else if (sf == 2)
        ((lss |= (at(dat, ++bt) << 4) | ((at(dat, ++bt) & 3) << 12)),
          (lcs = (at(dat, bt) >> 2) | (at(dat, ++bt) << 6)));
      else
        ((lss |= (at(dat, ++bt) << 4) | ((at(dat, ++bt) & 63) << 12)),
          (lcs = (at(dat, bt) >> 6) | (at(dat, ++bt) << 2) | (at(dat, ++bt) << 10)));
    }
    ++bt;
    // add literals to end - can never overlap with backreferences because unused literals always appended
    // Caller buffer: view is clamped to remaining space (TypedArray subarray end clamp).
    // Streaming decodes into a per-frame scratch and copies the result out:
    // allocating a fresh Block_Maximum_Size buffer per block made a stream of
    // empty 5-byte compressed blocks cost a 128 KiB allocation each.
    let buf = out ? out.subarray(st.y, st.y + st.m) : (st.k ??= new u8(st.m));
    // starting point for literals
    if (lss > buf.length) err(0);
    let spl = buf.length - lss;
    if (lbt == 0) buf.set(dat.subarray(bt, (bt += lss)), spl);
    else if (lbt == 1) fill(buf, at(dat, bt++), spl);
    else {
      // huffman table
      let hu = st.h;
      if (lbt == 2) {
        const [hudBt, hudTable] = rhu(dat, bt);
        // subtract description length
        lcs += bt - (bt = hudBt);
        st.h = hu = hudTable;
      }
      if (hu === undefined) err(0);
      (s4 ? dhu4 : dhu)(dat.subarray(bt, (bt += lcs)), buf.subarray(spl), hu);
    }
    // num sequences
    let ns = at(dat, bt++);
    if (ns) {
      if (ns == 255) ns = (at(dat, bt++) | (at(dat, bt++) << 8)) + 0x7f00;
      else if (ns > 127) ns = ((ns - 128) << 8) | at(dat, bt++);
      // symbol compression modes
      const scm = at(dat, bt++);
      if (scm & 3) err(0);
      const dts: [FSEDT, FSEDT, FSEDT] = [dmlt, doct, dllt];
      for (let i = 2; i > -1; --i) {
        const md = (scm >> ((i << 1) + 2)) & 3;
        // Largest symbol this code space admits — `dts` is [ML, OF, LL].
        const msv = MSV[i]!;
        if (md == 1) {
          // rle buf. The single symbol is a raw input byte, so it needs the
          // same range check `rfse` applies to a table description — it is
          // the other way a sequence code enters the loop.
          const rs = at(dat, bt++);
          if (rs > msv) err(0);
          const rbuf = new u8([0, 0, rs]);
          dts[i] = {
            s: rbuf.subarray(2, 3),
            n: rbuf.subarray(0, 1),
            t: new u16(rbuf.buffer, 0, 1),
            b: 0,
          };
        } else if (md == 2) {
          // accuracy log 8 for offsets, 9 for others
          [bt, dts[i]] = rfse(dat, bt, 9 - (i & 1), msv);
        } else if (md == 3) {
          const prev = st.t;
          if (prev === undefined) err(0);
          const row = prev[i];
          if (row === undefined) err(0);
          dts[i] = row;
        }
      }
      const [mlt, oct, llt] = (st.t = dts);
      const lb = at(dat, ebt - 1);
      if (!lb) err(0);
      // One wide load per field instead of the 2-4 byte loads it takes to
      // assemble the same word. Safe without a bounds check because `dat`
      // carries PAD bytes of slack; see `pad`. Every read is `>>>`, since
      // getUint32 can exceed 2^31 and `>>` would sign-extend.
      const dv = view(dat);
      let spos = (ebt << 3) - 8 + msb(lb) - llt.b,
        oubt = 0;
      let lst = (r32(dv, spos >> 3) >>> (spos & 7)) & ((1 << llt.b) - 1);
      spos -= oct.b;
      let ost = (r32(dv, spos >> 3) >>> (spos & 7)) & ((1 << oct.b) - 1);
      spos -= mlt.b;
      let mst = (r32(dv, spos >> 3) >>> (spos & 7)) & ((1 << mlt.b) - 1);
      for (++ns; --ns;) {
        const llc = llt.s[lst]!;
        const lbtr = llt.n[lst]!;
        const mlc = mlt.s[mst]!;
        const mbtr = mlt.n[mst]!;
        const ofc = oct.s[ost]!;
        const obtr = oct.n[ost]!;

        const ofp = 1 << ofc;
        spos -= ofc;
        let off = ofp + ((r32(dv, spos >> 3) >>> (spos & 7)) & (ofp - 1));
        const mlx = mlb[mlc]!;
        spos -= mlx;
        let ml = mlbl[mlc]! + ((r32(dv, spos >> 3) >>> (spos & 7)) & ((1 << mlx) - 1));

        // Two fields per load, twice. A read carries 32 - (spos & 7) valid
        // bits, so at least 25, and these pairs are adjacent in the stream
        // and provably narrower than that together:
        //
        //   ll extra + LL state  <= 16 + 9 = 25   (llb caps at 16; the LL
        //   ML state + OF state  <=  9 + 8 = 17    and ML accuracy log at
        //                                          9, the OF one at 8)
        //
        // So the pair is always whole in one word and the split needs no
        // guard, no branch and no cached word — the three shapes that made
        // every earlier load-saving attempt here cost more than it saved.
        // Within a pair the later read is the lower field, because `spos`
        // descends.
        //
        // Worth a small win on CLI frames and neutral on our own: this
        // touches only the sequence loop, and our Strong output is
        // literal-heavier, so more of its decode sits in `dhu`. Do not widen
        // the pairs — 25 bits is the floor a byte-unaligned 32-bit read
        // guarantees, and LL+ML+OF states are 26.
        const llx = llb[llc]!;
        spos -= llx + lbtr;
        const lw = r32(dv, spos >> 3) >>> (spos & 7);
        const ll = llbl[llc]! + ((lw >>> lbtr) & ((1 << llx) - 1));
        lst = llt.t[lst]! + (lw & ((1 << lbtr) - 1));

        spos -= mbtr + obtr;
        const sw = r32(dv, spos >> 3) >>> (spos & 7);
        mst = mlt.t[mst]! + ((sw >>> obtr) & ((1 << mbtr) - 1));
        ost = oct.t[ost]! + (sw & ((1 << obtr) - 1));

        if (off > 3) {
          st.o[2] = st.o[1]!;
          st.o[1] = st.o[0]!;
          st.o[0] = off -= 3;
        } else {
          const idx = off - (ll != 0 ? 1 : 0);
          if (idx) {
            off = idx == 3 ? st.o[0]! - 1 : st.o[idx]!;
            if (idx > 1) st.o[2] = st.o[1]!;
            st.o[1] = st.o[0]!;
            st.o[0] = off;
          } else off = st.o[0]!;
        }
        // Bound the sequence before executing it. Literals sit at the end of
        // buf and output grows from the front, so a sequence is valid only if
        // its literals exist (`spl + ll` within buf) and its output stays
        // behind the unread literals (`oubt + ll + ml <= spl + ll`). Together
        // these keep every write below in bounds, so the block can never
        // regenerate past Block_Maximum_Size. Checking only after the loop let
        // a 40 KB block spin through 20000 × 64 KiB byte copies whose writes
        // all fell off the end (2.3 s) before failing, and let a literal
        // overrun read past buf and decode to wrong bytes without an error.
        // One branch, not two: either difference going negative sets the sign
        // bit (every term is far below 2^31). The two-branch `||` form cost
        // ~7% on dickens lvl3 in `bench:ab-decode`; this one measured at parity.
        if (((buf.length - spl - ll) | (spl - oubt - ml)) < 0) err(0);
        // Bulk copy only when large enough to amortize call overhead.
        if (ll >= 16) cpw(buf, oubt, spl, spl + ll);
        else {
          for (let i = 0; i < ll; ++i) {
            buf[oubt + i] = buf[spl + i]!;
          }
        }
        ((oubt += ll), (spl += ll));
        let stin = oubt - off;
        if (stin < 0) {
          let len = -stin;
          const bs = st.e + stin;
          // Match reaches before available window history.
          if (bs < 0) err(4);
          if (len > ml) len = ml;
          // History is a different array — bulk copy when worth it.
          if (len >= 16) buf.set(st.w.subarray(bs, bs + len), oubt);
          else {
            for (let i = 0; i < len; ++i) {
              buf[oubt + i] = st.w[bs + i]!;
            }
          }
          ((oubt += len), (ml -= len), (stin = 0));
        }
        // Overlapping matches (distance < length) must expand byte-by-byte
        // (RLE-style). Non-overlapping bulk-copy when large enough.
        if (ml) {
          if (off >= ml && ml >= 16) cpw(buf, oubt, stin, stin + ml);
          else {
            for (let i = 0; i < ml; ++i) {
              buf[oubt + i] = buf[stin + i]!;
            }
          }
        }
        oubt += ml;
      }
      if (oubt != spl) {
        const rem = buf.length - spl;
        if (rem >= 16) cpw(buf, oubt, spl, buf.length);
        else {
          for (let i = 0; i < rem; ++i) {
            buf[oubt + i] = buf[spl + i]!;
          }
        }
        oubt += rem;
      } else oubt = buf.length;
      // The per-sequence bound above guarantees `oubt <= spl` here, so the
      // block regenerated at most `buf.length` (Block_Maximum_Size) bytes.
      if (out) {
        need(out, st.y, oubt);
        st.y += oubt;
      } else buf = slc(buf, 0, oubt);
    } else if (out) {
      need(out, st.y, lss);
      st.y += lss;
      if (spl) {
        if (lss >= 16) cpw(buf, 0, spl, spl + lss);
        else {
          for (let i = 0; i < lss; ++i) {
            buf[i] = buf[spl + i]!;
          }
        }
      }
    } else buf = slc(buf, spl);
    st.b = ebt;
    return buf;
  }
  err(2);
};

// concat
const cct = (bufs: Array<Uint8Array>, ol: number): Uint8Array => {
  const first = bufs[0];
  if (bufs.length == 1) {
    if (first === undefined) err(0);
    return first;
  }
  const buf = new u8(ol);
  for (let i = 0, b = 0; i < bufs.length; ++i) {
    const chk = bufs[i];
    if (chk === undefined) err(0);
    buf.set(chk, b);
    b += chk.length;
  }
  return buf;
};

/**
 * Options for the decoding entry points.
 *
 * One bag for everything optional. There is no positional second argument on
 * one-shot decode: both the pre-sized output buffer and the checksum switch
 * live here, so the call shape is always `decompress(data)` or
 * `decompress(data, { … })`. Streaming uses the same bag minus `out` (it does
 * not own the output).
 */
export interface ZstdDecodeOptions {
  /**
   * Pre-sized output buffer for a **single data frame**. Must be large enough
   * for the full decompressed size when frame content size is known;
   * undersized buffers throw {@link ZstdError}. Supplying it rejects
   * multi-data-frame input, because every frame writes from offset 0 of its
   * own output and would overwrite the previous one. Skippable frames are
   * still accepted alongside `out` (they produce nothing to place).
   *
   * Omit it — the common case — and the function allocates, handling any
   * number of concatenated frames. Not used by {@link Decompress} or
   * {@link decompressStream}.
   */
  out?: Uint8Array | undefined;
  /**
   * Verify the frame content checksum when a frame carries one. **Default
   * `true`**. Leaving it out, passing `undefined`, or passing `{}` all verify.
   * Only an explicit `false` skips the hash.
   *
   * Opting out disables the hash only. Structural validation — bounds, offsets,
   * window size, FSE accuracy, symbol ranges, frame content size, truncation
   * before the digest — stays on. A positional boolean is deliberately not
   * accepted: you cannot skip verification without writing `checksum: false`.
   *
   * `| undefined` is explicit so `{ checksum: config.verify }` type-checks
   * under `exactOptionalPropertyTypes`. That forwarding case is the safe value.
   */
  checksum?: boolean | undefined;
  /**
   * Largest total output, in bytes, before decoding throws
   * {@link ZstdErrorCode.OutputTooLarge}. **Default 64 MiB**
   * (`64 * 1024 * 1024`). Pass `Infinity` to opt out explicitly.
   *
   * A zstd frame can regenerate 128 KiB from 4 input bytes, so without a cap a
   * 10 KB input decodes to over 300 MB. The cap covers every frame of the
   * input together, is checked before output buffers grow, and rejects a
   * declared content size above it before anything is allocated. Applies
   * equally to {@link decompress}, {@link Decompress} and `decompressStream`.
   * With `out`, the smaller of the two bounds wins.
   *
   * Must be `Infinity` or a non-negative safe integer; anything else (`NaN`,
   * negative, fractional, a string) throws `TypeError` at call time.
   */
  maxSize?: number | undefined;
}

/** `true` unless the caller explicitly said `false`. */
const wantsChecksum = (o?: ZstdDecodeOptions): boolean => o?.checksum !== false;

/** The validated output cap: default, `Infinity`, or a non-negative safe integer. */
const maxSizeOf = (o?: ZstdDecodeOptions): number => {
  const m: unknown = o?.maxSize;
  if (m === undefined) return MAX_SIZE;
  if (typeof m === "number" && (m === Infinity || (Number.isSafeInteger(m) && m >= 0))) return m;
  throw new TypeError("maxSize must be Infinity or a non-negative safe integer");
};

/**
 * Decompresses Zstandard data.
 *
 * **Supported frames:** standard zstd produced by encoders at levels
 * **−8 through 19** (the usual C zstd band). Level is encoder-only; this
 * function does not take a level. Ultra levels (20–22) decode and are tested,
 * but are outside the exhaustively tested band. Frames declaring a window above
 * 128 MiB (libzstd's default decoder limit) are rejected with
 * `WindowSizeTooLarge`.
 *
 * **Output is capped at 64 MiB by default** — see
 * {@link ZstdDecodeOptions.maxSize}. Exceeding it throws `OutputTooLarge`.
 *
 * Dictionary frames are not supported: a non-zero dictionary ID throws.
 *
 * **Content checksums are verified by default** when a frame carries one, and
 * only an explicit `{ checksum: false }` skips the hash — see
 * {@link ZstdDecodeOptions.checksum} for the opt-out. A frame without a digest
 * cannot be checked by anyone, and damaged input then decodes to different
 * bytes rather than erroring. Every frame this package encodes carries one.
 *
 * **Multi-frame input** (concatenated `.zst`, e.g. `cat a.zst b.zst`) is
 * decoded and concatenated when no `out` is supplied. It is rejected **only**
 * when `opts.out` is set, because every frame writes from offset 0 of its own
 * output and would overwrite the previous one. Skippable frames — the metadata
 * frames used by the seekable-zstd format and similar tooling — are always
 * accepted alongside `out`, since they produce no output to place.
 *
 * Prefer {@link Decompress} for push-based streaming, or
 * {@link decompressStream} when composing with `pipeThrough`.
 *
 * @param dat The input data
 * @param opts Optional bag: {@link ZstdDecodeOptions.out} for a pre-sized
 *             buffer, {@link ZstdDecodeOptions.checksum} to skip the hash,
 *             {@link ZstdDecodeOptions.maxSize} for the output cap. All
 *             default to the safe/common path (allocate, verify, 64 MiB).
 * @returns The decompressed data (the same `opts.out` when one was provided)
 */
export function decompress(dat: Uint8Array, opts?: ZstdDecodeOptions): Uint8Array {
  // Second argument is always an options bag. A bare TypedArray here is a
  // misuse — TypeScript rejects it, and untyped JS would otherwise treat it
  // as an empty bag, allocate a new buffer, and ignore the caller's.
  if (opts !== undefined && ArrayBuffer.isView(opts)) {
    throw new TypeError(
      "decompress(data, opts): pass { out } for a pre-sized buffer, not a bare TypedArray",
    );
  }
  const buf = opts?.out;
  const ck = wantsChecksum(opts);
  const lim = maxSizeOf(opts);
  // Establish the wide-read invariant once for the whole input. Every later
  // `dat.subarray(bt)` keeps it, since slicing from the front only moves
  // byteOffset forward and leaves the trailing slack intact.
  dat = pad(dat);
  const bufs: Array<Uint8Array> = [],
    // 1 when we allocate, 0 when the caller supplied a buffer.
    nb = buf ? 0 : 1;
  let bt = 0,
    ol = 0,
    // Output of the frames before this one, for the maxSize budget.
    tot = 0;
  // A wide read outside the padded slack means the bitstream walked far past
  // the block, which only corrupt input can do. Surface it as the documented
  // ZstdError instead of letting DataView's RangeError escape.
  try {
    for (; dat.length;) {
      // Budget left for this frame. A declared content size above it is
      // rejected before anything is allocated; at or below it, the size is
      // preallocated only if the input could actually regenerate it.
      const rm = lim - tot;
      const st = rzfh(dat, nb || buf, Math.min(rm, dat.length * MAX_RATIO));
      if (typeof st == "object") {
        if (st.u > rm) err(7);
        // Known FCS + caller buffer: fail closed if too small.
        if (!nb && st.u > 0) {
          if (buf === undefined) err(0);
          if (buf.length < st.u) err(0);
        }
        // This frame's output buffer, and whether it grows as blocks arrive.
        let ob: Uint8Array,
          gr = 0;
        if (nb) {
          if (st.u > 0 && st.w.length == st.u) {
            // Content size known: rzfh sized the frame buffer exactly.
            bufs.push((ob = st.w));
            ol += st.u;
            // In-place history base at absolute index 0 (same as caller-buf path).
            st.e = 0;
          } else {
            // No content size — every streaming producer, and `zstd` reading a
            // pipe. Decode into one growing buffer and use it as its own
            // history, exactly as the known-size path does, rather than
            // shifting a separate window and reallocating per block.
            st.w = ob = new u8(st.m > 0 ? st.m << 1 : 1 << 14);
            st.e = 0;
            gr = 1;
          }
        } else {
          if (buf === undefined) err(0);
          // Caller buffer is single-frame only; multi-frame would overwrite from y=0.
          if (bufs.length) err(0);
          bufs.push((ob = buf));
          st.e = 0;
        }
        // Hash per block, not once over the finished frame: the bytes are
        // still in cache the moment the block produces them, and a second
        // pass over a cold multi-megabyte buffer costs measurably more.
        const hs = st.c && ck ? new Xxh64() : null;
        for (; !st.l;) {
          // A block regenerates at most st.m bytes, so reserve that much.
          // Doubling stops at the budget: a block may still need `st.m` past
          // `st.y`, but never more, and output past the budget throws below.
          if (gr && st.y + st.m > ob.length) {
            const nx = new u8(Math.max(Math.min(ob.length << 1, rm), st.y + st.m));
            nx.set(ob.subarray(0, st.y));
            st.w = ob = nx;
          }
          const was = st.y;
          if (!rzb(dat, st, ob)) err(5);
          if (st.y > rm) err(7);
          if (hs) hs.update(ob.subarray(was, st.y));
          st.e = st.y;
        }
        if (gr) {
          // Trim the doubling slack, unless the last block happened to fill it.
          bufs.push(st.y == ob.length ? ob : slc(ob, 0, st.y));
          ol += st.y;
        }
        // Verify frame content size when the header advertised one.
        if (st.u > 0 && st.y != st.u) err(0);
        tot += st.y;
        // Content checksum (when flagged): 4 bytes holding the low half of
        // XXH64 over this frame's output. Without this a damaged frame
        // decodes to different bytes and returns successfully.
        // A frame cut off before its checksum is truncated input, not a
        // mismatch — `b4` would read the missing bytes as zero and report the
        // wrong failure. This is **structural**, so it stays checked with
        // verification off: `checksum: false` turns off the hash, not the
        // decoder's judgement.
        if (st.c && st.b + 4 > dat.length) err(5);
        if (hs && hs.digest32() !== b4(dat, st.b)) err(6);
        bt = st.b + st.c * 4;
      } else bt = st;
      dat = dat.subarray(bt);
    }
  } catch (e) {
    if (e instanceof RangeError) err(0);
    throw e;
  }
  return cct(bufs, ol);
}

/**
 * Callback to handle data in Zstandard streams
 * @param data The data that was (de)compressed
 * @param final Whether this is the last chunk in the stream
 */
export type ZstdStreamHandler = (data: Uint8Array, final?: boolean) => unknown;

/**
 * Decompressor for Zstandard streamed data.
 * Same support as {@link decompress}: frames from encoder levels **−8…19**,
 * and the same 64 MiB default output cap ({@link ZstdDecodeOptions.maxSize}),
 * counted across everything pushed.
 *
 * ```ts
 * const dec = new Decompress((chunk) => sink(chunk));
 * dec.push(frame);
 * dec.push(new Uint8Array(0), true);
 * ```
 *
 * Prefer {@link decompressStream} when composing with `pipeThrough`.
 */
export class Decompress {
  private s: DZstdState | number = 0;
  private c: Array<Uint8Array> = [];
  private l = 0;
  private z = 0;
  /** Bytes produced for the current frame (for FCS verification). */
  private p = 0;
  /** Whether to verify a frame's content checksum when it carries one. */
  private readonly v: boolean;
  /** Output cap ({@link ZstdDecodeOptions.maxSize}) across the whole stream. */
  private readonly x: number;
  /** Bytes emitted so far, across every frame. */
  private t = 0;
  /** Running digest for the current frame, or null when there is nothing to check. */
  private hs: Xxh64 | null = null;
  /**
   * The frame's 4 checksum bytes, which are skipped rather than decoded and so
   * may straddle any number of pushes.
   */
  private readonly ck = new u8(4);
  private ckn = 0;
  /**
   * Handler called whenever data is decompressed
   */
  ondata: ZstdStreamHandler;
  /**
   * Creates a Zstandard decompressor
   * @param ondata The handler for stream data
   * @param opts Decode options; see {@link ZstdDecodeOptions}. Verification is
   *             on unless an explicit `{ checksum: false }` says otherwise.
   */
  constructor(
    ondata?: ZstdStreamHandler,
    // Streaming does not own the output — `out` is one-shot only.
    opts?: Omit<ZstdDecodeOptions, "out">,
  ) {
    this.ondata = ondata ?? (() => {});
    this.v = wantsChecksum(opts);
    this.x = maxSizeOf(opts);
  }

  /**
   * Pushes data to be decompressed
   * @param chunk The chunk of data to push
   * @param final Whether or not this is the last chunk in the stream
   */
  push(chunk: Uint8Array, final?: boolean): void {
    // Same wide-read invariant as one-shot decompress. Buffered remainders are
    // subarrays of an already-padded chunk, or come back through `cct`, which
    // allocates — either way this only copies a chunk that ends flush against
    // its own ArrayBuffer.
    chunk = pad(chunk);
    if (typeof this.s == "number") {
      const sub = Math.min(chunk.length, this.s);
      // These skipped bytes are the checksum when a digest is pending. They
      // can straddle pushes, so collect them before dropping them.
      if (this.hs) {
        for (let i = 0; i < sub && this.ckn < 4; i++) {
          this.ck[this.ckn++] = at(chunk, i);
        }
        if (this.ckn == 4) {
          const want = b4(this.ck, 0);
          const got = this.hs.digest32();
          ((this.hs = null), (this.ckn = 0));
          if (got !== want) err(6);
        }
      }
      chunk = chunk.subarray(sub);
      this.s -= sub;
    }
    const sl = chunk.length;
    const ncs = sl + this.l;
    if (!this.s) {
      if (final) {
        if (!ncs) {
          this.ondata(new u8(0), true);
          return;
        }
        // min for frame + one block
        if (ncs < 5) err(5);
      } else if (ncs < 18) {
        this.c.push(chunk);
        this.l = ncs;
        return;
      }
      if (this.l) {
        this.c.push(chunk);
        // cct allocates an exact-sized buffer, so re-establish the slack.
        chunk = pad(cct(this.c, ncs));
        this.c = [];
        this.l = 0;
      }
      if (typeof (this.s = rzfh(chunk)) == "number") {
        this.push(chunk, final);
        return;
      }
      this.p = 0;
      // A declared content size past the remaining budget fails before any
      // block is decoded.
      if (this.s.u > this.x - this.t) err(7);
      // One digest per frame, started only when that frame carries a checksum
      // and the caller did not opt out.
      this.hs = this.s.c && this.v ? new Xxh64() : null;
    }
    if (typeof this.s != "number") {
      const st = this.s;
      if (ncs < (this.z || 3)) {
        if (final) err(5);
        this.c.push(chunk);
        this.l = ncs;
        return;
      }
      if (this.l) {
        this.c.push(chunk);
        // cct allocates an exact-sized buffer, so re-establish the slack.
        chunk = pad(cct(this.c, ncs));
        this.c = [];
        this.l = 0;
      }
      if (
        !this.z &&
        ncs <
          (this.z =
            at(chunk, st.b) & 2
              ? 4
              : 3 +
                ((at(chunk, st.b) >> 3) | (at(chunk, st.b + 1) << 5) | (at(chunk, st.b + 2) << 13)))
      ) {
        if (final) err(5);
        this.c.push(chunk);
        this.l = ncs;
        return;
      }
      this.z = 0;
      // Same corrupt-input guard as one-shot decompress.
      try {
        for (;;) {
          const blk = rzb(chunk, st);
          if (!blk) {
            if (final) err(5);
            const adc = chunk.subarray(st.b);
            st.b = 0;
            (this.c.push(adc), (this.l += adc.length));
            return;
          }
          // Throw before emitting, so the sink never sees output past the cap.
          if (blk.length > this.x - this.t) err(7);
          this.t += blk.length;
          this.p += blk.length;
          if (this.hs) this.hs.update(blk);
          this.ondata(blk, false);
          // Grow toward `window + 8 blocks` while the frame is still
          // smaller than its declared window; past that, compact instead,
          // keeping the last `g` bytes as history. Compacting per block
          // would be O(window) each time, which is what made level-19
          // streaming decode 0.22x of one-shot.
          const cap = st.g + st.m * 8;
          if (st.e + blk.length > st.w.length) {
            if (st.e + blk.length <= cap) {
              const nw = new u8(Math.min(cap, Math.max(st.w.length * 2, st.e + blk.length)));
              nw.set(st.w.subarray(0, st.e));
              st.w = nw;
            } else {
              cpw(st.w, 0, st.e - st.g, st.e);
              st.e = st.g;
            }
          }
          st.w.set(blk, st.e);
          st.e += blk.length;
          if (st.l) {
            if (st.u > 0 && this.p != st.u) err(0);
            this.p = 0;
            const rest = chunk.subarray(st.b);
            // Content checksum (when flagged): the next 4 input bytes.
            // Validated in the `typeof this.s == "number"` branch when
            // `this.hs` is set; merely consumed when verification is off.
            this.s = st.c * 4;
            this.push(rest, final);
            return;
          }
        }
      } catch (e) {
        if (e instanceof RangeError) err(0);
        throw e;
      }
    } else if (final) err(5);
  }
}
