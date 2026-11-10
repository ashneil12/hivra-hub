import { describe, expect, it } from "vitest";
import type { Habit } from "../../monos/model/monoHabits";
import { MORNING_HABIT_ID, ensureMorningHabit, morningHabit, withMorningHabit } from "./habit";

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

describe("morning habit", () => {
  it("is a daily habit, and a second add does not replace an edited one", () => {
    const created = morningHabit(1_700_000_000_000);
    expect(created.id).toBe(MORNING_HABIT_ID);
    expect(created.schedule.scheduleKind).toBe("daily");
    expect(created.schedule.time).toBe("08:00");
    expect(created.instructions).toContain("NOTHING_TO_REPORT");
    expect(created.instructions).toContain("app tasks.list");
    // The run is told the yesterday section exists and what its two states mean.
    expect(created.instructions).toContain("Finished yesterday");
    expect(created.instructions).toContain("Nothing finished yesterday.");
    expect(created.instructions).toMatch(/no such section[^.]*(not|could not)/i);

    const edited = habit({ id: MORNING_HABIT_ID, instructions: "The person rewrote this." });
    const next = withMorningHabit([habit(), edited], 5);
    expect(next).toHaveLength(2);
    expect(next.find((item) => item.id === MORNING_HABIT_ID)?.instructions).toBe("The person rewrote this.");
    expect(withMorningHabit([habit()], 5).map((item) => item.id)).toEqual(["other", MORNING_HABIT_ID]);
  });

  it("does not write when the morning habit is already there, and a timeout is not a new list", async () => {
    const edited = habit({ id: MORNING_HABIT_ID, instructions: "The person rewrote this." });
    const update = async () => {
      throw new Error("should not write");
    };
    await ensureMorningHabit("coord", async () => [edited], update, 5);
    let wrote = 0;
    await expect(ensureMorningHabit("coord", async () => [habit()], async (_id, change) => {
      wrote += 1;
      if (wrote === 1) throw new Error("timed out");
      change([habit()]);
      return undefined;
    }, 5)).rejects.toThrow("timed out");
    expect(wrote).toBe(1);
  });
});
