// @vitest-environment happy-dom
// Hivra WP-157: who may use the work log, and that add files the chat's project rather than one the model names.
import { describe, expect, it, vi } from "vitest";
import { newSession, type Session } from "../../sessions/model/session";
import { handleAgentApp, type AgentAppHost } from "./agentApp";
import type { WorkLogBackend, WorkLogLine } from "./agentAppWorkLog";

vi.mock("../../../integrations/harness/core/availability", () => ({ isHarnessAvailable: () => true }));

function fixture(who: "mono" | "team" | "worker" | "habit") {
  const source: Session = {
    ...newSession("claude", "/code/hivra", "claude:opus-5-5"),
    id: who === "worker" ? "app-w1" : `chat-${who}`,
  };
  const stored: WorkLogLine[] = [];
  const api: WorkLogBackend = {
    add: vi.fn(async (input) => {
      const row: WorkLogLine = {
        project: input.project,
        day: "2026-11-10",
        kind: input.kind,
        taskId: "",
        line: input.line.includes("ghp_") ? "The token is [secret removed]." : input.line,
      };
      stored.push(row);
      return { ...row, source: "mate:hidden" } as WorkLogLine;
    }),
    read: vi.fn(async () => stored),
  };
  const host = {
    isMono: () => who === "mono",
    isHabitRun: () => who === "habit",
    monoOf: () =>
      who === "mono" || who === "habit" ? { id: "hivra-lead", name: "Hivra lead", projects: ["/code/hivra"] } : undefined,
    codingTeamOf: () => (who === "team" ? { project: "hivra", name: "Hivra coding team", folder: "/code/hivra" } : undefined),
    tasks: { hubProjectId: (folder: string) => (folder === "/code/hivra" && who === "mono" ? "tally" : undefined) },
    workLog: api,
  } as unknown as AgentAppHost;
  return { source, host, api };
}

describe("work_log", () => {
  it("a Mono's chat or a coding-team chat adds one line under its own project", async () => {
    const mono = fixture("mono");
    const added = await handleAgentApp(mono.source, "r1", "work_log.add", { kind: "feedback", line: "Ash said keep the CSV." }, mono.host);
    expect(added).toEqual({ day: "2026-11-10", kind: "feedback", project: "tally", line: "Ash said keep the CSV." });
    expect(mono.api.add).toHaveBeenCalledWith({
      session: mono.source.id,
      project: "tally",
      kind: "feedback",
      line: "Ash said keep the CSV.",
    });
    const team = fixture("team");
    await handleAgentApp(team.source, "r1", "work_log.add", { kind: "context", line: "The export is CSV." }, team.host);
    expect(team.api.add).toHaveBeenCalledWith(expect.objectContaining({ project: "hivra", session: team.source.id }));
  });

  it("does not take a project from the model, and returns the stored line without its source", async () => {
    const { source, host } = fixture("mono");
    await expect(
      handleAgentApp(source, "r1", "work_log.add", { kind: "feedback", line: "Keep it.", project: "other" }, host),
    ).rejects.toThrow(/Unknown work_log.add fields: project/);
    const added = await handleAgentApp(
      source,
      "r2",
      "work_log.add",
      { kind: "feedback", line: "The token is ghp_PLANTED0123456789abcdefghijklmnopqrstu" },
      host,
    );
    expect(added).toEqual({ day: "2026-11-10", kind: "feedback", project: "tally", line: "The token is [secret removed]." });
    expect(added).not.toHaveProperty("source");
  });

  it("a worker can't, and neither can a habit run", async () => {
    const worker = fixture("worker");
    await expect(handleAgentApp(worker.source, "r1", "work_log.add", { kind: "feedback", line: "x" }, worker.host)).rejects.toThrow(
      /Only a first mate/,
    );
    await expect(handleAgentApp(worker.source, "r2", "work_log.read", { day: "2026-11-10" }, worker.host)).rejects.toThrow(
      /worker reports to the chat that delegated it/,
    );
    const habit = fixture("habit");
    await expect(handleAgentApp(habit.source, "r1", "work_log.read", { day: "2026-11-10" }, habit.host)).rejects.toThrow(
      /habit run doesn't write the work log/,
    );
  });

  it("a habit run, the morning one included, can neither add nor read, so the log reaches it only through the app", async () => {
    const habit = fixture("habit");
    for (const [action, input] of [
      ["work_log.add", { kind: "outcome", line: "Done: x." }],
      ["work_log.read", { day: "2026-11-09" }],
      ["work_log.read", { from: "2026-11-01", to: "2026-11-09", project: "tally" }],
    ] as const) {
      await expect(handleAgentApp(habit.source, "r1", action, input, habit.host)).rejects.toThrow(
        /habit run doesn't write the work log/,
      );
    }
    expect(habit.api.add).not.toHaveBeenCalled();
    expect(habit.api.read).not.toHaveBeenCalled();
  });

  it("reads one day or a range, and refuses a mix, a backwards range, and a page of days", async () => {
    const { source, host, api } = fixture("team");
    expect(await handleAgentApp(source, "r1", "work_log.read", { day: "2026-11-10" }, host)).toEqual({ lines: [] });
    expect(api.read).toHaveBeenCalledWith({ project: undefined, day: "2026-11-10", from: undefined, to: undefined });
    await handleAgentApp(source, "r2", "work_log.read", { from: "2026-11-01", to: "2026-11-10", project: "tally" }, host);
    expect(api.read).toHaveBeenCalledWith({ project: "tally", day: undefined, from: "2026-11-01", to: "2026-11-10" });
    await expect(handleAgentApp(source, "r3", "work_log.read", { day: "2026-11-10", from: "2026-11-01", to: "2026-11-10" }, host)).rejects.toThrow(
      /not both/,
    );
    await expect(handleAgentApp(source, "r4", "work_log.read", {}, host)).rejects.toThrow(/which day/);
    await expect(handleAgentApp(source, "r5", "work_log.read", { from: "2026-11-10", to: "2026-11-01" }, host)).rejects.toThrow(
      /end day is before/,
    );
    await expect(handleAgentApp(source, "r6", "work_log.read", { from: "2026-01-01", to: "2027-01-03" }, host)).rejects.toThrow(
      /at most a year/,
    );
    await expect(handleAgentApp(source, "r7", "work_log.read", { day: "2026-02-31" }, host)).rejects.toThrow(/2026-11-10/);
    await expect(handleAgentApp(source, "r8", "work_log.read", { day: "2026-11-10", project: "  " }, host)).rejects.toThrow(
      /leave it out/,
    );
    await expect(handleAgentApp(source, "r9", "work_log.add", { kind: "note", line: "x" }, host)).rejects.toThrow(
      /outcome, a decision, feedback or context/,
    );
    await expect(handleAgentApp(source, "r10", "work_log.add", { kind: "feedback", line: "  " }, host)).rejects.toThrow(/needs words/);
  });
});
