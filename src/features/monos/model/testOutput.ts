// r84 (s14): a worker's report reaches its Lead as a summary, not a log.
const OUTPUT_LINE = /^\s*(?:[✓✔✗✘×√]|(?:PASS|FAIL|ok|not ok)\b|#\s|\(?pass\)?\s|\(?fail\)?\s|▶|ℹ|at\s+\S+\s+\(|>\s|\$\s|\d+\s+passing|\d+\s+failing|Test Files|Tests\s+\d|Duration|stdout|stderr)/i;

/**
 * r84 (s14: worker updates were walls of test output): a run of more than four lines of test or command output in a
 * report is cut to its last line (usually the totals), so the Lead reads the summary, not the log.
 */
export function cutTestOutput(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length > 4) out.push(`[${run.length - 1} lines of test output cut]`, run[run.length - 1]);
    else out.push(...run);
    run = [];
  };
  let fenced = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      run.push(line);
      continue;
    }
    if (fenced || OUTPUT_LINE.test(line)) run.push(line);
    else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join("\n");
}
