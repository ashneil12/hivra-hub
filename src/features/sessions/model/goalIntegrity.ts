// WP-247: a goal can't be closed or loosened by the work it measures (OpenBot's goal integrity, MIT, commit 558cba6:
// server/src/responsibilities; the idea only, no code or text copied).
//
// The rule, in one place:
// - A goal's success criteria change only by Ash's own word, or by the captain with a decision row Ash can overturn.
//   Never by the run being measured: not its turn, not its tool calls, not its report. The app's own bookkeeping (the
//   cap's clear, setting the same goal again in a fresh conversation) changes nothing Ash set, so it isn't a change here.
// - A repeating goal (one a routine keeps coming back to) can be reported met by its own run, and that is recorded, but
//   the run can't close it. Only Ash, or the captain with a decision row, closes a repeating goal.
//
// Where it bites today: Claude Code's `/goal` (claudeGoal.ts). A turn whose text would set or clear it goes in only when
// Ash typed it in the composer (registry.ts refuses any other), and a tool call that would run `/goal` is refused before
// any mode can allow it (claude.ts beside the credential block, and registry.ts for every other CLI).

export type GoalActor =
  /** Ash himself: his composer, his tap. */
  | { kind: "ash" }
  /** The captain (Chief of Staff). Counts only with the decision row Ash can overturn. */
  | { kind: "captain"; decisionId?: string }
  /** The run the goal measures: its own turn, its tool calls, its report. */
  | { kind: "run" };

export type GoalVerdict = { ok: true } | { ok: false; reason: string };

export const RUN_CANNOT_CHANGE_GOAL =
  "Refused: a run can't change the goal it is measured by. Only Ash changes it, or the captain with a decision Ash can overturn.";
export const CAPTAIN_NEEDS_DECISION =
  "Refused: the captain changes a goal only with a decision row Ash can overturn. Note the decision first.";
export const GOAL_TURN_NOT_FROM_ASH =
  "Refused: only Ash changes a chat's goal, from his own composer. This message set or cleared it, so it was not sent.";
export const GOAL_TOOL_REFUSED =
  "Refused: a run can't set or clear its own goal. Report what you found instead; Ash decides whether the goal changes.";

/** Who may change what a goal counts as success. Fails closed on anything it doesn't know. */
export function mayChangeGoalCriteria(actor: GoalActor | null | undefined): GoalVerdict {
  if (!actor || typeof actor !== "object") return { ok: false, reason: RUN_CANNOT_CHANGE_GOAL };
  if (actor.kind === "ash") return { ok: true };
  if (actor.kind === "captain") {
    const id = typeof actor.decisionId === "string" ? actor.decisionId.trim() : "";
    return id ? { ok: true } : { ok: false, reason: CAPTAIN_NEEDS_DECISION };
  }
  return { ok: false, reason: RUN_CANNOT_CHANGE_GOAL };
}

export type GoalClosing = {
  /** A routine keeps coming back to it. */
  repeating?: boolean;
};

export type MetOutcome =
  /** The goal closes. */
  | { close: true }
  /** Recorded as met this time; the goal stays open. */
  | { close: false; reason: string };

/**
 * A report that the goal is met. A one-off goal closes as before (its check, not this rule, decides that). A repeating
 * goal stays open when its own run says so; Ash, or the captain with a decision row, may close it.
 */
export function reportMet(goal: GoalClosing, by: GoalActor | null | undefined): MetOutcome {
  if (!goal.repeating) return { close: true };
  const verdict = mayChangeGoalCriteria(by);
  return verdict.ok
    ? { close: true }
    : { close: false, reason: "Met this time. A repeating goal stays open: its own run can't close it." };
}

/** What a `/goal` line would do to Claude Code's goal: set it, clear it, or only show it. Null when it isn't one. */
export function goalCommandIn(text: unknown): "set" | "clear" | "show" | null {
  if (typeof text !== "string") return null;
  // Claude Code reads a slash command at the very start of the prompt; leading space and hidden characters are trimmed
  // the same way here, so a padded one is still caught.
  const head = text.replace(/^[\s\p{Cf}]+/u, "");
  const match = /^\/goal(?=$|\s)([\s\S]*)$/i.exec(head);
  if (!match) return null;
  const rest = match[1].trim();
  if (!rest) return "show";
  return /^clear\b/i.test(rest) ? "clear" : "set";
}

/**
 * A turn that would set or clear the chat's goal goes in only when Ash typed it (`byOwner`, set by the composer and
 * nothing else). A brief, a steer, a habit, an automation or an app note can't. Showing the goal (`/goal` alone) is fine.
 */
export function goalTurnRefusal(text: unknown, byOwner: boolean): string | undefined {
  const command = goalCommandIn(text);
  if (command === null || command === "show") return undefined;
  return mayChangeGoalCriteria(byOwner ? { kind: "ash" } : { kind: "run" }).ok ? undefined : GOAL_TURN_NOT_FROM_ASH;
}

/**
 * A tool call the run makes that would run `/goal` itself (Claude Code's SlashCommand tool, or any tool whose command
 * is a `/goal` line). Refused whatever the chat's mode: the run is the one being measured.
 */
export function goalToolRefusal(call: { tool?: unknown; command?: unknown } | null | undefined): string | undefined {
  if (!call || typeof call !== "object") return undefined;
  const command = goalCommandIn(call.command);
  if (command === null || command === "show") return undefined;
  return GOAL_TOOL_REFUSED;
}
