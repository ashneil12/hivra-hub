// Claude Code's /goal, as MonoCode reads it (docs/PHASE-2-DESIGN.md H5; T3 harvest "/goal: a finish line").
//
// Confirmed against Claude Code 2.1.302 in stream-json mode (the way MonoCode runs it; probe and transcripts in the
// H5 evidence): `/goal <condition>` sets a session Stop hook that a separate evaluator checks each time Claude tries to
// stop, inside the same turn. What the CLI prints for it:
// - `Goal set: <condition>` — a synthetic assistant message (model "<synthetic>");
// - `Stop hook feedback:\n[<condition>]: <reason>` — a synthetic user message, once per check that said "not yet";
//   Claude keeps working in the same turn;
// - nothing when a check passes: the goal clears itself and the turn ends with its `result`;
// - `A hook blocked the turn from ending N consecutive times — overriding …` (system informational) when the CLI's own
//   per-turn cap ends the turn first; the goal stays set for the next turn;
// - `Goal active: <condition> (N turns)\nLast check: <reason>` / `No goal set` / `Goal cleared: <condition>` for `/goal`,
//   `/goal` with no argument and `/goal clear`.
// The goal lives in the CLI's conversation: `--resume` keeps it (checks start again from none), a fresh conversation
// (a Mono's rotation, a resume that found no transcript) loses it, so MonoCode sets it again there.
// Everything here is pure; claude.ts feeds it the frames and sends the commands.
import type { SessionGoal } from "../../../../features/sessions/model/session";

/** How many checks a goal gets before MonoCode clears it (T3 caps the keep-going loop the same way). */
export const GOAL_CHECK_CAP = 20;
/** Longer conditions are cut (the delegation row keeps 1,000 characters too). */
export const GOAL_MAX = 1_000;

const BRIEF_HEAD = "[MonoCode brief from ";
const DONE_WHEN = /\n\nDone when: ([^\n][\s\S]*)$/;

/**
 * The finish line a delegated brief carries (agentAppTasks.briefPrompt): its last paragraph, "Done when: <goal>".
 * Only a MonoCode brief counts, never Ash's own text.
 */
export function goalFromBrief(text: string): string | undefined {
  if (!text.startsWith(BRIEF_HEAD)) return undefined;
  const condition = DONE_WHEN.exec(text)?.[1]?.replace(/\s+/g, " ").trim();
  return condition ? condition.slice(0, GOAL_MAX) : undefined;
}

export function goalCommand(condition: string): string {
  return `/goal ${condition.replace(/\s+/g, " ").trim().slice(0, GOAL_MAX)}`;
}
export const GOAL_CLEAR = "/goal clear";

/** The goal as one Claude conversation has it, plus what MonoCode needs to keep it honest. */
export type GoalTrack = SessionGoal & {
  /** Claude's conversation the goal was set in; a different one has lost it. */
  providerSessionId?: string;
  /** Claude spoke since the last check: its next stop will be checked. */
  pendingCheck?: boolean;
  /** MonoCode already asked the CLI to clear it (the cap). */
  clearing?: boolean;
};

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function messageText(rec: Record<string, unknown>): string {
  const message = rec.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" ? text((part as { text?: unknown }).text) : ""))
    .join("");
}

function synthetic(rec: Record<string, unknown>): boolean {
  return (rec.message as { model?: unknown } | undefined)?.model === "<synthetic>";
}

const ACTIVE = /^Goal active: ([\s\S]+?) \((?:not yet evaluated|(\d+) turns?)\)(?:\nLast check: ([\s\S]*))?$/;

/**
 * The goal after one stream-json line, or `undefined` when the line says nothing about it. `null` means no goal.
 * `isMainThread` excludes subagent lines (their own stops are not the goal's).
 */
export function nextGoal(
  current: GoalTrack | null,
  rec: Record<string, unknown>,
  now: number,
): GoalTrack | null | undefined {
  const type = text(rec.type);
  if (type === "assistant") {
    const said = messageText(rec).trim();
    if (synthetic(rec)) {
      if (said.startsWith("Goal set: "))
        return { objective: said.slice("Goal set: ".length).trim(), checks: 0, status: "active", setAt: now };
      const active = ACTIVE.exec(said);
      if (active)
        return {
          ...(current?.objective === active[1].trim() ? current : { setAt: now }),
          objective: active[1].trim(),
          checks: Math.max(current?.objective === active[1].trim() ? current.checks : 0, Number(active[2] ?? 0)),
          ...(active[3] ? { lastCheck: active[3].trim() } : {}),
          status: current?.clearing ? "stopped" : "active",
          pendingCheck: false,
        };
      if (said.startsWith("Goal cleared: ") || said.startsWith("No goal set"))
        return current ? { ...current, status: current.clearing ? "stopped" : "cleared", pendingCheck: false } : null;
      return undefined;
    }
    // Claude spoke while a goal is set: the stop that ends this message gets checked.
    if (current && (current.status === "active" || current.status === "paused") && !current.pendingCheck)
      return { ...current, status: "active", pendingCheck: true };
    return undefined;
  }
  if (type === "user" && current && rec.isSynthetic === true) {
    const said = messageText(rec);
    const head = `Stop hook feedback:\n[${current.objective}]: `;
    const at = said.indexOf(head);
    if (at < 0) return undefined;
    const reason = said.slice(at + head.length).split("\n[")[0].trim();
    return { ...current, checks: current.checks + 1, lastCheck: reason || current.lastCheck, pendingCheck: false };
  }
  if (type === "system" && current) {
    const said = text(rec.content) || text(rec.text);
    if (/^A hook blocked the turn from ending \d+ consecutive times/.test(said) && current.status === "active")
      return { ...current, status: "paused", pendingCheck: false };
    if (said.startsWith("Goal cleared after an unrecoverable error"))
      return { ...current, status: "cleared", lastCheck: said, pendingCheck: false };
    return undefined;
  }
  if (type === "result" && current?.status === "active" && current.pendingCheck) {
    // A failed or cut turn never reached the check.
    if (rec.is_error === true || text(rec.subtype) !== "success") return { ...current, pendingCheck: false };
    // A zero-turn result (a /compact, `/goal`, `/goal clear`) ran no model turn, so no stop was checked in it.
    if (typeof rec.num_turns !== "number" || rec.num_turns <= 0) return undefined;
    // A stop that wasn't sent back: the evaluator passed it, and the CLI cleared the goal itself.
    return { ...current, checks: current.checks + 1, status: "met", pendingCheck: false };
  }
  return undefined;
}

/** What the chat is told (the bookkeeping stays here). */
export function goalView(goal: GoalTrack | null): SessionGoal | null {
  if (!goal) return null;
  return {
    objective: goal.objective,
    checks: goal.checks,
    status: goal.status,
    setAt: goal.setAt,
    ...(goal.lastCheck ? { lastCheck: goal.lastCheck } : {}),
    ...(goal.providerSessionId ? { providerSessionId: goal.providerSessionId } : {}),
  };
}

/**
 * A goal the chat had saved, as the harness picks it back up after a restart: only one still open. Its conversation
 * decides the rest: resumed, Claude Code still has it (checks go on from the saved count); fresh, MonoCode sets it again.
 */
export function restoredGoal(goal: SessionGoal | null | undefined): GoalTrack | null {
  if (!goal || !goalOpen(goal) || !goal.objective.trim()) return null;
  return {
    objective: goal.objective,
    checks: Math.max(0, goal.checks),
    status: goal.status,
    setAt: goal.setAt,
    ...(goal.lastCheck ? { lastCheck: goal.lastCheck } : {}),
    ...(goal.providerSessionId ? { providerSessionId: goal.providerSessionId } : {}),
  };
}

/** The goal still asks Claude to keep going. */
export function goalOpen<T extends SessionGoal>(goal: T | null | undefined): goal is T {
  return !!goal && (goal.status === "active" || goal.status === "paused");
}
