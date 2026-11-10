// WP-88: the morning note is one habit. Adding it again does not replace a habit the person edited.
// WP-164: the stock text also says what to do with the notable events that wait (notifications/model/notableEvents.ts).
// Edited text stays as it is.

import { nextHabitRunAt, type Habit } from "../../monos/model/monoHabits";

export const MORNING_HABIT_ID = "chief-morning";

/** The morning habit text from before the notable-event lines. An exact match is still stock. */
export const MORNING_HABIT_STOCK_INSTRUCTIONS = `Read this copy's projects with app tasks.list, app docs.list and app activity.list.
Reply with one line per thing worth saying. Each line names something you read, as task:ID, doc:ID or chat:ID, then a few words.
Do not mention an id you did not read. If nothing is worth saying, reply with exactly NOTHING_TO_REPORT.`;

/**
 * What the extra text means, for a run that gets one (useMonoHabits adds the waiting events after these lines). It
 * names only things this app has: the list that follows the instructions, and no source that is not built.
 */
const INSTRUCTIONS = `${MORNING_HABIT_STOCK_INSTRUCTIONS}
If a list of notable events still waiting follows, each one is worth saying: give it a plain line of its own, with no id, that says what happened.
A section headed "Finished yesterday" may follow: what finished yesterday, newest first, which the app read for you. Each is worth saying: give it a plain line of its own, with no id, that says what finished. "Nothing finished yesterday." means the app looked and nothing finished. If there is no such section, the app could not look, so say nothing about yesterday.`;

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
 * Add the morning habit when it is missing. Stock instructions gain the notable-event
 * line. Any other text, even one extra character, is left alone, and so is the
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
