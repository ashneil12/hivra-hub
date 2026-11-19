// WP-165: one daily habit. Off until the setting says on. It never replaces another habit.

import { nextHabitRunAt, type Habit } from "../../monos/model/monoHabits";
import { parseScoutSettings, type ScoutSettings } from "./settings";

export const SCOUT_HABIT_ID = "overnight-scout";

const INSTRUCTIONS = `This habit does not call a model.
The app writes draft packages itself, and only when the overnight scout is on.
Reply with exactly NOTHING_TO_REPORT.`;

export function scoutHabit(settings: ScoutSettings, now: number): Habit {
  const schedule = { scheduleKind: "daily" as const, time: settings.time, minute: 0, dayOfWeek: 0 };
  return {
    id: SCOUT_HABIT_ID,
    name: "Overnight scout",
    instructions: INSTRUCTIONS,
    schedule,
    enabled: settings.enabled === true,
    createdAt: now,
    nextRunAt: nextHabitRunAt(schedule, now),
  };
}

function sameScout(left: Habit, right: Habit): boolean {
  return (
    left.enabled === right.enabled &&
    left.schedule.time === right.schedule.time &&
    left.schedule.scheduleKind === right.schedule.scheduleKind &&
    left.instructions === right.instructions &&
    left.name === right.name
  );
}

/**
 * The scout habit follows the setting. Off, and missing, stays missing.
 * Off, and present, is paused. On adds it, or turns the existing one back on.
 * Every other habit is copied through unchanged.
 */
export function withScoutHabit(habits: readonly Habit[], settings: ScoutSettings, now: number): Habit[] {
  const parsed = parseScoutSettings(settings);
  const current = habits.find((habit) => habit.id === SCOUT_HABIT_ID);
  const rest = habits.filter((habit) => habit.id !== SCOUT_HABIT_ID);
  if (!parsed.enabled) {
    if (!current || current.enabled === false) return [...habits];
    return habits.map((habit) => (habit.id === SCOUT_HABIT_ID ? { ...habit, enabled: false } : habit));
  }
  const next = scoutHabit(parsed, current?.createdAt ?? now);
  if (!current) return [...rest, { ...next, nextRunAt: nextHabitRunAt(next.schedule, now) }];
  const kept = { ...current, ...next, createdAt: current.createdAt, nextRunAt: current.nextRunAt };
  if (current.schedule.time !== parsed.time || current.enabled !== true) {
    kept.nextRunAt = nextHabitRunAt(kept.schedule, now);
  }
  if (sameScout(current, kept) && current.nextRunAt === kept.nextRunAt) return [...habits];
  return habits.map((habit) => (habit.id === SCOUT_HABIT_ID ? kept : habit));
}

export type HabitUpdate = (
  id: string,
  change: (habits: Habit[]) => { habits: Habit[]; result: undefined },
) => Promise<undefined>;

/**
 * Make the habit match the setting. A read or a write that does not land throws,
 * so the caller keeps the list it already had.
 */
function habitSnapshot(habits: readonly Habit[]): string {
  return JSON.stringify(
    habits.map((habit) => ({
      id: habit.id,
      name: habit.name,
      enabled: habit.enabled,
      time: habit.schedule.time,
      kind: habit.schedule.scheduleKind,
      instructions: habit.instructions,
    })),
  );
}

export async function syncScoutHabit(
  monoId: string,
  load: (id: string) => Promise<readonly Habit[]>,
  update: HabitUpdate,
  readSettings: () => Promise<ScoutSettings>,
  now: number,
): Promise<void> {
  const settings = parseScoutSettings(await readSettings());
  const current = await load(monoId);
  if (habitSnapshot(current) === habitSnapshot(withScoutHabit(current, settings, now))) return;
  // The update reads again and retries on a conflict, so the change is applied to that later list.
  await update(monoId, (latest) => ({ habits: withScoutHabit(latest, settings, now), result: undefined }));
}
