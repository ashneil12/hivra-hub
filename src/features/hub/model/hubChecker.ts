// The Checker (docs/PHASE-2-DESIGN.md, H6): one small Mono on Haiku. Since 21 Oct the app's light look after each dump
// (dumpCheck.ts, useHubChecks.ts) does the checking; its old hourly audit of Ash OS's queue is paused. A finding reaches
// the chat owning the message privately (hubChecks.ts delivers it as a `[MonoCode check]` turn), and the owner, who has
// the full context, answers right or fixed.
//
// It never starts work, three ways over:
// - the app lane (agentApp.ts): it and its habit runs get only models.list, memory and soul.read;
// - its tool list (hubMcp.ts): ash-os as role `checker` (Ash OS's lane: reads plus its two calls), no delegate tool, and
//   in Claude Code only Bash (for that app CLI) and reading, with no subagents or edits;
// - no delegation: tasks.* refuses it (agentAppTasks.ts) and its context never teaches the delegate tool.
// It never nags: Ash never hears from it (its runs end quiet), and Ash OS holds one open check per message, no repeats
// after two "right" answers and at most three new checks per chat a day.
import { addMono, findMono } from "../../monos/model/mono";
import { updateHabits } from "../../monos/model/monoHabits";
import type { AgentModel } from "../../sessions/model/models";
import { modelsFor } from "../../sessions/model/models";
import { isMonoRemovedByUser } from "./builtInMonos";
import { CHECKER_MONO_ID } from "./hubMcp";

export { CHECKER_MONO_ID };
export const CHECKER_NAME = "Checker";

/** Its standing instructions, seeded once into SOUL.md (Ash edits it from there). */
export const CHECKER_SOUL = `You are the Checker, a small agent on Haiku. Ash talks to his chats, and each chat owns what he says to it: it writes his asks down, delegates them and closes them with evidence. You compare his messages with that record, and when something looks missed you quietly ask the chat that owns it: "I noticed this. Is this right?" That chat has the full context and answers: right (because Ash said ...) or fixed.

- Precise. Say exactly what you noticed, with Ash's own words and the ask ids. Never a guess dressed up as a fact.
- You never start work. No sessions, no delegations, nothing recorded, moved or closed. You read, and you leave notes.
- You never nag. One note per message. When a chat says it was right, it was right. Ash doesn't hear from you; your notes go only to the chat that owns the message.
`;

/** The hourly audit it used to run (retired 21 Oct: the light look after each dump replaced it, dumpCheck.ts). */
export const CHECKER_HABIT_ID = "checker-hourly";

/** Haiku: Haiku 5.5 when Claude Code lists it, otherwise its own `haiku` alias (the newest Haiku it has). */
export function checkerModel(models: readonly AgentModel[] = modelsFor("claude")): string {
  const listed = models.find((model) => /haiku[-.]5[-.]5/i.test(`${model.nativeId ?? ""} ${model.id}`));
  return listed?.id ?? "claude:haiku";
}

/** The roster entry it starts as: no projects (it reads Ash OS, not folders), Claude Code on Haiku. */
export function checkerRosterEntry(models?: readonly AgentModel[]) {
  return {
    id: CHECKER_MONO_ID,
    name: CHECKER_NAME,
    mascot: "robot",
    color: "hsl(210 6% 50%)",
    projects: [] as string[],
    engine: "claude",
    engineModel: checkerModel(models),
    instructions: CHECKER_SOUL,
  };
}

/**
 * The Hub bundle's checker: made when missing (never over Ash's "remove"). Its old hourly audit is paused where it was
 * given (Ash, 21 Oct: a light look after each dump instead, useHubChecks.ts). Returns what it did.
 */
export async function ensureChecker(
  deps: {
    add?: typeof addMono;
    find?: typeof findMono;
    removed?: (id: string) => boolean;
    habits?: typeof updateHabits;
  } = {},
): Promise<{ created: boolean; paused: boolean }> {
  const { add = addMono, find = findMono, removed = isMonoRemovedByUser, habits = updateHabits } = deps;
  if (removed(CHECKER_MONO_ID)) return { created: false, paused: false };
  const created = find(CHECKER_MONO_ID) ? false : add(checkerRosterEntry());
  if (created || !find(CHECKER_MONO_ID)) return { created, paused: false };
  const paused = await habits(CHECKER_MONO_ID, (list) =>
    list.some((entry) => entry.id === CHECKER_HABIT_ID && entry.enabled)
      ? { habits: list.map((entry) => (entry.id === CHECKER_HABIT_ID ? { ...entry, enabled: false } : entry)), result: true }
      : { habits: list, result: false },
  );
  return { created, paused };
}
