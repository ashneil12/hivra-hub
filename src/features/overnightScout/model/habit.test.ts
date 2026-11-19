import { describe, expect, it } from "vitest";
import type { Habit } from "../../monos/model/monoHabits";
import { SCOUT_HABIT_ID, scoutHabit, syncScoutHabit, withScoutHabit } from "./habit";
import { SCOUT_DEFAULTS, type ScoutSettings } from "./settings";

function habit(over: Partial<Habit> = {}): Habit {
  return {
    id: "other",
    name: "Other",
    instructions: "Leave this.",
    schedule: { scheduleKind: "daily", time: "09:00", minute: 0, dayOfWeek: 0 },
    enabled: true,
    createdAt: 1,
    nextRunAt: 2,
    ...over,
  };
}

const on: ScoutSettings = { ...SCOUT_DEFAULTS, enabled: true, time: "23:00", maxDrafts: 3 };

describe("overnight scout habit", () => {
  it("stays missing while the setting is off", () => {
    const habits = [habit()];
    expect(withScoutHabit(habits, SCOUT_DEFAULTS, 5).map((item) => item.id)).toEqual(["other"]);
    expect(scoutHabit(SCOUT_DEFAULTS, 5).enabled).toBe(false);
    expect(scoutHabit(on, 5).schedule).toMatchObject({ scheduleKind: "daily", time: "23:00" });
    expect(scoutHabit(on, 5).instructions).toContain("NOTHING_TO_REPORT");
    expect(scoutHabit(on, 5).instructions).toContain("does not call a model");
  });

  it("adds one daily habit when turned on, and does not touch the others", () => {
    const next = withScoutHabit([habit()], on, 5);
    expect(next.map((item) => item.id)).toEqual(["other", SCOUT_HABIT_ID]);
    expect(next[0]).toEqual(habit());
    const again = withScoutHabit(next, on, 9);
    expect(again.filter((item) => item.id === SCOUT_HABIT_ID)).toHaveLength(1);
    expect(again[0]).toEqual(habit());
  });

  it("pauses an existing scout habit when turned off, and follows a new time when turned on", () => {
    const scout = scoutHabit(on, 5);
    const paused = withScoutHabit([habit(), scout], SCOUT_DEFAULTS, 8);
    expect(paused.find((item) => item.id === SCOUT_HABIT_ID)?.enabled).toBe(false);
    expect(paused.find((item) => item.id === "other")?.enabled).toBe(true);
    const moved = withScoutHabit(paused, { ...on, time: "22:10" }, 9);
    const updated = moved.find((item) => item.id === SCOUT_HABIT_ID);
    expect(updated?.enabled).toBe(true);
    expect(updated?.schedule.time).toBe("22:10");
    expect(updated?.createdAt).toBe(scout.createdAt);
  });

  it("does not write when the habit already matches, and a timeout is not a new list", async () => {
    let writes = 0;
    const update = async (_id: string, change: (habits: Habit[]) => { habits: Habit[]; result: undefined }) => {
      writes += 1;
      change([habit()]);
      return undefined;
    };
    await syncScoutHabit("coord", async () => [habit()], update, async () => SCOUT_DEFAULTS, 5);
    expect(writes).toBe(0);

    await expect(
      syncScoutHabit(
        "coord",
        async () => [habit()],
        async () => {
          writes += 1;
          throw new Error("timed out");
        },
        async () => on,
        5,
      ),
    ).rejects.toThrow("timed out");
    expect(writes).toBe(1);

    await expect(
      syncScoutHabit(
        "coord",
        async () => {
          throw new Error("timed out");
        },
        update,
        async () => on,
        5,
      ),
    ).rejects.toThrow("timed out");
  });

  it("applies the setting to the list read at write time, not an older copy", async () => {
    const first = [habit()];
    const latest = [habit({ id: "added", name: "Added" })];
    let seen: Habit[] = [];
    await syncScoutHabit(
      "coord",
      async () => first,
      async (_id, change) => {
        seen = change(latest).habits;
        return undefined;
      },
      async () => on,
      5,
    );
    expect(seen.map((item) => item.id)).toEqual(["added", SCOUT_HABIT_ID]);
  });
});
