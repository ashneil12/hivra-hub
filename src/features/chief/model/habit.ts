// WP-88: the morning note is one habit. Adding it again does not replace a habit the person edited.
// WP-164: the stock text also reads the programme queue and the work log. Edited text stays as it is.

import { nextHabitRunAt, type Habit } from "../../monos/model/monoHabits";

export const MORNING_HABIT_ID = "chief-morning";

/** The morning habit text from before the programme lines. An exact match is still stock. */
export const MORNING_HABIT_STOCK_INSTRUCTIONS = `Read this copy's projects with app tasks.list, app docs.list and app activity.list.
Reply with one line per thing worth saying. Each line names something you read, as task:ID, doc:ID or chat:ID, then a few words.
Do not mention an id you did not read. If nothing is worth saying, reply with exactly NOTHING_TO_REPORT.`;

const INSTRUCTIONS = `${MORNING_HABIT_STOCK_INSTRUCTIONS}
Also read the programme queue and the work log summary when they are there. Prefer an outcome line from the work log over a status line.`;

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

function isMorningStock(habit: Habit): boolean {
  return habit.id === MORNING_HABIT_ID && habit.instructions === MORNING_HABIT_STOCK_INSTRUCTIONS;
}

/**
 * Add the morning habit when it is missing. Stock instructions gain the programme
 * lines. Any other text, even one extra character, is left alone, and so is the
 * name and the schedule.
 */
export function withMorningHabit(habits: readonly Habit[], now: number): Habit[] {
  if (!habits.some((habit) => habit.id === MORNING_HABIT_ID)) return [...habits, morningHabit(now)];
  return habits.map((habit) =>
    isMorningStock(habit) ? { ...habit, instructions: INSTRUCTIONS } : habit,
  );
}

/**
 * Add the morning habit when it is missing, or extend it when the text is still stock.
 * Edited text is left as it is. A write that times out throws, so the caller keeps the list it already had.
 */
export async function ensureMorningHabit(
  monoId: string,
  load: (id: string) => Promise<readonly Habit[]>,
  update: (id: string, change: (habits: Habit[]) => { habits: Habit[]; result: undefined }) => Promise<undefined>,
  now: number,
): Promise<void> {
  const current = await load(monoId);
  const missing = !current.some((habit) => habit.id === MORNING_HABIT_ID);
  const stock = current.some(isMorningStock);
  if (!missing && !stock) return;
  // The callback sees the list at write time, so an edit that landed since the load is kept.
  await update(monoId, (habits) => ({ habits: withMorningHabit(habits, now), result: undefined }));
}
