/**
 * Progress ticker for long bench runs.
 *
 * Updates only when the caller says an item finished — never on a timer — so it
 * cannot steal cycles from the work being measured. One stderr line per tick
 * (`  3/25 done — wzstd Strong`); full lines rather than a carriage-return rewrite,
 * because the benches print tables between phases and a sticky status line
 * collides with that.
 */
export type Progress = {
  /** Record one finished item. Optional detail is appended after an em dash. */
  tick(detail?: string): void;
};

export function createProgress(total: number): Progress {
  let n = 0;

  return {
    tick(detail) {
      n += 1;
      const base = `  ${n}/${total} done`;
      process.stderr.write(
        detail !== undefined && detail.length > 0 ? `${base} — ${detail}\n` : `${base}\n`,
      );
    },
  };
}
