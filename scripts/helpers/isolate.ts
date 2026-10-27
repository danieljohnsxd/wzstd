/**
 * Measure one implementation at a time, in its own process.
 *
 * **Why this exists.** `docs/experiments.md` has said "never bench decoder
 * variants in one process" since the decode work, and both decode harnesses did
 * exactly that anyway. A same-process sweep carries ±15% noise and it does not
 * just widen the error bars, it invents signal: `bench_summary` once reported a
 * no-verify decode row *slower* than the verifying one on all four frame shapes,
 * which is impossible. One process accumulates JIT feedback, one heap and one GC
 * schedule across every implementation it touches, and whichever runs first pays
 * for the ones after it.
 *
 * **The unit of isolation is the implementation, not the payload.** A child
 * measures one subject over many buffers, exactly as the old in-process loops
 * did — that part was never the defect. What must not share a process is two
 * things being *compared*.
 *
 * **Protocol.** The parent stages the buffers to one file, writes a job as JSON
 * and spawns `isolate_child.ts`; the child writes rates back as JSON. Nothing
 * crosses on a pipe. That is deliberate: this repo's helpers have deadlocked on
 * piped stdio more than once, and stderr is left inherited so a child that
 * throws still says so.
 *
 * Rates are MB/s of `bytes` per item — output bytes for a decoder, input bytes
 * for an encoder — so the caller decides what the rate is *of*.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every implementation either harness can time, named once.
 *
 * Ids rather than functions, because the function has to be constructed inside
 * the child — the whole point is that the parent never runs it.
 */
export type SubjectId =
  // decode
  | "wzstd"
  | "wzstd-noverify"
  | "wzstd-stream"
  | "fzstd"
  | "zrip"
  | "node-zlib"
  // encode
  | "wzstd-fast"
  | "wzstd-strong"
  | "wzstd-ultra"
  /** Pure-JS GZIP peer (fflate default level). Cross-format, not a zstd ceiling. */
  | "fflate-gzip"
  /** Host C zlib gzip (default level 6). Ceiling for pure-JS gzip. */
  | "node-gzip"
  | "zrip-1"
  | "zrip-3"
  | "node-zlib-fast8"
  | "node-zlib-3"
  | "node-zlib-19";

/** One buffer inside a staged blob, plus what its rate should be measured over. */
export type IsolateItem = { off: number; len: number; bytes: number };

export type IsolateJob = {
  subject: SubjectId;
  blobPath: string;
  items: Array<IsolateItem>;
  /** Indices into `items` to measure, in report order. */
  pick: Array<number>;
  targetMs: number;
  trials: number;
};

/** Buffers written to disk once, reusable by every subject that reads them. */
export type Staged = { path: string; items: Array<IsolateItem> };

export type Isolate = {
  /** Write buffers to one blob. Cheap to share: children only read it. */
  stage(chunks: Array<{ data: Uint8Array; bytes: number }>): Staged;
  /**
   * Median MB/s per item, in `pick` order (all items when `pick` is omitted).
   * A child that fails yields NaN rather than taking the run down — a missing
   * column prints as `—`, and a fabricated number would not. The failure is
   * still counted: see {@link Isolate.anyFailed}.
   */
  measure(subject: SubjectId, staged: Staged, pick?: Array<number>): Array<number>;
  /**
   * True when any prior `measure` had a non-zero child exit, a bad result
   * file, or produced no finite rate. Callers should exit non-zero so a table
   * of `—` is not mistaken for a successful run.
   */
  anyFailed(): boolean;
  dispose(): void;
};

/** Timing shape, shared so parent-reported and child-measured runs agree. */
export const TARGET_MS = 150;
export const TRIALS = 5;
/** Chunk size for the streaming decode subject — small enough to really stream. */
export const STREAM_CHUNK = 64 * 1024;

/**
 * SIGKILL (and tool harnesses that force-kill) cannot run dispose handlers, so
 * orphaned staging dirs accumulate. Sweep ones older than this at create time.
 * Live runs are younger than a minute; an hour leaves a wide safety margin for
 * a long `bench:summary` that is still writing its own dir.
 */
const STALE_STAGING_MS = 60 * 60 * 1000;

const CHILD = fileURLToPath(new URL("isolate_child.ts", import.meta.url));

function parseRates(raw: string, want: number): Array<number> {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || !("rates" in parsed)) {
    throw new Error("isolate child wrote no rates");
  }
  const { rates } = parsed;
  if (!Array.isArray(rates)) throw new Error("isolate child rates is not a list");
  const values: Array<unknown> = rates;
  if (values.length !== want) {
    throw new Error(`isolate child returned ${values.length} of ${want} rates`);
  }
  return values.map((v) => (typeof v === "number" ? v : Number.NaN));
}

function childFailReason(run: {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error | undefined;
}): string {
  if (run.error !== undefined) return run.error.message;
  if (run.signal !== null) return `signal ${run.signal}`;
  return `exit ${String(run.status)}`;
}

/** Best-effort remove of SIGKILL orphans from prior runs. Never touches live dirs. */
function sweepStaleStaging(): void {
  const root = tmpdir();
  let names: Array<string>;
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith("wzstd-bench-")) continue;
    const path = join(root, name);
    try {
      const st = statSync(path);
      if (!st.isDirectory()) continue;
      if (now - st.mtimeMs < STALE_STAGING_MS) continue;
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Race with another process, or permissions — leave it.
    }
  }
}

export function createIsolate(opts: { targetMs?: number; trials?: number } = {}): Isolate {
  const targetMs = opts.targetMs ?? TARGET_MS;
  const trials = opts.trials ?? TRIALS;
  sweepStaleStaging();
  const dir = mkdtempSync(join(tmpdir(), "wzstd-bench-"));
  let seq = 0;
  let failed = false;

  /**
   * Idempotent, because every abnormal-exit path below can also reach the
   * caller's explicit `dispose()` — and `process.exit()` re-enters "exit".
   */
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    rmSync(dir, { recursive: true, force: true });
  };

  /**
   * The staging dir holds a copy of every payload, so it must not outlive the
   * process. A bare `dispose()` at the end of a bench only covers the success
   * path: a throw mid-run, or the Ctrl-C you press when a 4-minute job looks
   * wedged, stranded the blob in tmpdir instead. Interrupted runs were leaving
   * megabytes behind, one dir per attempt.
   *
   * "exit" catches normal return, an uncaught throw, and explicit `exit()`.
   * Signals need their own handlers: Node's *default* SIGINT/SIGTERM action
   * terminates without ever emitting "exit", and installing a listener is what
   * suppresses that default — so each one must re-exit itself, at the code the
   * shell expects for that signal (128 + signo).
   */
  process.on("exit", dispose);
  process.on("SIGINT", () => {
    dispose();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    dispose();
    process.exit(143);
  });

  return {
    stage(chunks) {
      const total = chunks.reduce((sum, c) => sum + c.data.length, 0);
      const blob = new Uint8Array(total);
      const items: Array<IsolateItem> = [];
      let off = 0;
      for (const c of chunks) {
        blob.set(c.data, off);
        items.push({ off, len: c.data.length, bytes: c.bytes });
        off += c.data.length;
      }
      const path = join(dir, `blob-${seq++}.bin`);
      writeFileSync(path, blob);
      return { path, items };
    },

    measure(subject, staged, pick) {
      const idx = pick ?? staged.items.map((_, i) => i);
      if (idx.length === 0) return [];
      const jobPath = join(dir, `job-${seq}.json`);
      const outPath = join(dir, `out-${seq++}.json`);
      const job: IsolateJob = {
        subject,
        blobPath: staged.path,
        items: staged.items,
        pick: idx,
        targetMs,
        trials,
      };
      writeFileSync(jobPath, JSON.stringify(job));

      // Never pipe stdout: results come back through a file precisely so a
      // chatty or wedged child cannot fill a pipe buffer and deadlock the
      // parent. stderr stays inherited so a throw is visible.
      const run = spawnSync(process.execPath, [CHILD, jobPath, outPath], {
        stdio: ["ignore", "ignore", "inherit"],
      });
      if (run.status !== 0 || run.error !== undefined || run.signal !== null) {
        failed = true;
        console.error(`  !! ${subject}: child ${childFailReason(run)} — column is —`);
        return idx.map(() => Number.NaN);
      }
      try {
        const rates = parseRates(readFileSync(outPath, "utf8"), idx.length);
        // Any non-finite cell is a failed measurement, not just an
        // all-NaN column — mixed results used to exit 0 with silent —.
        const bad = rates.filter((r) => !Number.isFinite(r)).length;
        if (bad > 0) {
          failed = true;
          console.error(`  !! ${subject}: ${bad}/${rates.length} non-finite rates — column is —`);
        }
        return rates;
      } catch (err) {
        failed = true;
        console.error(`  !! ${subject}: ${String(err)} — column is —`);
        return idx.map(() => Number.NaN);
      }
    },

    anyFailed: () => failed,

    dispose,
  };
}

/** Shared table cell: finite → fixed decimals, else an em dash. */
export function num(v: number, w: number, digits = 1): string {
  return (Number.isFinite(v) ? v.toFixed(digits) : "—").padStart(w);
}
