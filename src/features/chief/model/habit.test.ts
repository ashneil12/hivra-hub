import { describe, expect, it } from "vitest";
import { appActions } from "../../agent-app/model/agentApp";
import type { Habit } from "../../monos/model/monoHabits";
import { NOTHING_ON_PROGRAMME } from "../../programme/model/morningProgramme";
import {
  MORNING_HABIT_ID,
  MORNING_HABIT_STOCK_INSTRUCTIONS,
  ensureMorningHabit,
  morningHabit,
  withMorningHabit,
} from "./habit";

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
    expect(created.instructions).toContain("notable events still waiting");

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

  it("extends stock instructions and leaves a person's text, name, and schedule alone", () => {
    const stock = habit({
      id: MORNING_HABIT_ID,
      name: "Dawn",
      enabled: false,
      instructions: MORNING_HABIT_STOCK_INSTRUCTIONS,
      schedule: { scheduleKind: "daily", time: "09:30", minute: 0, dayOfWeek: 0 },
    });
    const next = withMorningHabit([stock], 5);
    expect(next).toHaveLength(1);
    expect(next[0].instructions).toContain("notable events still waiting");
    expect(next[0].instructions).not.toBe(MORNING_HABIT_STOCK_INSTRUCTIONS);
    expect(next[0].name).toBe("Dawn");
    expect(next[0].enabled).toBe(false);
    expect(next[0].schedule.time).toBe("09:30");
    expect(next[0].id).toBe(MORNING_HABIT_ID);

    const tweaked = `${MORNING_HABIT_STOCK_INSTRUCTIONS} `;
    const kept = withMorningHabit(
      [habit({ id: MORNING_HABIT_ID, instructions: tweaked })],
      5,
    );
    expect(kept[0].instructions).toBe(tweaked);
    expect(
      withMorningHabit([habit({ id: MORNING_HABIT_ID, instructions: "" })], 5)[0].instructions,
    ).toBe("");

    const edited = habit({ id: MORNING_HABIT_ID, instructions: "The person rewrote this." });
    const both = withMorningHabit([stock, edited], 5);
    expect(both[0].instructions).toContain("notable events still waiting");
    expect(both[1].instructions).toBe("The person rewrote this.");
  });

  it("writes the notable-event line onto stock text, and a newer edit wins", async () => {
    const stock = habit({
      id: MORNING_HABIT_ID,
      instructions: MORNING_HABIT_STOCK_INSTRUCTIONS,
    });
    let written = "";
    await ensureMorningHabit("coord", async () => [stock], async (_id, change) => {
      written = change([stock]).habits[0].instructions;
      return undefined;
    }, 5);
    expect(written).toContain("notable events still waiting");

    await ensureMorningHabit("coord", async () => [morningHabit(1)], async () => {
      throw new Error("should not write");
    }, 5);

    await ensureMorningHabit("coord", async () => [stock], async (_id, change) => {
      const edited = [habit({ id: MORNING_HABIT_ID, instructions: "The person rewrote this." })];
      expect(change(edited).habits[0].instructions).toBe("The person rewrote this.");
      return undefined;
    }, 5);

    let writes = 0;
    await expect(ensureMorningHabit("coord", async () => [stock], async () => {
      writes += 1;
      throw new Error("timed out");
    }, 5)).rejects.toThrow("timed out");
    expect(writes).toBe(1);
  });

  it("names only sources this app has", () => {
    const text = morningHabit(1).instructions;
    // The first draft of this package named a programme queue that was not built yet, and a work log. Both exist now
    // (WP-159, WP-157), but a habit run is refused by both tools (programme.test.ts, agentAppWorkLog.test.ts). The
    // app reads them for the run instead, so the text names the sections the app adds, never a tool to call.
    expect(text).not.toMatch(/work.?log|programme queue|app programme\.|programme_/i);
    const named = [...text.matchAll(/\bapp ([a-z]+\.[a-z]+)/g)].map((match) => match[1]);
    expect(named).toEqual(["tasks.list", "docs.list", "activity.list"]);
    for (const action of named) expect(appActions()).toContain(action);
  });

  it("tells the run what the programme section is and what its two states mean", () => {
    const text = morningHabit(1).instructions;
    expect(text).toContain('A section headed "Programme" may follow');
    expect(text).toContain(NOTHING_ON_PROGRAMME);
    expect(text).toMatch(/no such section, the app could not look, so say nothing about the programme/i);
  });

  it("brings text the app wrote before up to date, and still leaves an edit alone", () => {
    const earlier = [
      `${MORNING_HABIT_STOCK_INSTRUCTIONS}
Also read the programme queue and the work log summary when they are there. Prefer an outcome line from the work log over a status line.`,
      `${MORNING_HABIT_STOCK_INSTRUCTIONS}
If a list of notable events still waiting follows, each one is worth saying: give it a plain line of its own, with no id, that says what happened.`,
      `${MORNING_HABIT_STOCK_INSTRUCTIONS}
If a list of notable events still waiting follows, each one is worth saying: give it a plain line of its own, with no id, that says what happened.
A section headed "Finished yesterday" may follow: what finished yesterday, newest first, which the app read for you. Each is worth saying: give it a plain line of its own, with no id, that says what finished. "Nothing finished yesterday." means the app looked and nothing finished. If there is no such section, the app could not look, so say nothing about yesterday.`,
    ];
    for (const instructions of earlier) {
      const next = withMorningHabit([habit({ id: MORNING_HABIT_ID, instructions })], 5);
      expect(next[0].instructions).toBe(morningHabit(1).instructions);
      const tweaked = withMorningHabit([habit({ id: MORNING_HABIT_ID, instructions: `${instructions}!` })], 5);
      expect(tweaked[0].instructions).toBe(`${instructions}!`);
    }
  });
});
