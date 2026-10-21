// The hourly progress check (Ash, 14 Oct; kept on 21 Oct as one plain line): once an hour, the chat that owns a worker
// running an hour or more is asked to look at it. The owner decides; the app reads no folders, messages no worker and
// stops nothing by itself.
import type { QueuedMessage } from "../../sessions/model/session";
import { isOpenDelegation, type Delegation } from "./delegations";

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

/** The one line, as a hidden turn in the owner's chat. */
export function hourlyCheckMessage(row: Pick<Delegation, "id" | "childSession" | "title">, at: number): QueuedMessage {
  const line = `${row.title ? `"${row.title}"` : "A worker"} has been running over an hour. Check it's really moving (task_status: commits, changed files, passing tests); if not, stop, split or retry it.`;
  return {
    id: `hourly-check-${row.id}-${Math.floor(at / HOUR_MS)}`,
    attachments: [],
    monoNote: { kind: "message", from: "Hourly check", line: line.length > 160 ? `${line.slice(0, 159)}…` : line },
    text: `[MonoCode hourly check] ${line} (worker chat ${row.childSession}; this is the app, not Ash.)`,
  };
}
