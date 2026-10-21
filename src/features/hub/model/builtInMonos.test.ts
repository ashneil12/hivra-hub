// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { clearMonoRemovedByUser, ensureBuiltInMonos, isDefaultTeamMono, markMonoRemovedByUser } from "./builtInMonos";
import { removeMono } from "../../monos/model/mono";

const roster = () => (JSON.parse(localStorage.getItem("monocode:mono-roster") ?? "[]") as { id: string; name: string }[]);
const LEADS = [
  { id: "vg-game-lead", name: "EXO lead" }, { id: "hivra-lead", name: "Hivra lead" },
  { id: "nibbii-lead", name: "Nibbii lead" }, { id: "ash-lead", name: "Harness lead" },
].map((m) => ({ ...m, mascot: "robot", color: "x", projects: [] }));
const TEAM = ["Chief of Staff", "Projects Manager", "frank", "Alfred"];

beforeEach(() => localStorage.clear());

describe("the default team, added once", () => {
  it("a clean launch gets the whole leadership team, Critiquito included (Ash 21 Oct)", () => {
    expect(ensureBuiltInMonos()).toBe(5);
    expect(roster().map((m) => m.name)).toEqual([...TEAM, "Critiquito"]);
  });

  it("existing data with only the 4 Leads (even after the old seed step ran) gets the team on top, Leads kept below", () => {
    localStorage.setItem("monocode:mono-roster", JSON.stringify(LEADS));
    localStorage.setItem("monocode:mono-team-seeded", "1");
    expect(ensureBuiltInMonos()).toBe(4);
    expect(roster().map((m) => m.name)).toEqual([...TEAM, "EXO lead", "Hivra lead", "Nibbii lead", "Harness lead"]);
    expect(roster().some((m) => /critiquito/i.test(m.name))).toBe(false);
  });

  it("a roster that already has some of the team gets only the missing ones, matched by id or name", () => {
    localStorage.setItem("monocode:mono-roster", JSON.stringify([
      ...LEADS,
      { id: "frank", name: "Frank the EA", mascot: "robot", color: "x", projects: [] }, // same id
      { id: "cos-old", name: "chief of staff", mascot: "robot", color: "x", projects: [] }, // same name
    ]));
    expect(ensureBuiltInMonos()).toBe(2);
    const names = roster().map((m) => m.name);
    expect(names.slice(0, 2)).toEqual(["Projects Manager", "Alfred"]);
    expect(roster().filter((m) => m.id === "frank")).toHaveLength(1);
    expect(names.filter((n) => n.toLowerCase() === "chief of staff")).toHaveLength(1);
    expect(roster()).toHaveLength(8);
  });

  it("after the old step seeded a clean launch and Ash emptied it, it stays empty", () => {
    localStorage.setItem("monocode:mono-roster", "[]");
    localStorage.setItem("monocode:mono-team-seeded", "1");
    expect(ensureBuiltInMonos()).toBe(0);
    expect(roster()).toEqual([]);
  });

  it("real data: only the EXO lead plus the old key set still gets the four, shown first in EXO's list", () => {
    const EXO = "/Users/ash/Code/exo";
    const mine = { id: "my-mono", name: "Scout", mascot: "robot", color: "x", projects: ["/Users/ash/Code/other"] };
    localStorage.setItem("monocode:mono-roster", JSON.stringify([{ ...LEADS[0], projects: [EXO] }, mine]));
    localStorage.setItem("monocode:mono-team-added", "1");
    localStorage.setItem("monocode:mono-team-seeded", "1");
    expect(ensureBuiltInMonos()).toBe(4);
    // The sidebar's per-project filter (MonoRailSection): tied to the folder, or one of the default four.
    const shown = (roster() as { id: string; name: string; projects: string[] }[])
      .filter((m) => m.projects.includes(EXO) || isDefaultTeamMono(m)).map((m) => m.name);
    expect(shown).toEqual([...TEAM, "EXO lead"]);
    expect(roster().find((m) => m.id === "my-mono")).toEqual(mine);
    const before = localStorage.getItem("monocode:mono-roster");
    expect(ensureBuiltInMonos()).toBe(0);
    expect(localStorage.getItem("monocode:mono-roster")).toBe(before);
    expect(roster()).toHaveLength(6);
  });

  for (const oldKey of [true, false])
    it(`Ash removed frank (old key ${oldKey ? "set" : "not set"}): the repair keeps him gone until Undo clears it`, () => {
      localStorage.setItem("monocode:mono-roster", JSON.stringify(LEADS));
      ensureBuiltInMonos();
      if (oldKey) localStorage.setItem("monocode:mono-team-added", "1");
      else localStorage.removeItem("monocode:mono-team-added");
      removeMono("frank"); // the real remove path records it
      expect(roster().map((m) => m.name)).not.toContain("frank");
      expect(ensureBuiltInMonos()).toBe(0);
      expect(ensureBuiltInMonos()).toBe(0);
      expect(roster().map((m) => m.name)).not.toContain("frank");
      clearMonoRemovedByUser("frank");
      expect(ensureBuiltInMonos()).toBe(1);
      expect(roster().filter((m) => m.name === "frank")).toHaveLength(1);
    });

  it("marking by a renamed copy's name records the team id; other Monos also stay deleted", () => {
    markMonoRemovedByUser("cos-old", "Chief of Staff");
    markMonoRemovedByUser("my-mono", "Scout");
    expect(JSON.parse(localStorage.getItem("monocode:mono-team-removed-by-user") ?? "[]")).toEqual(["chief-of-staff", "my-mono"]);
    expect(ensureBuiltInMonos()).toBe(4); // the other four of the five
    expect(roster().map((m) => m.name)).not.toContain("Chief of Staff");
  });
});

describe("the default four's look", () => {
  beforeEach(() => localStorage.clear());
  it("is Ash's from before 15 Oct: robots, Chief of Staff amber and the rest grey; a look already set is never swapped", () => {
    ensureBuiltInMonos();
    expect(roster().map((m) => [(m as { mascot?: string }).mascot, (m as { color?: string }).color])).toEqual([
      ["robot", "hsl(45 90% 55%)"],
      ["robot", "hsl(210 8% 58%)"],
      ["robot", "hsl(210 8% 58%)"],
      ["robot", "hsl(210 8% 58%)"],
      ["robot", "hsl(210 8% 58%)"], // Critiquito, on a fresh install
    ]);
    const picked = [{ id: "chief-of-staff", name: "Chief of Staff", mascot: "crab", mascotPicked: true, color: "hsl(142 55% 50%)", projects: [] }];
    localStorage.setItem("monocode:mono-roster", JSON.stringify(picked));
    ensureBuiltInMonos();
    expect(roster().find((m) => m.id === "chief-of-staff")).toMatchObject({ mascot: "crab", mascotPicked: true, color: "hsl(142 55% 50%)" });
  });
});
