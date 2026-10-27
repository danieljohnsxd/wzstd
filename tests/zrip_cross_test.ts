/**
 * Cross-validation for the product decode claim: **encoder levels −8…19**.
 *
 * Reference encoders:
 *  - [zrip](https://github.com/paddor/zrip) (`@paddor/zrip` WASM) — levels −8…4
 *  - host C `zstd` CLI — positive levels 1…19
 *
 * Patterns:
 *  - zrip compress → wzstd decompress
 *  - host `zstd` CLI compress → wzstd decompress
 *  - wzstd and zrip agree on decode of the same frame
 *
 * Ultra 20–22 are out of this file's level grid (covered in large_window_test).
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { compress as zripCompress, decompress as zripDecompress } from "@paddor/zrip";
import { decompress as wzstdDecompress } from "../dist/index.js";
import { ensureZrip } from "./helpers/zrip_init.ts";
import { hasZstdCli, zstdCompress } from "./helpers/zstd_cli.ts";

const encoder = new TextEncoder();

function bytes(s: string): Uint8Array {
  return encoder.encode(s);
}

function assertBytesEqual(a: Uint8Array, b: Uint8Array, msg?: string): void {
  assert.equal(a.length, b.length, msg ?? "length mismatch");
  assert.deepEqual(a, b, msg);
}

const CORPUS: Array<{ name: string; data: Uint8Array }> = [
  { name: "empty", data: new Uint8Array(0) },
  { name: "tiny", data: bytes("Ok") },
  {
    name: "lorem",
    data: bytes(
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam nec sem urna. Morbi mollis, massa a convallis iaculis, mauris neque.",
    ),
  },
  { name: "repeat-ascii", data: bytes("hello world ".repeat(2_000)) },
  { name: "json-lines", data: bytes(jsonLines(500)) },
  { name: "binary-ramp", data: binaryRamp(50_000) },
  { name: "million-zeros", data: new Uint8Array(1_000_000) },
];

// zrip encode levels (−8…4): covers the negative band + low positive.
const ZRIP_LEVELS = [-8, -7, -6, -5, -4, -3, -2, -1, 1, 2, 3, 4] as const;

// C zstd encode levels 1…19 (exhaustive interop band; ultra in large_window_test).
const ZSTD_CLI_LEVELS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
] as const;

/**
 * The C implementation's own negative band (`--fast=N`). zrip covers −8…4 too,
 * but it is a different encoder: the C fast tiers emit their own mix of raw and
 * RLE literal blocks and long matches, so they exercise decoder branches that
 * zrip's output does not necessarily reach.
 */
const ZSTD_CLI_FAST_LEVELS = [-1, -2, -3, -4, -5, -6, -7, -8] as const;

function jsonLines(n: number): string {
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

function binaryRamp(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = i & 0xff;
  return out;
}

before(async () => {
  await ensureZrip();
});

describe("zrip compress → wzstd decompress", () => {
  for (const level of ZRIP_LEVELS) {
    for (const { name, data } of CORPUS) {
      // Empty input compress edge cases vary by encoder; skip empty for encode.
      if (data.length === 0) continue;
      test(`L${level} ${name} (${data.length} B)`, () => {
        const frame = zripCompress(data, level);
        const out = wzstdDecompress(frame);
        assertBytesEqual(out, data, `wzstd failed to decode zrip L${level} frame for ${name}`);
      });
    }
  }
});

describe("zrip and wzstd agree on decode", () => {
  for (const level of ZRIP_LEVELS) {
    test(`L${level} repeat-ascii both decoders match`, () => {
      const data = bytes("cross-check agreement ".repeat(400));
      const frame = zripCompress(data, level);
      const fromZrip = zripDecompress(frame);
      const fromWzstd = wzstdDecompress(frame);
      assertBytesEqual(fromZrip, data);
      assertBytesEqual(fromWzstd, data);
      assertBytesEqual(fromZrip, fromWzstd);
    });
  }
});

describe("host zstd CLI compress → wzstd decompress", () => {
  const available = hasZstdCli();
  for (const level of ZSTD_CLI_LEVELS) {
    for (const { name, data } of CORPUS) {
      if (data.length === 0) continue;
      test(`zstd -${level} ${name}`, { skip: !available }, () => {
        const frame = zstdCompress(data, level);
        const out = wzstdDecompress(frame);
        assertBytesEqual(out, data, `wzstd failed to decode C zstd -${level} for ${name}`);
      });
    }
  }
});

describe("host zstd CLI negative levels → wzstd decompress", () => {
  const available = hasZstdCli();
  for (const level of ZSTD_CLI_FAST_LEVELS) {
    for (const { name, data } of CORPUS) {
      if (data.length === 0) continue;
      test(`zstd --fast=${-level} ${name}`, { skip: !available }, () => {
        const frame = zstdCompress(data, level);
        assertBytesEqual(
          wzstdDecompress(frame),
          data,
          `wzstd failed to decode C zstd --fast=${-level} for ${name}`,
        );
      });
    }
  }
});

describe("host zstd CLI compress → both zrip and wzstd", () => {
  const available = hasZstdCli();
  test(
    "zstd -1 frame: zrip decode === wzstd decode",
    {
      skip: !available,
    },
    () => {
      const data = bytes("cli bridge ".repeat(300));
      const frame = zstdCompress(data, 1);
      assertBytesEqual(zripDecompress(frame), data);
      assertBytesEqual(wzstdDecompress(frame), data);
    },
  );
});

describe("hand fixtures still match zrip", () => {
  // Same Ok / Lorem frames as simple_cases_test.ts
  const OK = new Uint8Array([
    0x28, 0xb5, 0x2f, 0xfd, 0x24, 0x02, 0x11, 0x00, 0x00, 0x4f, 0x6b, 0x64, 0x50, 0xa9, 0x5a,
  ]);
  const LOREM = new Uint8Array([
    0x28, 0xb5, 0x2f, 0xfd, 0x24, 0x84, 0xfd, 0x02, 0x00, 0x92, 0x07, 0x15, 0x13, 0x90, 0x07, 0x0c,
    0xc9, 0x6e, 0xbb, 0x5b, 0x93, 0x4c, 0x3e, 0x07, 0xb5, 0xe6, 0x59, 0xf1, 0x89, 0x6b, 0x52, 0xe9,
    0x83, 0xda, 0x40, 0xf8, 0x2d, 0xed, 0x1e, 0xa9, 0xcb, 0x01, 0x73, 0x2e, 0x97, 0x5d, 0xb9, 0x13,
    0x5b, 0x66, 0x79, 0xaf, 0x81, 0x66, 0xe0, 0x43, 0x50, 0xfb, 0x47, 0xfb, 0x21, 0xfc, 0x89, 0x59,
    0x0b, 0x3e, 0xb8, 0x8c, 0x4e, 0xc0, 0x9a, 0xad, 0x42, 0x15, 0x72, 0x6d, 0x26, 0x1e, 0x5a, 0xcc,
    0x39, 0xc1, 0x74, 0x72, 0xae, 0xbd, 0xa6, 0x65, 0xf1, 0xeb, 0x2d, 0xd4, 0x8f, 0x34, 0x01, 0x01,
    0x02, 0x00, 0x3e, 0x53, 0x53, 0xb3, 0xe6, 0x19, 0xb0, 0x58, 0x5b, 0x26,
  ]);

  test("Ok fixture: wzstd === zrip", () => {
    assertBytesEqual(wzstdDecompress(OK), zripDecompress(OK));
    assert.equal(new TextDecoder().decode(wzstdDecompress(OK)), "Ok");
  });

  test("Lorem fixture: wzstd === zrip", () => {
    assertBytesEqual(wzstdDecompress(LOREM), zripDecompress(LOREM));
  });
});
