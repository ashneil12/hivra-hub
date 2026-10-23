// What the harness care loop (monos/model/harnessCare.ts, board H1/H3) can see about the app but can't fix by itself.
// The loop tells, this keeps the lines, and Today shows them in one card (ui/HarnessCareNotice.tsx) — even when the
// hub's own feed is unreachable, because these are the app's own surroundings, not a project's work.
import { useSyncExternalStore } from "react";

export type HarnessIssue = {
  /** The loop's fault id: the same fault keeps its row while it stands. */
  id: string;
  kind: "database" | "ship" | "pr-watch" | "resume" | "orphan";
  /** What the app saw, in one plain line. */
  line: string;
  /** Where the app keeps the detail (a ship's folder), for the card's "Show the log". */
  path?: string;
};

let rows: HarnessIssue[] = [];
let version = 0;
const subs = new Set<() => void>();
const changed = () => {
  version++;
  subs.forEach((f) => f());
};

export function harnessIssues(): HarnessIssue[] {
  return rows;
}

/** A fault care has told about: added, or its line brought up to date. */
export function addHarnessIssue(issue: HarnessIssue): void {
  const there = rows.some((row) => row.id === issue.id);
  const next = there ? rows.map((row) => (row.id === issue.id ? issue : row)) : [...rows, issue];
  rows = next;
  changed();
}

/** A told fault is gone. */
export function clearHarnessIssue(id: string): void {
  if (!rows.some((row) => row.id === id)) return;
  rows = rows.filter((row) => row.id !== id);
  changed();
}

/** Tests: no rows, as a fresh app. */
export function resetHarnessIssues(): void {
  rows = [];
  changed();
}

export function useHarnessIssues(): HarnessIssue[] {
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => version,
  );
  return rows;
}
