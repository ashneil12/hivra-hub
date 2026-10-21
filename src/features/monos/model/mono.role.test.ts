// @vitest-environment happy-dom
// G4: each Mono carries a role label Ash can edit (rail, header, tooltip); a project's Lead reads "Runs the coding team".
import { beforeEach, expect, it } from "vitest";
import { listMonos, monoLook, monoRole, saveMonoRole } from "./mono";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(
    "monocode:mono-roster",
    JSON.stringify([
      { id: "critiquito", name: "Critiquito", mascot: "crab", color: "#888", projects: [] },
      { id: "vg-game-lead", name: "EXO lead", mascot: "crab", color: "#888", projects: [] },
      { id: "scout", name: "Scout", mascot: "crab", color: "#888", projects: [] },
    ]),
  );
});
const get = (id: string) => listMonos().find((m) => m.id === id)!;

it("a built-in Mono starts with its role; Ash's edit replaces it and survives a reload of the roster", () => {
  expect(monoRole(get("critiquito"))).toBe("Design review");
  saveMonoRole("critiquito", "  Screens and copy  ");
  expect(monoLook(get("critiquito")).role).toBe("Screens and copy");
});

it("clearing a role leaves no label, even on a built-in Mono", () => {
  saveMonoRole("critiquito", "");
  expect(monoRole(get("critiquito"))).toBeUndefined();
  expect(monoLook(get("critiquito")).role).toBeUndefined();
});

it("a new Mono has no role until given one", () => {
  expect(monoRole(get("scout"))).toBeUndefined();
  saveMonoRole("scout", "Finds leads");
  expect(monoLook(get("scout")).role).toBe("Finds leads");
});

it("every project's Lead reads \"Runs the coding team\" (its name says which project), and isn't edited", () => {
  saveMonoRole("vg-game-lead", "Runs EXO");
  expect(get("vg-game-lead").role).toBeUndefined();
  expect(monoLook(get("vg-game-lead")).role).toBe("Runs the coding team");
  expect(monoRole({ id: "new-project-lead" })).toBe("Runs the coding team");
});
