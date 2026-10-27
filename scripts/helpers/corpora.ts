/**
 * One corpus selection, shared by every bench.
 *
 * **Main set (default)** — two corpora, reported separately, never pooled:
 *
 * - **In-repo synthetic** (`tests/helpers/corpus.ts`) — ~78 payloads / ~141 MB,
 *   hermetic generators. Quote as *in-repo synthetic*.
 * - **Silesia subset** (`scripts/helpers/silesia.ts`) — four pinned real files
 *   (~34 MB: dickens, xml, osdb, x-ray). Downloaded on demand into
 *   `bench-data/silesia/`. Quote as *Silesia subset* (Deorowicz); see
 *   provenance in that helper.
 *
 * **Extra** (`extra-bench-data/` or `WZSTD_CORPUS_DIR`) — *your* data; opt-in
 * via `--extra`. Adoption question, not the product default.
 *
 * ```
 *   pnpm bench:<x>                  main set (synthetic + silesia)
 *   pnpm bench:<x> --silesia-only   Silesia subset alone
 *   pnpm bench:<x> --extra          main set + your data
 *   pnpm bench:<x> --extra-only     extra only
 *   pnpm bench:<x> 1000000          positional: per-payload byte cap for speed
 *   pnpm bench:<x> --limit 3        first N payloads per corpus — smoke test only
 *   WZSTD_CORPUS_DIR=/path/to/data  use your own directory
 * ```
 *
 * **Asking for a corpus and not having it is an error**, not a skip (extra:
 * empty dir; silesia: download/tool failure). Never pool corpora into one
 * statistic.
 */
import { type ParseArgsConfig, parseArgs } from "node:util";
import { benchPayloads, type Payload } from "../../tests/helpers/corpus.ts";
import {
  externalCorpusDir,
  externalCorpusIsPartial,
  externalPayloads,
} from "../../tests/helpers/external_corpus.ts";
import { silesiaPayloads } from "./silesia.ts";

export type CorpusId = "synthetic" | "silesia" | "extra";

export type Corpus = {
  /** Tag a median line is grouped by. */
  id: CorpusId;
  /** Human label for a section heading. */
  label: string;
  payloads: Array<Payload>;
};

type Options = NonNullable<ParseArgsConfig["options"]>;
type Values = ReturnType<typeof parseArgs>["values"];

export type BenchArgs = {
  /** Per-payload byte cap for speed measurements. Ratio always uses whole files. */
  cap: number;
  corpora: Array<Corpus>;
  /**
   * True when this run is the default main set only (synthetic + silesia, no
   * extra). Valid product basis — label each section by corpus name.
   */
  mainOnly: boolean;
  /** Parsed values, including any bench-specific options passed in. */
  values: Values;
};

const DEFAULT_CAP = 4_000_000;

/**
 * Parse corpus flags / optional numeric cap, and load selected corpora.
 *
 * A bench with its own flags declares them in `extraOptions` and reads them back
 * off `values`; parsing stays strict, so a typo is an error rather than a
 * silently ignored flag that makes the run mean something else.
 */
export function selectCorpora(
  extraOptions: Options = {},
  argv: Array<string> = process.argv.slice(2),
): BenchArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      extra: { type: "boolean", default: false },
      "extra-only": { type: "boolean", default: false },
      "silesia-only": { type: "boolean", default: false },
      limit: { type: "string" },
      ...extraOptions,
    },
    allowPositionals: true,
  });

  const wantExtraBoth = values["extra"];
  const wantExtraOnly = values["extra-only"];
  const wantSilesiaOnly = values["silesia-only"];

  if (wantExtraBoth && wantExtraOnly) {
    throw new Error("--extra and --extra-only contradict; pass one");
  }

  if (positionals.length > 1) {
    throw new Error(
      `unexpected arguments after byte cap: ${positionals.slice(1).join(" ")}\n` +
        "  Only one positional is accepted (the per-payload speed cap).",
    );
  }
  const capArg = positionals[0];
  const cap = capArg === undefined ? DEFAULT_CAP : Number(capArg);
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new Error(`byte cap must be a positive number, got ${String(capArg)}`);
  }

  /**
   * `--limit` is a smoke-test hatch, not a sampling knob. A run that saw a
   * couple of payloads is not a benchmark, so it announces itself; the point is
   * proving a harness executes end to end without waiting out a full pass.
   */
  const limitArg = values["limit"];
  const limit = limitArg === undefined ? Number.POSITIVE_INFINITY : Number(limitArg);
  if (limitArg !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`--limit must be a positive integer, got ${limitArg}`);
  }
  if (Number.isFinite(limit)) {
    console.log(`  !! --limit ${limit}: smoke test only, never a result.`);
  }

  const wantExtra = wantExtraBoth || wantExtraOnly;
  // Main set: synthetic + silesia. --*-only drops the rest of the main set.
  const wantSynthetic = !wantExtraOnly && !wantSilesiaOnly;
  // Silesia is on for the main set and for --silesia-only; off for --extra-only.
  const wantSilesia = wantSilesiaOnly || !wantExtraOnly;

  const corpora: Array<Corpus> = [];

  if (wantSynthetic) {
    corpora.push({
      id: "synthetic",
      label: "in-repo synthetic",
      payloads: benchPayloads().slice(0, limit),
    });
  }

  if (wantSilesia) {
    const all = silesiaPayloads();
    const payloads = all.slice(0, limit);
    const total = payloads.reduce((sum, p) => sum + p.data.length, 0);
    corpora.push({
      id: "silesia",
      label: `silesia subset (pinned) — ${payloads.length} files, ${total} B`,
      payloads,
    });
  }

  if (wantExtra) {
    const dir = externalCorpusDir();
    const all = externalPayloads();
    const payloads = all.slice(0, limit);
    if (all.length === 0) {
      throw new Error(
        `no extra corpus in ${dir}\n` +
          "  Put files there, or set WZSTD_CORPUS_DIR to a directory of your own.\n" +
          "  Any file is a payload; the extension is not interpreted.\n" +
          "  Drop the flag to use the main set (synthetic + silesia).",
      );
    }
    if (externalCorpusIsPartial()) {
      console.log(
        "  !! some extra files are truncated samples (-part.) — ratio from a\n" +
          "     byte prefix is not the ratio of the whole file.",
      );
    }
    const total = payloads.reduce((sum, p) => sum + p.data.length, 0);
    corpora.push({
      id: "extra",
      label: `extra (${dir}) — ${payloads.length} files, ${total} B`,
      payloads,
    });
  }

  if (corpora.length === 0) {
    throw new Error("no corpora selected");
  }

  const mainOnly = wantSynthetic && wantSilesia && !wantExtra;
  return {
    cap,
    corpora,
    mainOnly,
    values,
  };
}

/**
 * Footer for a main-set-only run (synthetic + silesia, no extra). Label each
 * section by name when quoting; never pool the two into one statistic.
 */
export const MAIN_CORPUS_NOTE =
  "\n  Main set: in-repo synthetic (~78 / ~141 MB) + pinned Silesia subset\n" +
  "     (dickens, xml, osdb, x-ray; ~34 MB). Report each section separately.\n" +
  "     Silesia corpus: S. Deorowicz, Silesian University of Technology\n" +
  "     https://sun.aei.polsl.pl/~sdeor/index.php?page=silesia\n" +
  "     --extra is your own data. Never pool corpora into one statistic.\n";
