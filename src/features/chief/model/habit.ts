// WP-88: the morning note is one habit. Adding it again does not replace a habit the person edited.

import { nextHabitRunAt, type Habit } from "../../monos/model/monoHabits";

export const MORNING_HABIT_ID = "chief-morning";

const INSTRUCTIONS = `Read this copy's projects with app tasks.list, app docs.list and app activity.list.
Reply with one line per thing worth saying. Each line names something you read, as task:ID, doc:ID or chat:ID, then a few words.
Do not mention an id you did not read. If nothing is worth saying, reply with exactly NOTHING_TO_REPORT.
A section headed "Finished yesterday" may follow: the work log's outcome lines from yesterday, newest first, which the app read for you. Each is worth saying: give it a plain line of its own, with no id, that says what finished. "Nothing finished yesterday." means the log was read and has nothing from yesterday. If there is no such section, you were not given the log, so say nothing about yesterday.`;

/** The morning habit, first due after `now`. The id stays put so a second add can see it. */
export function morningHabit(now: number): Habit {
  const schedule = { scheduleKind: "daily" as const, time: "08:00", minute: 0, dayOfWeek: 0 };
  return {
    id: MORNING_HABIT_ID,
    name: "Morning",
    instructions: INSTRUCTIONS,
    schedule,
    enabled: true,
    createdAt: now,
    nextRunAt: nextHabitRunAt(schedule, now),
  };
}

/** Leave an existing morning habit alone, including one whose instructions were edited. */
export function withMorningHabit(habits: readonly Habit[], now: number): Habit[] {
  if (habits.some((habit) => habit.id === MORNING_HABIT_ID)) return [...habits];
  return [...habits, morningHabit(now)];
}

/**
 * Add the morning habit when it is missing. A habit already there, edited or not, is left as it is.
 * A write that times out throws, so the caller keeps the list it already had.
 */
export async function ensureMorningHabit(
  monoId: string,
  load: (id: string) => Promise<readonly Habit[]>,
  update: (id: string, change: (habits: Habit[]) => { habits: Habit[]; result: undefined }) => Promise<undefined>,
  now: number,
): Promise<void> {
  const current = await load(monoId);
  if (current.some((habit) => habit.id === MORNING_HABIT_ID)) return;
  await update(monoId, (habits) => ({ habits: withMorningHabit(habits, now), result: undefined }));
}
