// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { botChangesSince, findBotChange, recordPageWrite, redoBotChange, undoBotChange } from "../../hub/model/botChanges";
import type { HubProject } from "../../hub/model/types";

const world = vi.hoisted(() => ({
  projects: [] as HubProject[],
  renames: [] as { id: string; name: string }[],
  acts: [] as { action: string; payload: unknown }[],
  live: false,
}));
vi.mock("../../hub/model/hubData", () => ({
  hubData: () => ({ listProjects: () => world.projects }),
  liveHubStore: () =>
    world.live ? { act: async (action: string, payload: unknown) => world.acts.push({ action, payload }) } : undefined,
}));
vi.mock("../../hub/model/projectActions", () => ({
  renameProjectEverywhere: async (project: HubProject, name: string) => {
    world.renames.push({ id: project.id, name });
  },
}));

import { pageWriteHandlers } from "./pageWrites";

const project = (id: string, name: string): HubProject => ({ id, name, shortName: name, iconShape: "sparkles", folder: `/p/${id}` });

beforeEach(() => {
  world.projects = [project("hivra", "Hivra"), project("vg-game", "EXO")];
  world.renames = [];
  world.acts = [];
  world.live = false;
});

const write = (title: string, args: Record<string, unknown>) => pageWriteHandlers(title)["project.write"]!(args);

it("renames a project through the hub's own store, under the page's title, as a row Ash can undo", async () => {
  const out = await write("Scores", { op: "rename", projectId: "hivra", name: "  Hivra   Studio  " });
  expect(out).toEqual({ done: true, projectId: "hivra", name: "Hivra Studio" });
  expect(world.renames).toEqual([{ id: "hivra", name: "Hivra Studio" }]);

  const row = botChangesSince(0).find((c) => c.bot === "Scores" && c.write);
  expect(row?.line).toBe("The hub “Scores” renamed Hivra to Hivra Studio");
  expect(row?.write).toMatchObject({ action: "project-rename", payload: { project_id: "hivra" }, before: { name: "Hivra" }, after: { name: "Hivra Studio" } });
});

it("finds a project by id or by its name", async () => {
  await expect(write("By name", { op: "rename", projectId: "exo", name: "EXO Game" })).resolves.toMatchObject({ projectId: "vg-game" });
});

it("says no in plain words to anything but a rename it can do", async () => {
  await expect(write("p", { op: "delete", projectId: "hivra" })).rejects.toThrow("That's the one project change it makes for now.");
  await expect(write("p", { op: "rename", projectId: "hivra" })).rejects.toThrow("A new name can't be empty.");
  await expect(write("p", { op: "rename", projectId: "hivra", name: "x".repeat(81) })).rejects.toThrow("80 characters at most");
  await expect(write("p", { op: "rename", projectId: "nope", name: "Nope" })).rejects.toThrow("There's no project called “nope”.");
  await expect(write("p", { op: "rename", name: "Nope" })).rejects.toThrow("Say which project to rename.");
  expect(world.renames).toEqual([]);
});

it("does nothing, and writes no row, when the name is already the project's", async () => {
  const before = botChangesSince(0).length;
  await expect(write("Same", { op: "rename", projectId: "hivra", name: "Hivra" })).resolves.toEqual({ done: true, projectId: "hivra", name: "Hivra" });
  expect(world.renames).toEqual([]);
  expect(botChangesSince(0)).toHaveLength(before);
});

it("Undo puts the old name back through the same action, and Redo puts the new one on again", async () => {
  await pageWriteHandlers("Undo me")["project.write"]!({ op: "rename", projectId: "hivra", name: "Hivra Studio" });
  const row = botChangesSince(0).find((c) => c.bot === "Undo me" && c.write)!;
  world.renames = [];

  await undoBotChange([row.id]);
  expect(world.renames).toEqual([{ id: "hivra", name: "Hivra" }]);
  expect(findBotChange(row.id)?.undone).toBe(true);

  await redoBotChange([row.id]);
  expect(world.renames).toEqual([
    { id: "hivra", name: "Hivra" },
    { id: "hivra", name: "Hivra Studio" },
  ]);
  expect(findBotChange(row.id)?.undone).toBe(false);
});

it("says so, and stays undoable, when the project has gone since", async () => {
  await pageWriteHandlers("Gone")["project.write"]!({ op: "rename", projectId: "hivra", name: "Hivra Studio" });
  const row = botChangesSince(0).find((c) => c.bot === "Gone" && c.write)!;
  world.projects = [];

  await undoBotChange([row.id]);
  const after = findBotChange(row.id);
  expect(after?.problem).toBe("That project isn't on the app any more, so nothing changed.");
  expect(after?.undone).toBeFalsy();
});

it("runs any other page write through the hub's store, and says so when there is no store", async () => {
  const id = recordPageWrite({
    by: "Other",
    line: "The page did something else",
    now: "",
    after: "",
    undoneText: "",
    write: { action: "task-move", payload: { task_id: "t1" }, before: {}, after: {} },
  });
  await undoBotChange([id]);
  expect(findBotChange(id)?.problem).toBe("Not connected to the harness service, so nothing changed.");

  world.live = true;
  await undoBotChange([id]);
  expect(world.acts).toEqual([{ action: "task-move", payload: { task_id: "t1" } }]);
  expect(findBotChange(id)?.undone).toBe(true);
});
