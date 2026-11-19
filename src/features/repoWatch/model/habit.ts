// WP-166: the repo watch is one weekly habit. Turning it on does not replace
// instructions the person edited. It stays off until they turn it on.

import { nextHabitRunAt, QUIET_MARKER, type Habit } from "../../monos/model/monoHabits";

export const REPO_WATCH_HABIT_ID = "repo-watch";

const INSTRUCTIONS = `Compare this project's pinned upstream repositories and write the changes summary.
Do not print tokens, keys or home folder paths.
If every repository was checked and nothing changed, reply with exactly ${QUIET_MARKER}.`;

/** Monday at 09:00. dayOfWeek 0 is Sunday. */
export function repoWatchHabit(now: number): Habit {
  const schedule = { scheduleKind: "weekly" as const, time: "09:00", minute: 0, dayOfWeek: 1 };
  return {
    id: REPO_WATCH_HABIT_ID,
    name: "Repo watch",
    instructions: INSTRUCTIONS,
    schedule,
    enabled: true,
    createdAt: now,
    nextRunAt: nextHabitRunAt(schedule, now),
  };
}

/** Add the habit when it is missing. An existing one is left as it is, edited or not. */
export function withRepoWatchHabit(habits: readonly Habit[], now: number): Habit[] {
  if (habits.some((habit) => habit.id === REPO_WATCH_HABIT_ID)) return [...habits];
  return [...habits, repoWatchHabit(now)];
}

/**
 * Turn the watch on or off. Off keeps the habit. On adds it only when it is
 * missing, and never replaces instructions.
 */
export function setRepoWatchEnabled(habits: readonly Habit[], enabled: boolean, now: number): Habit[] {
  const existing = habits.some((habit) => habit.id === REPO_WATCH_HABIT_ID);
  if (!existing) return enabled ? withRepoWatchHabit(habits, now) : [...habits];
  return habits.map((habit) => (habit.id === REPO_WATCH_HABIT_ID ? { ...habit, enabled } : habit));
}
