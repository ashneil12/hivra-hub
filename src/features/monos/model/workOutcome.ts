// One source for how a delegated worker's job ended (PM 22 Oct: the Lead's chat, the rail, Today and Sessions must
// agree; a worker marked failed still showed the green Done tick). The delegation row is that source: the Lead's
// report card reads its status, the rail and Today's stuck list read the row (workerStuck.ts), and the green "Done"
// tick (sidebar, Working tray, tabs) now asks the row too, so a failed, stopped or stuck worker never shows it.
import type { Delegation } from "./delegations";

export type WorkOutcome = "working" | "waiting" | "stuck" | "done" | "failed" | "stopped";

/** The newest row for a child chat (a later try in the same chat replaces an earlier one). */
export function rowOfSession(rows: readonly Delegation[], sessionId: string): Delegation | undefined {
  let found: Delegation | undefined;
  for (const row of rows) if (row.childSession === sessionId && (!found || row.createdAt > found.createdAt)) found = row;
  return found;
}

/** How the row says its work stands; undefined for a chat that isn't a delegated worker. */
export function workOutcome(row: Delegation | undefined): WorkOutcome | undefined {
  if (!row) return undefined;
  switch (row.state) {
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    case "question":
      return "waiting";
    default:
      return row.stallKind ? "stuck" : "working";
  }
}

/**
 * The finished-and-unseen chats that may show the green Done tick: a delegated worker's only when its row says done.
 * Same set back when nothing changes, so React memo checks hold.
 */
export function doneOnlyWhenDone<S extends ReadonlySet<string>>(ids: S, rows: readonly Delegation[]): S {
  let out: Set<string> | undefined;
  for (const id of ids) {
    const outcome = workOutcome(rowOfSession(rows, id));
    if (outcome && outcome !== "done") (out ??= new Set(ids)).delete(id);
  }
  return (out as S | undefined) ?? ids;
}
