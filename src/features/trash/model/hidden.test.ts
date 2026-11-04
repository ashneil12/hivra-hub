import { afterEach, expect, it, vi } from "vitest";
import { hubData, setHubDataSource } from "../../hub/model/hubData";
import type { HubDataSource, HubProject } from "../../hub/model/types";
import {
  hiddenProjectFolders,
  hiddenProjectsLoaded,
  hiddenProjectsWithheld,
  refreshHiddenProjects,
  resetHiddenProjects,
} from "./hidden";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const trashed: HubProject = {
  id: "/work/My Project",
  name: "Mine",
  shortName: "Mine",
  iconShape: "folder",
  folder: "/work/My Project",
};
const kept: HubProject = {
  id: "/work/Other",
  name: "Other",
  shortName: "Other",
  iconShape: "folder",
  folder: "/work/Other",
};

afterEach(() => {
  mocks.invoke.mockReset();
  resetHiddenProjects();
  setHubDataSource(undefined);
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

it("a first failed read shows no projects, and a later read hides only the trash", async () => {
  setHubDataSource({ listProjects: () => [trashed, kept] } as HubDataSource);
  expect(hubData().listProjects().map((project) => project.id)).toEqual([trashed.id, kept.id]);

  mocks.invoke.mockRejectedValueOnce(new Error("down"));
  expect(await refreshHiddenProjects()).toBe(false);
  expect(hiddenProjectsLoaded()).toBe(false);
  expect(hiddenProjectsWithheld()).toBe(true);
  expect(hubData().listProjects()).toEqual([]);

  mocks.invoke.mockResolvedValueOnce([{ kind: "project", id: "/work/My Project" }]);
  expect(await refreshHiddenProjects()).toBe(true);
  expect(hiddenProjectsWithheld()).toBe(false);
  expect(hubData().listProjects().map((project) => project.id)).toEqual([kept.id]);
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
