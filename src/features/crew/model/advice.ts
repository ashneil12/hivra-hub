// WP-13: a reroute names the next signed-in CLI. It does not start a worker.

import type { MonoSessionCompletionResult } from "../../monos/model/monoSessionCompletion";
import { cliLabel, isCli } from "./clis";

/** What `crew_on_failure` told the app. `to` is the next signed-in CLI, when there is one. */
export type CrewFailureNote = {
  action?: string;
  to?: string;
};

/** Add one sentence when a reroute names a CLI. Anything else leaves the report as it was. */
export function withCrewAdvice(
  result: MonoSessionCompletionResult,
  note: CrewFailureNote | undefined,
): MonoSessionCompletionResult {
  if (note?.action !== "reroute" || !note.to || !isCli(note.to)) return result;
  const sentence = `${cliLabel(note.to)} is signed in and can take this.`;
  const reason = result.reason?.trim() ?? "";
  if (!reason) return { ...result, reason: sentence };
  const joined = /[.!?]$/.test(reason) ? `${reason} ${sentence}` : `${reason}. ${sentence}`;
  return { ...result, reason: joined };
}
