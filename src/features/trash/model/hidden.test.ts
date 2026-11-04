import { afterEach, expect, it, vi } from "vitest";
import { hiddenProjectFolders, hiddenProjectsLoaded, refreshHiddenProjects, resetHiddenProjects } from "./hidden";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

afterEach(() => {
  mocks.invoke.mockReset();
  resetHiddenProjects();
});

it("hides a trashed project folder, and a failed read keeps what it already knew", async () => {
  mocks.invoke.mockResolvedValueOnce([{ kind: "project", id: "/work/My Project" }, { kind: "chat", id: "c1" }]);
  expect(await refreshHiddenProjects()).toBe(true);
  expect(hiddenProjectsLoaded()).toBe(true);
  expect(hiddenProjectFolders().has("/work/My Project")).toBe(true);

  mocks.invoke.mockRejectedValueOnce(new Error("down"));
  expect(await refreshHiddenProjects()).toBe(false);
  expect(hiddenProjectFolders().has("/work/My Project")).toBe(true);
});

it("an empty trash is a real answer, and a bad payload is not", async () => {
  mocks.invoke.mockResolvedValueOnce([]);
  expect(await refreshHiddenProjects()).toBe(false);
  expect(hiddenProjectsLoaded()).toBe(true);
  expect(hiddenProjectFolders().size).toBe(0);

  mocks.invoke.mockResolvedValueOnce("nope");
  expect(await refreshHiddenProjects()).toBe(false);
  expect(hiddenProjectsLoaded()).toBe(true);
});
