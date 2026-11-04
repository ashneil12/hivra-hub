// @vitest-environment happy-dom
// G4: each Mono carries a role label Ash can edit (rail, header, tooltip); a project's Lead reads "Runs the coding team".
import { beforeEach, expect, it } from "vitest";
import { ensureBuiltInMonos } from "../../hub/model/builtInMonos";
import { listMonos, monoLook, monoRole, saveMonoRole } from "./mono";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(
    "monocode:mono-roster",
    JSON.stringify([
      { id: "dee", name: "Dee", mascot: "crab", color: "#888", projects: [] },
      { id: "vg-game-lead", name: "EXO lead", mascot: "crab", color: "#888", projects: [] },
      { id: "scout", name: "Scout", mascot: "crab", color: "#888", projects: [] },
    ]),
  );
});
const get = (id: string) => listMonos().find((m) => m.id === id)!;

it("no built-in Mono starts with a role; an ordinary Mono's role is what was saved, and Ash's edit replaces it and survives a reload", () => {
  expect(ensureBuiltInMonos()).toBe(0);
  expect(monoRole(get("dee"))).toBeUndefined();
  expect(monoRole(get("scout"))).toBeUndefined();
  saveMonoRole("dee", "  Screens and copy  ");
  expect(monoLook(get("dee")).role).toBe("Screens and copy");
  expect(monoRole(get("dee"))).toBe("Screens and copy");
  expect(ensureBuiltInMonos()).toBe(0);
  expect(monoRole(listMonos().find((m) => m.id === "dee")!)).toBe("Screens and copy");
});

it("clearing a role leaves no label, and nothing fills one back in", () => {
  saveMonoRole("dee", "Screens and copy");
  saveMonoRole("dee", "");
  expect(monoRole(get("dee"))).toBeUndefined();
  expect(monoLook(get("dee")).role).toBeUndefined();
  expect(ensureBuiltInMonos()).toBe(0);
  expect(monoRole(get("dee"))).toBeUndefined();
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
