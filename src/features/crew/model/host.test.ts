import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { crewLaunchCheck, crewPickFor, crewPolicyInForce, pickMonosFrom, recordCrewFailure, recordCrewPause } from "./host";

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

// HIGH 2: Crew Defaults saves a project's policy under its folder. A failure row carries the hub project id,
// so the failure must send the folder, or the project's lock, Never use and fallback order are never read.
it("sends the folder the policy was saved under, not the hub project id of the row", async () => {
  invokeMock.mockResolvedValue({ action: "reroute", to: "codex" });
  await recordCrewFailure(
    { id: "t-hub", project: "hub-proj-c", ownerMono: "vg-game-lead" },
    { errorClass: "usage_limit", error: "usage limit hit" },
    { cli: "claude" },
    "/tmp/proj-c",
  );
  expect(invokeMock).toHaveBeenCalledWith("crew_on_failure", {
    input: expect.objectContaining({ delegationId: "t-hub", project: "/tmp/proj-c", mono: "vg-game-lead" }),
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

it("WP-141: asks crew_pick with the request, and names each Lead with its role and what delegate_task takes", async () => {
  invokeMock.mockResolvedValue({ ok: true, cli: "codex", monoId: null, model: null, effort: null, reason: "Your default is Codex." });
  const request = { labels: ["builder"], paths: [], monos: [], depth: 0, atCap: [] };
  await expect(crewPickFor(request)).resolves.toMatchObject({ cli: "codex" });
  expect(invokeMock).toHaveBeenCalledWith("crew_pick", { request });
  const roster = pickMonosFrom(
    [
      { leadId: "web-lead", leadName: "Web lead", projectId: "web" },
      { leadId: "game-lead", leadName: "EXO lead", projectId: "vg-game" },
    ],
    [{ id: "web-lead", role: " reviewer " }, { id: "other", role: "builder" }],
  );
  expect(roster).toEqual([
    { id: "web-lead", name: "Web lead", role: "reviewer", lead: "web" },
    { id: "game-lead", name: "EXO lead", lead: "vg-game" },
  ]);
});

// MEDIUM 5: a Lead brief checks the Never use list in force. A Mono's own policy wins, then the project's, then everything's.
it("WP-141 MEDIUM 6: the Never use list in force is the union of the Mono's, the project's and everything's", async () => {
  invokeMock.mockImplementation((_cmd, args) => {
    const scope = (args as { scope: string }).scope;
    if (scope === "mono") return Promise.resolve({ policy: { neverUse: ["lead-x"] }, policyOwn: false });
    if (scope === "project") return Promise.resolve({ policy: { neverUse: ["lead-p"] }, policyOwn: true });
    return Promise.resolve({ policy: { neverUse: ["lead-s"] }, policyOwn: true });
  });
  expect(await crewPolicyInForce("vg-lead", "/tmp/proj")).toEqual({ neverUse: ["lead-p", "lead-s"], lock: false });
  invokeMock.mockImplementation((_cmd, args) => {
    const scope = (args as { scope: string }).scope;
    if (scope === "mono") return Promise.resolve({ policy: { neverUse: ["lead-m"], lockDefault: true }, policyOwn: true });
    return Promise.resolve({ policy: { neverUse: ["lead-s"] }, policyOwn: false });
  });
  expect(await crewPolicyInForce("vg-lead", "/tmp/proj")).toEqual({ neverUse: ["lead-m", "lead-s"], lock: true });
});

it("WP-141 MEDIUM 4: a policy that can't be read is an error, never an empty policy", async () => {
  invokeMock.mockRejectedValue(new Error("db locked"));
  await expect(crewPolicyInForce("vg-lead", "/tmp/proj")).rejects.toThrow(
    "The crew policy could not be read, so nothing was started (db locked).",
  );
});

it("WP-141 gate: crew_launch_check is sent the CLI, the Mono, the folder and the locked default, and its refusal is the reason", async () => {
  invokeMock.mockRejectedValueOnce("Codex is on Never use, so it was not started.");
  await expect(
    crewLaunchCheck({ cli: "codex", mono: "vg-lead", folder: "/tmp/proj", lockedDefault: "claude" }),
  ).rejects.toThrow("Codex is on Never use, so it was not started.");
  expect(invokeMock).toHaveBeenCalledWith("crew_launch_check", {
    input: { cli: "codex", mono: "vg-lead", project: "/tmp/proj", lockedDefault: "claude" },
  });
});
