/**
 * Thin wrappers around the host `zstd` CLI for cross-checks.
 * Requires `zstd` on PATH (Homebrew: zstd).
 *
 * **Why not `spawnSync({ input })`.** Feeding multi-megabyte stdin through
 * Node's sync spawn is a classic pipe deadlock: the parent blocks writing the
 * rest of stdin while the child blocks writing stdout into a full pipe the
 * parent is not yet reading. Under the full suite (many workers calling zstd at
 * once) that shows up as an idle `zstd` at 0% CPU and a node:test worker that
 * never exits — "Promise resolution is still pending" after minutes. Level and
 * payload size are red herrings; a 1.5 MB `zstd -3` finishes in ~10ms alone.
 *
 * Instead: stage the input as a file, then either:
 * - **file args** when size may be known (`zstd -o out in`), or
 * - **`cat file | zstd …`** when we need a non-seekable stdin so the CLI omits
 *   Frame_Content_Size (the no-FCS path the decoder must still handle).
 *
 * Both paths are time-bounded. A stuck child becomes a hard fail, not a hang.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const HEAVY_TIMEOUT_MS = 120_000;

export function hasZstdCli(): boolean {
  const r = spawnSync("zstd", ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return r.status === 0;
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "wzstd-zstd-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkResult(r: ReturnType<typeof spawnSync>, label: string, timeout: number): void {
  if (r.error !== undefined) {
    const code = "code" in r.error && typeof r.error.code === "string" ? r.error.code : undefined;
    throw new Error(
      code === "ETIMEDOUT"
        ? `${label} timed out after ${timeout}ms`
        : `${label} spawn failed: ${r.error.message}`,
    );
  }
  if (r.signal !== null) {
    throw new Error(
      `${label} killed by signal ${r.signal}` +
        (r.signal === "SIGKILL" ? ` (likely timeout ${timeout}ms)` : ""),
    );
  }
  if (r.status !== 0) {
    const errBuf = r.stderr;
    const detail = errBuf.length > 0 ? errBuf.toString() : `exit ${String(r.status)}`;
    throw new Error(`${label} failed: ${detail}`);
  }
}

/**
 * Run `zstd` with arbitrary args over a payload.
 *
 * - `viaPipe: true`: `cat file | zstd … -c` — non-seekable stdin, **no FCS**.
 * - `viaPipe: false` (default): `zstd … -o out in` — file-to-file, size known.
 */
export function zstdRun(
  args: Array<string>,
  data: Uint8Array,
  opts: {
    timeoutMs?: number;
    maxBuffer?: number;
    viaPipe?: boolean;
  } = {},
): Uint8Array {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? 64 * 1024 * 1024;
  const viaPipe = opts.viaPipe === true;

  return withTempDir((dir) => {
    const inPath = join(dir, "in.bin");
    const outPath = join(dir, "out.bin");
    writeFileSync(inPath, data);

    if (viaPipe) {
      // Shell pipeline: Node never writes multi-MB to a child stdin pipe.
      // zstd must see *only* a non-seekable stdin (no file args), or it
      // learns the size and emits FCS. Quote args for the shell.
      const quoted = args.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(" ");
      const r = spawnSync("/bin/sh", ["-c", `cat "$1" | exec zstd ${quoted} -c`, "sh", inPath], {
        encoding: "buffer",
        maxBuffer,
        timeout,
        killSignal: "SIGKILL",
      });
      checkResult(r, `zstd ${args.join(" ")} (pipe)`, timeout);
      return new Uint8Array(r.stdout);
    }

    const r = spawnSync("zstd", [...args, "-o", outPath, "--force", inPath], {
      encoding: "buffer",
      maxBuffer: 1 << 20, // stderr only; payload is on disk
      timeout,
      killSignal: "SIGKILL",
    });
    checkResult(r, `zstd ${args.join(" ")}`, timeout);
    return new Uint8Array(readFileSync(outPath));
  });
}

/**
 * Compress with system zstd; level is passed as `-{level}` (e.g. 1 → `-1`).
 *
 * Default is **via a pipe**, so the frame omits Frame_Content_Size — matching
 * `zstd` reading stdin / any streaming producer. That is a distinct decoder
 * path from our own frames (which always carry FCS). Pass `withContentSize` to
 * force FCS (file-to-file compress, size known up front).
 */
export function zstdCompress(data: Uint8Array, level = 1, withContentSize = false): Uint8Array {
  const levelArg = level < 0 ? `--fast=${-level}` : `-${level}`;
  const timeoutMs = level >= 19 || level <= -8 ? HEAVY_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;

  if (withContentSize) {
    // File-to-file: zstd knows the length and emits FCS (single-segment).
    return zstdRun([levelArg], data, { timeoutMs, viaPipe: false });
  }
  // Pipe: no FCS — the path decode_no_fcs_test and bench:decode CLI frames need.
  return zstdRun([levelArg], data, { timeoutMs, viaPipe: true });
}

export function zstdDecompress(data: Uint8Array): Uint8Array {
  // File-to-file decompress — no stdin pipe, no deadlock risk.
  return zstdRun(["-d"], data, {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    viaPipe: false,
    maxBuffer: 256 * 1024 * 1024,
  });
}
