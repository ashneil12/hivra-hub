// The Checker (docs/PHASE-2-DESIGN.md, H6): one small Mono, on whatever model the runtime gives it (grok-4.7 on the Grok
// bridge). Since 21 Oct it runs once after each dump (dumpCheck.ts, useHubChecks.ts) and never on a schedule: its old
// hourly audit (`checker-hourly`) is never given, and switched off where an older install has it. A finding reaches
// the chat owning the message privately (hubChecks.ts delivers it as a `[MonoCode check]` turn), and the owner, who has
// the full context, answers right or fixed.
//
// It never starts work, three ways over:
// - the app lane (agentApp.ts): it and its habit runs get only models.list, memory and soul.read;
// - its tool list (hubMcp.ts): reads only, no delegate tool, and
//   in Claude Code only Bash (for that app CLI) and reading, with no subagents or edits;
// - no delegation: tasks.* refuses it (agentAppTasks.ts) and its context never teaches the delegate tool.
// It never nags: Ash never hears from it (its runs end quiet), and Ash OS holds one open check per message, no repeats
// after two "right" answers and at most three new checks per chat a day.
import { MONO_BRIDGE_MODEL_ID } from "../../sessions/model/bridgeModels";
import { addMono, findMono } from "../../monos/model/mono";
import { updateHabits } from "../../monos/model/monoHabits";
import { isMonoRemovedByUser } from "./builtInMonos";
import { CHECKER_MONO_ID } from "./hubMcp";
import { forUser } from "./userName";

export { CHECKER_MONO_ID };
export const CHECKER_NAME = "Checker";

/** Its standing instructions, seeded once into SOUL.md (Ash edits it from there): Alfred's slim soul, 21 Oct. */
export const CHECKER_SOUL = `# Soul

## Role
After Ash sends a dump, I take one quick look to see whether anything he asked for got missed.

## Who I am
I'm the Checker. I read what Ash said and what the chats did about it. If something looks dropped, I send one private note to whoever's in charge of that chat, quoting his words, and ask whether it's right. They have the full picture, so if they say it's fine, it's fine.

## What I watch for
Asks that nobody picked up, and work that got called done with nothing to show for it.

## Limits
I never start work, message Ash, or move or close anything. One note per dump at most, and none when nothing's missed.
`;

/** The hourly audit it used to run (retired 21 Oct: the light look after each dump replaced it, dumpCheck.ts). */
export const CHECKER_HABIT_ID = "checker-hourly";

/** The roster entry it starts as: no projects (it reads, not folders), Claude Code on Grok 4.7, named (bridgeModels.ts). */
export function checkerRosterEntry() {
  return {
    id: CHECKER_MONO_ID,
    name: CHECKER_NAME,
    mascot: "robot",
    color: "hsl(210 6% 50%)",
    projects: [] as string[],
    engine: "claude",
    engineModel: MONO_BRIDGE_MODEL_ID,
    instructions: forUser(CHECKER_SOUL),
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
