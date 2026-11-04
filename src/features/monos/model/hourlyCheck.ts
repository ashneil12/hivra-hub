// The hourly check's words (board H2). When it is due moved to the watcher (Hivra WP-11, firstmate/watcher/hourly.ts);
// re-exported so callers keep their imports.
import type { QueuedMessage } from "../../sessions/model/session";
import type { Delegation } from "./delegations";
import { forUser } from "../../hub/model/userName";
import { realityLine, type ProgressEvidence } from "./progressCheck";
import type { WorkerJudgement } from "./workerProgress";
import { HOUR_MS } from "../../firstmate/watcher/hourly";

export { HOUR_MS, hourlyChecksDue } from "../../firstmate/watcher/hourly";

/** The evidence a check brings: what moved in the window it looked at, how long that window was, and the judge's verdict. */
export type HourlyCheck = { evidence: ProgressEvidence; windowMinutes: number; judgement?: WorkerJudgement };

const runningFor = (row: Partial<Pick<Delegation, "createdAt">>, at: number) => {
  const hours = row.createdAt ? Math.max(1, Math.round((at - row.createdAt) / HOUR_MS)) : 1;
  return hours <= 1 ? "over an hour" : `${hours} hours`;
};

/** The judge's own line and advice when there is one; the plain evidence and the standing ask when there isn't. */
const checkLine = (check: HourlyCheck) =>
  check.judgement
    ? `${check.judgement.line} ${check.judgement.advice}`
    : `${realityLine(check.evidence, check.windowMinutes)} If it isn't going to move, stop, split or retry it.`;

/** The one line, as a hidden turn in the owner's chat. Without evidence it is the plain ask it always was. */
export function hourlyCheckMessage(
  row: Pick<Delegation, "id" | "childSession" | "title"> & Partial<Pick<Delegation, "createdAt">>,
  at: number,
  check?: HourlyCheck | null,
): QueuedMessage {
  const who = row.title ? `"${row.title}"` : "A worker";
  const line = check
    ? `${who} has been running ${runningFor(row, at)}. Reality check: ${checkLine(check)}`
    : `${who} has been running over an hour. Check it's really moving (task_status: commits, changed files, passing tests); if not, stop, split or retry it.`;
  return {
    id: `hourly-check-${row.id}-${Math.floor(at / HOUR_MS)}`,
    attachments: [],
    monoNote: { kind: "message", from: "Hourly check", line: line.length > 160 ? `${line.slice(0, 159)}…` : line },
    text: forUser`[MonoCode hourly check] ${line} (worker chat ${row.childSession}; this is the app, not Ash.)`,
  };
}
