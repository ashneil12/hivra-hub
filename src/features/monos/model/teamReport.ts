// A coding team's report in the briefing Mono's chat (PM, 21 Oct: one framed card, the team's name on its edge).
// Ported from UniiChat (Apache-2.0, VictorTaelin/UniiChat @ 0500bf6): a report is framed, named by who sent it
// (View.ts entry_rows `who = report?.name ?? WHO[kind]`, WHO.work = "Report"), its body plain text (md_plain), and a
// tall one folds to its head with "Show all" (web/src/Html.ts TALL: `text.length + 80 * lines > 4000`). The hub's report
// is the hidden turn a Lead's brief settles into the Mono's chat (monoSessionCompletion.ts), so the name is the team the
// Lead runs, read from the report's own sessionId. Port map: /workspace/research/ui-port-map.md idea 1.
import type { Block } from "../../sessions/model/session";

/** UniiChat Html.ts TALL: past this weighted length a report shows its head and "Show all". */
export const REPORT_TALL = 4000;
/** UniiChat Html.ts: each line weighs this much on top of its characters (a paste of short lines is tall too). */
export const REPORT_LINE_WEIGHT = 80;
/** UniiChat Theme.ts WHO.work: the label when the sender can't be named. */
export const REPORT_FALLBACK_NAME = "Report";

export type TeamReport = {
  /** The coding team's name ("EXO coding team"), or "Report". */
  team: string;
  /** The Lead's reply, as written. */
  text: string;
  status: "completed" | "failed" | "cancelled";
};

/** UniiChat's fold rule, exactly: `length + 80 * lines > 4000`. */
export function reportIsTall(text: string): boolean {
  return text.length + REPORT_LINE_WEIGHT * text.split("\n").length > REPORT_TALL;
}

type Payload = { sessionId?: unknown; result?: unknown; error?: unknown };

/** The JSON a completion turn carries after its notice (monoSessionCompletion.ts completionMessage). */
function payloadOf(text: string): Payload | undefined {
  const at = text.indexOf("\n\n{");
  if (at < 0) return undefined;
  try {
    const value = JSON.parse(text.slice(at + 2)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Payload) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The team report a block is, if it is one: a single report back (not a batch of sessions, not a worker's question) from
 * a chat `teamOf` names as a coding team's Lead. Anything else (a Mono's own worker, a batch) keeps today's look.
 */
export function readTeamReport(
  block: Pick<Block, "role" | "text" | "internal" | "monoSessionCompletion">,
  teamOf: (sessionId: string) => string | undefined,
): TeamReport | undefined {
  const done = block.monoSessionCompletion;
  if (block.role !== "user" || !block.internal || !done || done.question || done.sessionCount) return undefined;
  const payload = payloadOf(block.text);
  const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : done.sessionId;
  // undefined: not a coding team's Lead; "" a Lead whose team has no name yet (the source's fallback label).
  const team = teamOf(sessionId);
  if (team === undefined) return undefined;
  const result = typeof payload?.result === "string" ? payload.result : "";
  const error = typeof payload?.error === "string" ? payload.error : "";
  // UniiChat report_read drops the trailing "Full chat: zoom(...)" pointer from what is shown.
  const text = (result || error).replace(/\s*Full chat: zoom\("[^"\n]*"\)\s*$/, "").trim();
  if (!text) return undefined;
  return { team: team.trim() || REPORT_FALLBACK_NAME, text, status: done.status };
}
