// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { ensureBuiltInMonos } from "./builtInMonos";

const roster = () => (JSON.parse(localStorage.getItem("monocode:mono-roster") ?? "[]") as { id: string; name: string }[]);
const LEADS = [
  { id: "vg-game-lead", name: "EXO lead" }, { id: "hivra-lead", name: "Hivra lead" },
  { id: "nibbii-lead", name: "Nibbii lead" }, { id: "ash-lead", name: "Harness lead" },
].map((m) => ({ ...m, mascot: "robot", color: "x", projects: [] }));
const TEAM = ["Chief of Staff", "Projects Manager", "frank", "Alfred"];

beforeEach(() => localStorage.clear());

describe("the default team, added once", () => {
  it("a clean launch gets the four, and no Critiquito", () => {
    expect(ensureBuiltInMonos()).toBe(4);
    expect(roster().map((m) => m.name)).toEqual(TEAM);
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

  it("runs once: a team Mono Ash removes on purpose doesn't come back", () => {
    localStorage.setItem("monocode:mono-roster", JSON.stringify(LEADS));
    ensureBuiltInMonos();
    localStorage.setItem("monocode:mono-roster", JSON.stringify(roster().filter((m) => m.name !== "frank")));
    expect(ensureBuiltInMonos()).toBe(0);
    expect(roster().map((m) => m.name)).not.toContain("frank");
    expect(localStorage.getItem("monocode:mono-team-added")).toBe("1");
  });

  it("after the old step seeded a clean launch and Ash emptied it, it stays empty", () => {
    localStorage.setItem("monocode:mono-roster", "[]");
    localStorage.setItem("monocode:mono-team-seeded", "1");
    expect(ensureBuiltInMonos()).toBe(0);
    expect(roster()).toEqual([]);
  });
});
