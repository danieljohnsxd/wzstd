/**
 * Shared payloads used by compress/cross tests and competitive benches.
 * Keep sizes/names aligned with product claims so perf tracks what we validate.
 */

const encoder = new TextEncoder();

export type Payload = { name: string; data: Uint8Array };

export function bytes(s: string): Uint8Array {
  return encoder.encode(s);
}

export function jsonLines(n: number): string {
  const lines: Array<string> = [];
  for (let i = 0; i < n; i++) {
    lines.push(
      JSON.stringify({
        id: i,
        user: `user_${i % 20}`,
        action: ["click", "view", "scroll", "type"][i % 4],
        ts: 1_700_000_000 + i * 60,
      }),
    );
  }
  return lines.join("\n");
}

export function binaryRamp(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = i & 0xff;
  return out;
}

export function mixedCorpus(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let i = 0;
  let seq = 0;
  while (i < n) {
    const phrase = encoder.encode(`token-${seq % 17}-payload `);
    const unique = encoder.encode(`U${seq.toString(16)}:${(seq * 31) & 0xff}|`);
    const chunk = seq % 3 === 0 ? unique : phrase;
    const take = Math.min(chunk.length, n - i);
    out.set(chunk.subarray(0, take), i);
    i += take;
    seq++;
  }
  return out;
}

export function repFriendly(n: number): Uint8Array {
  const a = encoder.encode("ALPHA_BLOCK_");
  const b = encoder.encode("BETA_SEGMENT_");
  const c = encoder.encode("GAMMA_CHUNK_");
  const out = new Uint8Array(n);
  let i = 0;
  let k = 0;
  while (i < n) {
    const phrase = k % 3 === 0 ? a : k % 3 === 1 ? b : c;
    const pick = k % 5 === 0 ? phrase : k % 5 === 1 ? a : phrase;
    const take = Math.min(pick.length, n - i);
    out.set(pick.subarray(0, take), i);
    i += take;
    k++;
  }
  return out;
}

export function lowEntropy(n: number): Uint8Array {
  const alphabet = encoder.encode("etaoinshrdlu ");
  const out = new Uint8Array(n);
  let x = 123456789;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = alphabet[x % alphabet.length] ?? 0;
  }
  return out;
}

/** Zipf-ish a–d with sparse copies — Strong Huffman path in tests. */
export function huffmanLiteralsPayload(len = 400): Uint8Array {
  const out = new Uint8Array(len);
  let s = 7;
  for (let i = 0; i < out.length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const r = s % 100;
    out[i] = r < 50 ? 0x61 : r < 75 ? 0x62 : r < 90 ? 0x63 : 0x64;
  }
  for (let i = 40; i + 8 < out.length; i += 40) {
    out.set(out.subarray(i - 20, i - 12), i);
  }
  return out;
}

/**
 * JSON log lines where every `nonAsciiEvery`-th record carries a non-ASCII
 * word. Any byte above 128 pushes the Huffman weight header past what a direct
 * 4-bit header can carry, so these cover the FSE-compressed weight path — an
 * ASCII-only corpus never reaches it.
 */
export function multilingualLines(lines: number, nonAsciiEvery: number): string {
  const accented = [
    "café",
    "naïve",
    "résumé",
    "über",
    "Ω",
    "日本語",
    "中文",
    "emoji→🙂",
    "Straße",
    "Ærø",
  ];
  const plain = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
  const out: Array<string> = [];
  let x = 42;
  for (let i = 0; i < lines; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    const word =
      i % nonAsciiEvery === 0
        ? (accented[x % accented.length] ?? "café")
        : (plain[x % plain.length] ?? "alpha");
    out.push(`{"id":${i},"user":"user_${i % 20}","msg":"${word}","ts":${1_700_000_000 + i * 60}}`);
  }
  return out.join("\n");
}

/** Byte-structured data spanning the full range, with a skewed distribution. */
export function skewedBinary(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = 2_463_534_242;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    const r = x % 100;
    out[i] = r < 70 ? 0x20 + (x % 60) : r < 95 ? x % 16 : 0xc0 + ((x >>> 8) % 0x30);
  }
  return out;
}

/**
 * Incompressible-looking filler. Must not be `f(i)` — a linear function of the
 * index has a flat histogram (entropy ~8) but is still match-compressible, which
 * made "random-*" and far-echo benches lie about tier gaps.
 */
export function randomBytes(n: number, seed = 17): Uint8Array {
  const data = new Uint8Array(n);
  // xorshift32 — state advances; output is not a function of position alone.
  let x = seed >>> 0 || 1;
  for (let i = 0; i < data.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    data[i] = x & 0xff;
  }
  return data;
}

/**
 * Digit-heavy GeoJSONL-like lines: shared schema + coordinate runs that often
 * repeat across the file (the shape where a larger window / long-hash helps).
 */
export function geojsonlLike(lines: number, seed = 9): Uint8Array {
  const parts: Array<string> = [];
  let x = seed >>> 0;
  const next = (): number => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x;
  };
  // A small set of "rings" reused far apart → multi-MiB backrefs on large n.
  const rings: Array<string> = [];
  for (let r = 0; r < 48; r++) {
    const coords: Array<string> = [];
    const baseLon = -120 + (next() % 40) + (next() % 1000) / 1000;
    const baseLat = 30 + (next() % 20) + (next() % 1000) / 1000;
    for (let k = 0; k < 12; k++) {
      coords.push(
        `[${(baseLon + (next() % 100) / 1e4).toFixed(6)},${(baseLat + (next() % 100) / 1e4).toFixed(6)}]`,
      );
    }
    rings.push(coords.join(","));
  }
  for (let i = 0; i < lines; i++) {
    const ring = rings[i % rings.length] ?? "";
    const id = 1000 + (i % 5000);
    parts.push(
      `{"type":"Feature","id":${id},"props":{"name":"unit_${i % 200}","code":"${(i % 50).toString(16)}"},"geometry":{"type":"Polygon","coordinates":[[${ring}]]}}`,
    );
  }
  return bytes(parts.join("\n"));
}

/**
 * Source-ish text: repeated keywords + unique identifiers (code / config dump).
 */
export function sourceLike(n: number, seed = 3): Uint8Array {
  const keywords = [
    "function ",
    "const ",
    "return ",
    "import { ",
    "export type ",
    "if (",
    ") {\n\t",
    "}\n",
    "await ",
    "async ",
    "interface ",
    " extends ",
  ];
  const out = new Uint8Array(n);
  let i = 0;
  let seq = seed;
  while (i < n) {
    seq = (Math.imul(seq, 1103515245) + 12345) >>> 0;
    let chunk: Uint8Array;
    if (seq % 5 === 0) {
      chunk = encoder.encode(`id_${(seq % 10_000).toString(16)}_${seq % 97}\n`);
    } else {
      const kw = keywords[seq % keywords.length] ?? "const ";
      chunk = encoder.encode(kw);
    }
    const take = Math.min(chunk.length, n - i);
    out.set(chunk.subarray(0, take), i);
    i += take;
  }
  return out;
}

/**
 * Mostly unique noise with periodic full copies of a 64 KiB template from
 * far back — stresses multi-MiB window without being pure low-entropy.
 */
export function longRangeSparse(n: number, period = 512 * 1024): Uint8Array {
  const out = new Uint8Array(n);
  const template = randomBytes(64 * 1024, 99);
  let i = 0;
  let seq = 0;
  while (i < n) {
    if (seq > 0 && seq % 4 === 0 && i + template.length <= n) {
      // Plant a far copy: reuse template at offsets that need >1 MiB history
      // once the file is large enough.
      out.set(template, i);
      i += template.length;
    } else {
      const chunk = Math.min(4096, n - i);
      out.set(randomBytes(chunk, 1000 + seq), i);
      i += chunk;
    }
    seq++;
    // Also force a full-period echo when past `period`.
    if (i >= period && i + template.length <= n && seq % 7 === 0) {
      const src = i - period;
      if (src >= 0) {
        out.set(out.subarray(src, src + template.length), i);
        i += template.length;
      }
    }
  }
  return out;
}

/**
 * HTML-ish markup with repeated tags/classes and unique body text.
 */
export function htmlLike(n: number): Uint8Array {
  const open = encoder.encode('<div class="row item card">');
  const mid = encoder.encode("<span>");
  const close = encoder.encode("</span></div>\n");
  const out = new Uint8Array(n);
  let i = 0;
  let seq = 0;
  while (i < n) {
    for (const part of [open, mid]) {
      const take = Math.min(part.length, n - i);
      out.set(part.subarray(0, take), i);
      i += take;
      if (i >= n) return out;
    }
    const body = encoder.encode(`text-${seq % 300}-${(seq * 17) % 9999} `);
    const takeB = Math.min(body.length, n - i);
    out.set(body.subarray(0, takeB), i);
    i += takeB;
    const takeC = Math.min(close.length, n - i);
    out.set(close.subarray(0, takeC), i);
    i += takeC;
    seq++;
  }
  return out;
}

/**
 * NDJSON / log-style lines: identical key set every record, unique values.
 * Schema tokens dominate; long-hash and Huffman both pay. Strong vs Fast gap
 * is Huffman; Ultra vs Strong gap is long-range key reuse across the file.
 */
export function ndjsonSchema(n: number, seed = 11): Uint8Array {
  const out = new Uint8Array(n);
  let i = 0;
  let seq = seed >>> 0;
  const next = (): number => {
    seq = (Math.imul(seq, 1664525) + 1013904223) >>> 0;
    return seq;
  };
  while (i < n) {
    const user = next() % 500;
    const path = ["/", "/api", "/v1/users", "/health", "/metrics"][next() % 5];
    const msg = `evt_${next() % 10_000}`;
    const line = encoder.encode(
      `{"ts":${1_700_000_000 + (next() % 86_400)},"level":"${["info", "warn", "error", "debug"][next() % 4]}","user_id":${user},"request_id":"${(next() >>> 0).toString(16)}","path":"${path}","status":${[200, 201, 400, 404, 500][next() % 5]},"latency_ms":${next() % 2000},"message":"${msg}","meta":{"region":"${["us-east", "eu-west", "ap-south"][next() % 3]}","shard":${next() % 64}}}\n`,
    );
    const take = Math.min(line.length, n - i);
    out.set(line.subarray(0, take), i);
    i += take;
  }
  return out;
}

/**
 * CSV export: fixed header + rows of mostly-repeating column tokens with a
 * few unique ids. Compresses well; Strong/Huffman should lead Fast clearly.
 */
export function csvExport(n: number, seed = 5): Uint8Array {
  const header = "id,email,country,plan,status,created_at,last_login,bytes_used,region,tier\n";
  const out = new Uint8Array(n);
  const head = encoder.encode(header);
  out.set(head.subarray(0, Math.min(head.length, n)), 0);
  let i = Math.min(head.length, n);
  let seq = seed >>> 0;
  const next = (): number => {
    seq = (Math.imul(seq, 1103515245) + 12345) >>> 0;
    return seq;
  };
  const countries = ["US", "DE", "GB", "JP", "BR", "IN", "CA", "AU"];
  const plans = ["free", "pro", "team", "enterprise"];
  const statuses = ["active", "paused", "churned", "trial"];
  while (i < n) {
    const id = next() % 5_000_000;
    const row = encoder.encode(
      `${id},user${id % 50_000}@ex.com,${countries[next() % countries.length]},${plans[next() % plans.length]},${statuses[next() % statuses.length]},2024-${String(1 + (next() % 12)).padStart(2, "0")}-${String(1 + (next() % 28)).padStart(2, "0")},2025-0${1 + (next() % 9)}-${String(1 + (next() % 28)).padStart(2, "0")},${next() % 10_000_000},${["iad", "cdg", "nrt", "gru"][next() % 4]},${1 + (next() % 5)}\n`,
    );
    const take = Math.min(row.length, n - i);
    out.set(row.subarray(0, take), i);
    i += take;
  }
  return out;
}

/**
 * Far-echo: high-entropy filler with exact copies of a 48 KiB block planted
 * every `distance` bytes. Ultra's 8 MiB window + long-hash should beat Strong's
 * 1 MiB window once `distance` > 1 MiB; Fast/Strong both see the local filler.
 */
export function farEcho(n: number, distance = 1.5 * 1024 * 1024, block = 48 * 1024): Uint8Array {
  const out = new Uint8Array(n);
  const motif = randomBytes(block, 777);
  // Fill with unique-ish noise first.
  out.set(randomBytes(n, 333));
  // Plant the motif at 0, then every `distance` bytes.
  for (let at = 0; at + block <= n; at += distance) {
    out.set(motif, at);
  }
  // And one extra cluster of near-copies after 2 MiB for long-hash without
  // needing the full window (catches lim4 path even on smaller files).
  if (n > 2 * 1024 * 1024 + block) {
    out.set(motif, 2 * 1024 * 1024);
    out.set(motif, 2 * 1024 * 1024 + block + 17);
  }
  return out;
}

/**
 * English-ish prose with a limited vocabulary — order-0 entropy is low enough
 * that Huffman (Strong) pays hard vs Fast's raw literals, without being zeros.
 */
export function proseLike(n: number, seed = 19): Uint8Array {
  const words = [
    "the",
    "and",
    "for",
    "that",
    "with",
    "this",
    "from",
    "have",
    "will",
    "data",
    "value",
    "object",
    "record",
    "field",
    "table",
    "index",
    "query",
    "result",
    "server",
    "client",
    "request",
    "response",
    "error",
    "status",
    "message",
    "user",
    "account",
    "session",
    "token",
    "cache",
  ];
  const out = new Uint8Array(n);
  let i = 0;
  let seq = seed >>> 0;
  while (i < n) {
    seq = (Math.imul(seq, 1664525) + 1013904223) >>> 0;
    const w = words[seq % words.length] ?? "the";
    const punct = seq % 17 === 0 ? ".\n" : seq % 5 === 0 ? ", " : " ";
    const chunk = encoder.encode(w + punct);
    const take = Math.min(chunk.length, n - i);
    out.set(chunk.subarray(0, take), i);
    i += take;
  }
  return out;
}

/**
 * Full bench corpus: compress_test CASES + zrip_cross CORPUS + extra
 * encode-focused cases + mixed size ladder + larger workload profiles.
 */
export function benchPayloads(): Array<Payload> {
  const out: Array<Payload> = [
    // --- zrip_cross_test CORPUS (non-empty) ---
    // Floor-size fixture: correctness / extremes (does not error). MB/s on
    // 2 B is a bad statistic — open whether it should vote in bench MEDIAN.
    { name: "tiny-ok", data: bytes("Ok") },
    {
      name: "lorem-fixture",
      data: bytes(
        "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam nec sem urna. Morbi mollis, massa a convallis iaculis, mauris neque.",
      ),
    },
    // --- compress_test CASES ---
    {
      name: "lorem-short",
      data: bytes("Lorem ipsum dolor sit amet, consectetur adipiscing elit."),
    },
    { name: "repeat-ascii-24k", data: bytes("hello world ".repeat(2_000)) },
    { name: "json-lines-200", data: bytes(jsonLines(200)) },
    { name: "json-lines-500", data: bytes(jsonLines(500)) },
    { name: "zeros-100k", data: new Uint8Array(100_000) },
    { name: "binary-ramp-20k", data: binaryRamp(20_000) },
    { name: "binary-ramp-50k", data: binaryRamp(50_000) },
    { name: "short-repeat", data: bytes("abcd".repeat(500)) },
    { name: "size-255", data: new Uint8Array(255).fill(7) },
    { name: "size-256", data: new Uint8Array(256).fill(8) },
    { name: "size-4096", data: bytes("xy".repeat(2048)) },
    { name: "over-block", data: bytes("block-edge-".repeat(15_000)) },
    { name: "mixed-40k", data: mixedCorpus(40_000) },
    { name: "rep-friendly-30k", data: repFriendly(30_000) },
    // --- extra cases exercised in compress_test ---
    { name: "shrink-phrase", data: bytes("compress-me-please ".repeat(400)) },
    { name: "random-8k", data: randomBytes(8_000) },
    { name: "zeros-50k", data: new Uint8Array(50_000) },
    { name: "mixed-200k", data: mixedCorpus(200_000) },
    { name: "huffman-lit-400", data: huffmanLiteralsPayload(400) },
    // --- scale ladder (same pattern, different sizes) ---
    { name: "mixed-1k", data: mixedCorpus(1_024) },
    { name: "mixed-4k", data: mixedCorpus(4_096) },
    { name: "mixed-16k", data: mixedCorpus(16_384) },
    { name: "mixed-64k", data: mixedCorpus(65_536) },
    { name: "mixed-256k", data: mixedCorpus(262_144) },
    { name: "mixed-1m", data: mixedCorpus(1024 * 1024) },
    { name: "mixed-2m", data: mixedCorpus(2 * 1024 * 1024) },
    { name: "mixed-4m", data: mixedCorpus(4 * 1024 * 1024) },
    // --- non-ASCII / full byte range (FSE-compressed Huffman weights) ---
    { name: "utf8-heavy-2k", data: bytes(multilingualLines(2_000, 2)) },
    { name: "utf8-light-2k", data: bytes(multilingualLines(2_000, 50)) },
    { name: "utf8-one-char", data: bytes(multilingualLines(2_000, 1 << 30)) },
    // Larger UTF-8: same generators, enough volume that long-range matches matter.
    { name: "utf8-heavy-20k", data: bytes(multilingualLines(20_000, 2)) },
    { name: "utf8-heavy-50k", data: bytes(multilingualLines(50_000, 2)) },
    { name: "utf8-light-50k", data: bytes(multilingualLines(50_000, 50)) },
    { name: "utf8-heavy-100k", data: bytes(multilingualLines(100_000, 2)) },
    { name: "utf8-light-100k", data: bytes(multilingualLines(100_000, 50)) },
    { name: "skewed-binary-60k", data: skewedBinary(60_000) },
    { name: "skewed-binary-256k", data: skewedBinary(256 * 1024) },
    { name: "skewed-binary-1m", data: skewedBinary(1024 * 1024) },
    { name: "skewed-binary-2m", data: skewedBinary(2 * 1024 * 1024) },
    // --- large / cross-test ---
    { name: "low-entropy-50k", data: lowEntropy(50_000) },
    { name: "low-entropy-256k", data: lowEntropy(256 * 1024) },
    { name: "low-entropy-1m", data: lowEntropy(1024 * 1024) },
    { name: "low-entropy-2m", data: lowEntropy(2 * 1024 * 1024) },
    { name: "random-512k", data: randomBytes(512 * 1024) },
    { name: "random-2m", data: randomBytes(2 * 1024 * 1024) },
    { name: "million-zeros", data: new Uint8Array(1_000_000) },
    { name: "repeat-512k", data: bytes("hello world ".repeat(40_000)) },
    { name: "repeat-2m", data: bytes("hello world ".repeat(170_000)) },
    // --- workload profiles (diversity for Ultra / window levers) ---
    { name: "geojsonl-2k", data: geojsonlLike(2_000) },
    { name: "geojsonl-10k", data: geojsonlLike(10_000) },
    { name: "geojsonl-40k", data: geojsonlLike(40_000) },
    { name: "json-lines-5k", data: bytes(jsonLines(5_000)) },
    { name: "json-lines-20k", data: bytes(jsonLines(20_000)) },
    { name: "source-256k", data: sourceLike(256 * 1024) },
    { name: "source-1m", data: sourceLike(1024 * 1024) },
    { name: "source-2m", data: sourceLike(2 * 1024 * 1024) },
    { name: "html-256k", data: htmlLike(256 * 1024) },
    { name: "html-1m", data: htmlLike(1024 * 1024) },
    { name: "html-2m", data: htmlLike(2 * 1024 * 1024) },
    // Long-range: needs multi-MiB history to pay off.
    { name: "longrange-1m", data: longRangeSparse(1024 * 1024) },
    { name: "longrange-2m", data: longRangeSparse(2 * 1024 * 1024) },
    { name: "longrange-4m", data: longRangeSparse(4 * 1024 * 1024) },
    { name: "rep-friendly-256k", data: repFriendly(256 * 1024) },
    { name: "rep-friendly-1m", data: repFriendly(1024 * 1024) },
    // --- tier-separating profiles (widen distribution) ---
    // NDJSON schema reuse: Ultra long-hash + Strong Huffman both pay.
    { name: "ndjson-512k", data: ndjsonSchema(512 * 1024) },
    { name: "ndjson-2m", data: ndjsonSchema(2 * 1024 * 1024) },
    { name: "ndjson-4m", data: ndjsonSchema(4 * 1024 * 1024) },
    // CSV exports: Strong Huffman >> Fast raw on column tokens.
    { name: "csv-512k", data: csvExport(512 * 1024) },
    { name: "csv-2m", data: csvExport(2 * 1024 * 1024) },
    // Far echoes past 1 MiB: Ultra window+long-hash vs Strong 1 MiB ceiling.
    { name: "farecho-2m", data: farEcho(2 * 1024 * 1024) },
    { name: "farecho-4m", data: farEcho(4 * 1024 * 1024) },
    // Prose vocabulary: Huffman path without pure low-entropy alphabet.
    { name: "prose-256k", data: proseLike(256 * 1024) },
    { name: "prose-1m", data: proseLike(1024 * 1024) },
    { name: "prose-2m", data: proseLike(2 * 1024 * 1024) },
    // Larger GIS / JSONL so structured multi-MB mass is not only "mixed-N".
    { name: "geojsonl-100k", data: geojsonlLike(100_000) },
    { name: "json-lines-50k", data: bytes(jsonLines(50_000)) },
  ];
  return out;
}
