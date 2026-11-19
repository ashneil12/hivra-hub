// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { addMono, findMono, listMonos, updateMono } from "./mono";
import { applyIdleCardRuns, queueCardRun, resetCardRunsForTests } from "./monoRun";
import { noteMonoSettings } from "./monoCardLog";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

afterEach(() => {
  localStorage.clear();
  resetCardRunsForTests();
  vi.clearAllMocks();
});

it("keeps fast, skills and commands, and drops a path or a non-boolean", () => {
  localStorage.setItem(
    "monocode:mono-roster",
    JSON.stringify([
      {
        id: "ada",
        mascot: "robot",
        color: "x",
        projects: [],
        engineFast: false,
        skills: ["grill-me", "grill-me", "../secret", "has space", "tdd"],
        commands: ["ship", "ship"],
      },
      {
        id: "ed",
        mascot: "robot",
        color: "x",
        projects: [],
        engineFast: "yes",
        skills: [],
        commands: ["../nope"],
      },
    ]),
  );
  const ada = listMonos().find((mono) => mono.id === "ada");
  expect(ada?.engineFast).toBe(false);
  expect(ada?.skills).toEqual(["grill-me", "tdd"]);
  expect(ada?.commands).toEqual(["ship"]);
  const ed = listMonos().find((mono) => mono.id === "ed");
  expect(ed?.engineFast).toBeUndefined();
  expect(ed?.skills).toBeUndefined();
  expect(ed?.commands).toBeUndefined();
});

it("does not apply a queued run while the turn is running, and applies it once the turn is idle", () => {
  addMono({
    id: "ada",
    mascot: "robot",
    color: "x",
    projects: [],
    sessionId: "chat-1",
    engine: "claude",
    engineModel: "claude:opus-fast",
    engineFast: true,
  });
  const run = {
    monoId: "ada",
    harness: "claude",
    model: "claude:opus-fast",
    settings: { fast: "true" },
    engineFast: true,
  };
  queueCardRun(run);
  const apply = vi.fn();
  applyIdleCardRuns([{ id: "chat-1", busy: true }], apply);
  expect(apply).not.toHaveBeenCalled();
  applyIdleCardRuns([{ id: "chat-1", busy: false }], apply);
  expect(apply).toHaveBeenCalledTimes(1);
  expect(apply).toHaveBeenCalledWith("chat-1", run);
  applyIdleCardRuns([{ id: "chat-1", busy: false }], apply);
  expect(apply).toHaveBeenCalledTimes(1);
});

it("drops a queued run that no longer matches the Mono", () => {
  addMono({
    id: "ada",
    mascot: "robot",
    color: "x",
    projects: [],
    sessionId: "chat-1",
    engine: "claude",
    engineModel: "claude:sonnet-plain",
  });
  queueCardRun({
    monoId: "ada",
    harness: "claude",
    model: "claude:opus-fast",
    settings: {},
    engineFast: true,
  });
  const apply = vi.fn();
  applyIdleCardRuns([{ id: "chat-1", busy: false }], apply);
  expect(apply).not.toHaveBeenCalled();
  applyIdleCardRuns([{ id: "chat-1", busy: false }], apply);
  expect(apply).not.toHaveBeenCalled();
});

it("notes a Mono settings change", async () => {
  addMono({ id: "ada", name: "Ada", mascot: "robot", color: "x", projects: [] });
  noteMonoSettings("ada", "Fast mode on.");
  const { invoke } = await import("@tauri-apps/api/core");
  await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
  expect(invoke).toHaveBeenCalledWith("activity_note", {
    kind: "mono.settings",
    summary: "Fast mode on.",
    project: "app",
    target: "ada",
    actorId: "ada",
    actorName: "Ada",
  });
  updateMono("ada", (mono) => mono);
  expect(findMono("ada")?.name).toBe("Ada");
});
