import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { recordCrewFailure, recordCrewPause } from "./host";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

it("records a usage limit with the reset time, and returns the action", async () => {
  invokeMock.mockResolvedValue({ action: "pause" });
  const action = await recordCrewFailure(
    { id: "t-1", project: "vg-game", ownerMono: "vg-game-lead" },
    { errorClass: "usage_limit", error: "usage limit hit", resetsAt: "2026-11-04T12:00:00.000Z" },
    { cli: "claude", model: "claude:sonnet-5", effort: "high" },
  );
  expect(action).toEqual({ action: "pause" });
  expect(invokeMock).toHaveBeenCalledWith("crew_on_failure", {
    input: {
      delegationId: "t-1",
      errorClass: "usage_limit",
      text: "usage limit hit",
      resetsAt: Date.parse("2026-11-04T12:00:00.000Z"),
      current: { cli: "claude", model: "claude:sonnet-5", effort: "high" },
      present: [],
      project: "vg-game",
      mono: "vg-game-lead",
    },
  });
});

it("drops a reset time that is not a time, an unknown CLI and a missing action", async () => {
  invokeMock.mockResolvedValue({ action: 3 });
  const action = await recordCrewFailure(
    { id: "t-2", project: null, ownerMono: null },
    { errorClass: "auth", error: "signed out", resetsAt: "tomorrow" },
    { cli: "not-a-cli", model: "  ", effort: "nope" },
  );
  expect(action).toBeUndefined();
  const sent = invokeMock.mock.calls[0][1] as { input: Record<string, unknown> };
  expect(sent.input).not.toHaveProperty("resetsAt");
  expect(sent.input).not.toHaveProperty("project");
  expect(sent.input).not.toHaveProperty("mono");
  expect(sent.input.current).toEqual({ cli: null, model: null, effort: null });
});

it("returns the next CLI a reroute named", async () => {
  invokeMock.mockResolvedValue({ action: "reroute", to: "codex" });
  const note = await recordCrewFailure(
    { id: "t-3", project: "vg-game", ownerMono: null },
    { errorClass: "auth", error: "auth refused" },
    { cli: "claude", model: "claude:opus", effort: "high" },
  );
  expect(note).toEqual({ action: "reroute", to: "codex" });
});

it("notes a usage-limit pause without the failure text or a bad reset time", async () => {
  invokeMock.mockResolvedValue({ action: "pause", applied: true });
  await recordCrewPause(
    { id: "t-4" },
    { resetsAt: "tomorrow", error: "usage limit hit sk-SECRET" } as { resetsAt: string },
    { cli: "not-a-cli", model: "  ", effort: "nope" },
  );
  const sent = invokeMock.mock.calls[0][1] as { input: Record<string, unknown> };
  expect(invokeMock).toHaveBeenCalledWith("crew_note_pause", expect.anything());
  expect(sent.input).not.toHaveProperty("resetsAt");
  expect(sent.input).not.toHaveProperty("text");
  expect(sent.input).not.toHaveProperty("error");
  expect(JSON.stringify(sent.input)).not.toContain("SECRET");
  expect(sent.input.current).toEqual({ cli: null, model: null, effort: null });
  expect(sent.input.delegationId).toBe("t-4");
});
