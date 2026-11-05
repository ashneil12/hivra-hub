// WP-88: Home shows the morning habit's report only when it links to something that was read, and the setting is on.

import { habitReport } from "../../monos/model/monoHabits";
import { linesFromReply, type AnswerLine, type Reading } from "./answer";

/** Absent or anything other than false leaves the summary on. */
export function summaryTurnedOff(value: unknown): boolean {
  return value === false;
}

/** On drops the flag. Off stores exactly false, so a later read cannot mistake a string for off. */
export function withDailySummary<T extends { dailySummary?: false }>(doc: T, on: boolean): T {
  if (on) {
    if (doc.dailySummary !== false) return doc;
    const { dailySummary: _, ...rest } = doc;
    return rest as T;
  }
  return { ...doc, dailySummary: false };
}

/**
 * No report, a quiet report, a report with no resolvable line, or the setting off: nothing to show.
 * Prose that does not name a reading is dropped, so the note cannot claim what it did not read.
 */
export function summaryLines(report: string | undefined, off: boolean, readings: readonly Reading[]): AnswerLine[] {
  if (off) return [];
  if (typeof report !== "string") return [];
  const said = habitReport(report);
  if (!said) return [];
  return linesFromReply(said, readings);
}
