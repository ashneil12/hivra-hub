// @vitest-environment happy-dom
// A launch adds no mono. The removal list is general: it records who a person deleted, and a bad list falls back to empty.
import { beforeEach, describe, expect, it } from "vitest";
import {
  adoptRemovedByUser,
  clearMonoRemovedByUser,
  ensureBuiltInMonos,
  isDefaultTeamMono,
  isMonoRemovedByUser,
  markMonoRemovedByUser,
  monoDeletedByUser,
  REMOVED_BY_USER_KEY,
} from "./builtInMonos";

const roster = () => JSON.parse(localStorage.getItem("monocode:mono-roster") ?? "[]") as { id: string; name: string; instructions?: string }[];
const removed = () => JSON.parse(localStorage.getItem(REMOVED_BY_USER_KEY) ?? "[]") as string[];

beforeEach(() => localStorage.clear());

describe("a launch adds nobody", () => {
  it("leaves an empty roster empty, twice", () => {
    expect(ensureBuiltInMonos()).toBe(0);
    expect(ensureBuiltInMonos()).toBe(0);
    expect(roster()).toEqual([]);
  });

  it("does not rewrite a roster that is already there, including a soul a person edited", () => {
    const mine = { id: "ada", name: "Ada", instructions: "# Soul\n\nMine.\n", mascot: "crab", color: "x", projects: ["/tmp/ada"] };
    localStorage.setItem("monocode:mono-roster", JSON.stringify([mine]));
    const before = localStorage.getItem("monocode:mono-roster");
    expect(ensureBuiltInMonos()).toBe(0);
    expect(localStorage.getItem("monocode:mono-roster")).toBe(before);
    expect(roster()).toEqual([mine]);
  });

  it("nobody is on a default team, including an empty id", () => {
    expect(isDefaultTeamMono({ id: "ada", name: "Ada" })).toBe(false);
    expect(isDefaultTeamMono({})).toBe(false);
    expect(isDefaultTeamMono({ id: "", name: "" })).toBe(false);
  });
});

describe("the removal list", () => {
  it("records an id, ignores a duplicate, and clears only that id", () => {
    markMonoRemovedByUser("Ada");
    markMonoRemovedByUser("ada");
    markMonoRemovedByUser("bo", "Bo");
    expect(removed().sort()).toEqual(["ada", "bo"]);
    expect(isMonoRemovedByUser("ADA")).toBe(true);
    expect(monoDeletedByUser({ id: "bo" })).toBe(true);
    expect(monoDeletedByUser({ id: "cam" })).toBe(false);
    clearMonoRemovedByUser("ada");
    expect(isMonoRemovedByUser("ada")).toBe(false);
    expect(isMonoRemovedByUser("bo")).toBe(true);
    clearMonoRemovedByUser("missing");
    expect(removed()).toEqual(["bo"]);
  });

  it("a bad list is empty, and an import only adds", () => {
    localStorage.setItem(REMOVED_BY_USER_KEY, "{");
    expect(isMonoRemovedByUser("ada")).toBe(false);
    markMonoRemovedByUser("ada");
    expect(adoptRemovedByUser("not json")).toEqual(new Set());
    expect(removed()).toEqual(["ada"]);
    expect(adoptRemovedByUser(JSON.stringify(["bo", "ada", 3, ""]))).toEqual(new Set(["bo", "ada", ""]));
    expect(removed().sort()).toEqual(["", "ada", "bo"]);
    expect(adoptRemovedByUser("[]")).toEqual(new Set());
    expect(isMonoRemovedByUser("ada")).toBe(true);
  });
});
