// The Checker (docs/PHASE-2-DESIGN.md, H6): one small Mono on Haiku with an hourly habit. It reads Ash's messages that
// Ash OS's fixed rules flag (`ash_checker_queue`: nothing written down after 30 minutes, an open ask idle 6 hours with
// nothing carrying it, a failed delegation with no follow-up in 2 hours, done without evidence) and leaves one note per
// message (`ash_checker_note`): ok, or a finding that Ash OS hands to the chat owning the message, privately
// (hubChecks.ts delivers it as a `[MonoCode check]` turn). The owner, who has the full context, answers right or fixed.
//
// It never starts work, three ways over:
// - the app lane (agentApp.ts): it and its habit runs get only models.list, memory and soul.read;
// - its tool list (hubMcp.ts): ash-os as role `checker` (Ash OS's lane: reads plus its two calls), no delegate tool, and
//   in Claude Code only Bash (for that app CLI) and reading, with no subagents or edits;
// - no delegation: tasks.* refuses it (agentAppTasks.ts) and its context never teaches the delegate tool.
// It never nags: Ash never hears from it (its runs end quiet), and Ash OS holds one open check per message, no repeats
// after two "right" answers and at most three new checks per chat a day.
import { addMono, findMono } from "../../monos/model/mono";
import { updateHabits, nextHabitRunAt, type Habit, type HabitSchedule } from "../../monos/model/monoHabits";
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

export const CHECKER_HABIT_ID = "checker-hourly";
export const CHECKER_HABIT_NAME = "Check Ash's messages";
/** Hourly, at a quiet minute past the hour. */
export const CHECKER_SCHEDULE: HabitSchedule = { scheduleKind: "hourly", minute: 23, time: "09:00", dayOfWeek: 1 };
export const CHECKER_HABIT_INSTRUCTIONS = `Call ash_checker_queue (hours 48, limit 15). For each message it returns, decide from Ash's own words, the asks, their evidence and delegations, and why it was flagged, then leave exactly one note with ash_checker_note: ok when it was handled, or a finding for the chat that owns it ("I noticed ... Is this right?") with the ask ids it is about. Do nothing else: never start, message or delegate to a session, never record, move or close an ask. If the queue is empty or a call fails, stop there.
Your notes reach the owning chats privately, never Ash, so always reply with exactly NOTHING_TO_REPORT.`;

/** Haiku: Haiku 5.5 when Claude Code lists it, otherwise its own `haiku` alias (the newest Haiku it has). */
export function checkerModel(models: readonly AgentModel[] = modelsFor("claude")): string {
  const listed = models.find((model) => /haiku[-.]5[-.]5/i.test(`${model.nativeId ?? ""} ${model.id}`));
  return listed?.id ?? "claude:haiku";
}

export function checkerHabit(now: number): Habit {
  return {
    id: CHECKER_HABIT_ID,
    name: CHECKER_HABIT_NAME,
    instructions: CHECKER_HABIT_INSTRUCTIONS,
    schedule: CHECKER_SCHEDULE,
    enabled: true,
    createdAt: now,
    nextRunAt: nextHabitRunAt(CHECKER_SCHEDULE, now),
  };
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

/** Set once its habit was given; if Ash removes or pauses it afterwards, that stays. */
const HABIT_SEEDED_KEY = "monocode:hub-checker-habit-seeded";

function habitSeeded(): boolean {
  try {
    return localStorage.getItem(HABIT_SEEDED_KEY) === "1";
  } catch {
    return true;
  }
}

/**
 * The Hub bundle's checker: made when missing (never over Ash's "remove"), with its hourly habit given once. Its chat
 * is opened by the app (useHubChecks.ts), since a habit runs only for a Mono whose chat exists. Returns what it did.
 */
export async function ensureChecker(
  deps: {
    add?: typeof addMono;
    find?: typeof findMono;
    removed?: (id: string) => boolean;
    habits?: typeof updateHabits;
    now?: () => number;
  } = {},
): Promise<{ created: boolean; habit: boolean }> {
  const { add = addMono, find = findMono, removed = isMonoRemovedByUser, habits = updateHabits, now = Date.now } = deps;
  if (removed(CHECKER_MONO_ID)) return { created: false, habit: false };
  const created = find(CHECKER_MONO_ID) ? false : add(checkerRosterEntry());
  if (habitSeeded() || !find(CHECKER_MONO_ID)) return { created, habit: false };
  const habit = await habits(CHECKER_MONO_ID, (list) =>
    list.some((entry) => entry.id === CHECKER_HABIT_ID)
      ? { habits: list, result: false }
      : { habits: [...list, checkerHabit(now())], result: true },
  );
  try {
    localStorage.setItem(HABIT_SEEDED_KEY, "1");
  } catch {
    /* storage unavailable: the next launch finds the habit there and adds nothing */
  }
  return { created, habit };
}
