// @vitest-environment happy-dom
// G12: the welcome is for an empty install only, even when the webview's storage was cleared.
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ monos: [] as { id: string }[], projects: [] as { id: string }[], storeDown: false }));
vi.mock("../../monos/model/mono", () => ({ listMonos: () => state.monos }));
vi.mock("./hubData", () => ({
  hubData: () => {
    if (state.storeDown) throw new Error("not up");
    return { listProjects: () => state.projects };
  },
}));

import { finishOnboarding, needsOnboarding } from "./onboarding";

beforeEach(() => {
  localStorage.clear();
  state.monos = [];
  state.projects = [];
  state.storeDown = false;
});

it("greets a truly empty install, and not again once finished", () => {
  expect(needsOnboarding()).toBe(true);
  finishOnboarding();
  expect(needsOnboarding()).toBe(false);
});

it("never greets an install that already has a first mate, and writes the mark back", () => {
  state.monos = [{ id: "lead" }];
  expect(needsOnboarding()).toBe(false);
  expect(localStorage.getItem("monocode:hub-onboarded")).toBe("1");
});

it("never greets an install that already has a project", () => {
  state.projects = [{ id: "exo" }];
  expect(needsOnboarding()).toBe(false);
});

it("treats a store that is not up yet as nothing known", () => {
  state.storeDown = true;
  expect(needsOnboarding()).toBe(true);
});
