// The hourly progress check (Ash, 14 Oct; board H2). Once an hour, the chat that owns a worker running an hour or more
// is asked to look at it. Since 22 Oct the app also brings the evidence, read from the worker's own chat and folder
// (model/progressCheck.ts): what actually moved — commits, files changed, passing and failing test runs — or plainly
// that nothing did. The owner still decides; the app messages no worker and stops nothing by itself.
import type { QueuedMessage } from "../../sessions/model/session";
import { isOpenDelegation, type Delegation } from "./delegations";
import { forUser } from "../../hub/model/userName";
import { realityLine, type ProgressEvidence } from "./progressCheck";

export const HOUR_MS = 60 * 60_000;

/** The rows whose owner is due a look now: open for at least `every`, and not asked about within `every`. */
export function hourlyChecksDue(
  rows: readonly Pick<Delegation, "id" | "state" | "createdAt">[],
  asked: ReadonlyMap<string, number>,
  now: number,
  every = HOUR_MS,
): string[] {
  return rows
    .filter((row) => isOpenDelegation(row) && now - row.createdAt >= every && now - (asked.get(row.id) ?? 0) >= every)
    .map((row) => row.id);
}

/** The evidence a check brings: what moved in the window it looked at, and how long that window was. */
export type HourlyCheck = { evidence: ProgressEvidence; windowMinutes: number };

const runningFor = (row: Partial<Pick<Delegation, "createdAt">>, at: number) => {
  const hours = row.createdAt ? Math.max(1, Math.round((at - row.createdAt) / HOUR_MS)) : 1;
  return hours <= 1 ? "over an hour" : `${hours} hours`;
};

/** The one line, as a hidden turn in the owner's chat. Without evidence it is the plain ask it always was. */
export function hourlyCheckMessage(
  row: Pick<Delegation, "id" | "childSession" | "title"> & Partial<Pick<Delegation, "createdAt">>,
  at: number,
  check?: HourlyCheck | null,
): QueuedMessage {
  const who = row.title ? `"${row.title}"` : "A worker";
  const line = check
    ? `${who} has been running ${runningFor(row, at)}. Reality check: ${realityLine(check.evidence, check.windowMinutes)} If it isn't going to move, stop, split or retry it.`
    : `${who} has been running over an hour. Check it's really moving (task_status: commits, changed files, passing tests); if not, stop, split or retry it.`;
  return {
    id: `hourly-check-${row.id}-${Math.floor(at / HOUR_MS)}`,
    attachments: [],
    monoNote: { kind: "message", from: "Hourly check", line: line.length > 160 ? `${line.slice(0, 159)}…` : line },
    text: forUser`[MonoCode hourly check] ${line} (worker chat ${row.childSession}; this is the app, not Ash.)`,
  };
}
