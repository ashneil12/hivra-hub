// "Since you were here: 2 replies, 1 report": a quiet divider in a Mono's chat after Ash has been away. OUR OWN IDEA
// (PM, 21 Oct; port map idea 5): neither UniiChat nor Alan's Workspace has it. UniiChat's nearest code is its AI
// disclosure line on fixed 3-hour clock windows (View.ts part_due, NOTICE = 3h), which is not a gap and shows no counts;
// nothing here is ported from it. Ours: a turn that starts 3 h or more after the one before, and that Ash didn't start,
// gets one divider, counting what came from there up to his next own message (or the next gap): the Mono's replies, and
// coding-team reports (teamReport.ts). Built from the chat's own blocks, no new AI call. An extra on top of the five
// screens: it does not close C9 (the one long chat), which stays out of scope.
import type { Block } from "../../sessions/model/session";
import {
  isProseBlock,
  monoTurnLatestStart,
  monoTurnRuns,
} from "../../sessions/model/transcriptActivity";

/** How long Ash has to be away (between one turn and the next) before the divider shows. OUR OWN NUMBER: Ash never
 * named a length, and neither app has a gap rule (UniiChat's 3 h is a fixed clock window for its AI notice). */
export const AWAY_GAP_MS = 3 * 60 * 60 * 1000;

export type SinceYouWereHere = { replies: number; reports: number };

/** Ash's own words (not an app prompt, a room's wake or a draft). */
function isAshMessage(block: Block): boolean {
  return block.role === "user" && !block.internal && !block.draft;
}

function turnStart(turn: readonly Block[]): number | undefined {
  return turn[0]?.monoHabit?.at ?? turn[0]?.startedAt ?? undefined;
}

/** Whether `turn` opens a gap of AWAY_GAP_MS or more after `previous`. */
function opensGap(turn: Block[], previous: Block[] | undefined): boolean {
  if (!previous) return false;
  const at = turnStart(turn);
  const before = monoTurnLatestStart(previous);
  return at != null && before != null && at - before >= AWAY_GAP_MS;
}

/**
 * The dividers for a Mono chat's turns (groupMonoChatTurns), by turn index. `isReport` says whether a run's first block
 * is a coding team's report.
 */
export function sinceYouWereHere(
  turns: Block[][],
  isReport: (block: Block) => boolean,
): Map<number, SinceYouWereHere> {
  const out = new Map<number, SinceYouWereHere>();
  turns.forEach((turn, index) => {
    if (!opensGap(turn, turns[index - 1]) || isAshMessage(turn[0])) return;
    const counts = { replies: 0, reports: 0 };
    for (let at = index; at < turns.length; at++) {
      const next = turns[at];
      if (at > index && (isAshMessage(next[0]) || opensGap(next, turns[at - 1]))) break;
      for (const run of monoTurnRuns(next)) {
        if (isReport(run[0])) counts.reports++;
        if (run.some(isProseBlock)) counts.replies++;
      }
    }
    if (counts.replies || counts.reports) out.set(index, counts);
  });
  return out;
}

/** "Since you were here: 2 replies, 1 report". */
export function sinceLabel({ replies, reports }: SinceYouWereHere): string {
  const parts = [
    replies ? `${replies} ${replies === 1 ? "reply" : "replies"}` : "",
    reports ? `${reports} ${reports === 1 ? "report" : "reports"}` : "",
  ].filter(Boolean);
  return `Since you were here: ${parts.join(", ")}`;
}
