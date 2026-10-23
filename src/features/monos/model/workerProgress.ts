// The progress judge behind the hourly check (board H2; Ash, 14 Oct: "if its running for more than an hour the main
// agent checks that progress is still being made or not"). It is a measurement, not a prompt.
//
// `progressCheck.ts` reads a worker's folder and chat; this turns that reading into one verdict and one plain thing to do
// about it: `progressing` (something real moved), `quiet` (it talked or ran failing tests, but nothing moved), `looping`
// (the same test failing, or the same change made, over and over), `done-elsewhere` (commits landed in its folder but the
// worker made none of them), or `no-work` (nothing at all). The hourly check carries the line to the worker's owner, and
// self-repair acts on the verdicts that need a hand (selfRepair.ts); the app still runs no model and stops nothing by
// itself.
import { evidenceOf, movedLine, realProgress, realityLine, type Look, type ProgressEvidence } from "./progressCheck";

export type WorkerVerdict = "progressing" | "quiet" | "looping" | "done-elsewhere" | "no-work";

/** How often in a row the same failure (or the same change) makes a loop, rather than a rough patch. */
export const LOOP_REPEATS = 3;

/** What the judge is given about one open row: what the app read, and the worker's own last word. */
export type WorkerRead = {
  /** Everything the worker did, added up since its row started: its folder and its chat. */
  look: Look;
  /** Its last report to its Lead, in its own words (the row's result, or the newest thing it said). */
  report?: string;
  /** How long the row has been open. */
  minutes: number;
};

export type WorkerJudgement = {
  verdict: WorkerVerdict;
  /** What the app saw, in one plain line. */
  line: string;
  /** What the owner should do about it, in one plain sentence. */
  advice: string;
  /** The measurement the verdict came from. */
  evidence: ProgressEvidence;
};

const short = (text: string, max = 160) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** The last report, appended to a line that says nothing moved, so the owner sees what the worker claims. */
function withWord(line: string, report: string | undefined): string {
  const word = report?.trim().replace(/\s+/g, " ");
  return word ? `${line} It last said: “${short(word)}”` : line;
}

/** The same test failing again and again, or the same change made again and again: the worker is going round a step. */
function loopOf(look: Look): string | undefined {
  const { testRun, editRun } = look.tally;
  if (testRun && testRun.count >= LOOP_REPEATS)
    return `looping — the same test failed in each of the last ${testRun.count} runs: ${testRun.name}.`;
  if (editRun && editRun.count >= LOOP_REPEATS) return `looping — the same change to ${editRun.file} was made ${editRun.count} times in a row.`;
  return undefined;
}

/**
 * Judge one worker. The order matters: a repeated failure or change is a loop even if something else moved; commits it
 * made none of mean the work landed without it; then anything real counts as progress, talk and failing runs alone are
 * quiet, and nothing at all is no work.
 */
export function judgeWorkerProgress(read: WorkerRead): WorkerJudgement {
  const evidence = evidenceOf(read.look);
  const loop = loopOf(read.look);
  if (loop) {
    return { verdict: "looping", line: loop, advice: "It's going round the same step. Stop it, or retry it with a different approach.", evidence };
  }
  if (evidence.commits > 0 && evidence.edits === 0 && evidence.testsPassed === 0) {
    const what = movedLine({ ...evidence, files: 0, additions: 0, deletions: 0, edits: 0, testsPassed: 0 });
    return {
      verdict: "done-elsewhere",
      line: `done elsewhere — ${what} landed in its folder since it started, but the worker made no edits and passed no tests.`,
      advice: "Check whether the work is already done, and stop it if it is.",
      evidence,
    };
  }
  if (realProgress(evidence)) {
    return { verdict: "progressing", line: realityLine(evidence, read.minutes), advice: "It's moving. Leave it alone unless it stops.", evidence };
  }
  if (evidence.messages || evidence.testsFailed) {
    return {
      verdict: "quiet",
      line: withWord(realityLine(evidence, read.minutes), read.report),
      advice: "Nothing real has moved. Stop it, split it or retry it a different way.",
      evidence,
    };
  }
  return {
    verdict: "no-work",
    line: withWord(realityLine(evidence, read.minutes), read.report),
    advice: "Nothing has moved yet. Stop it, split it or retry it a different way.",
    evidence,
  };
}

/** Whether this verdict is one self-repair may act on by itself: a hand to the worker, with backoff. */
export function stalledVerdict(verdict: WorkerVerdict): boolean {
  return verdict === "quiet" || verdict === "looping" || verdict === "no-work";
}

/** What self-repair says when its retries ran out, in the same plain words as the rest of its notes. */
export function noProgressReason(judgement: WorkerJudgement, tries: number): string {
  const what = judgement.verdict === "looping" ? "Still looping" : "Still no real progress";
  return `${what} after ${tries} tries, retries ran out: ${judgement.line}`;
}
