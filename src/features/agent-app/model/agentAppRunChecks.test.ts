// @vitest-environment happy-dom
// SC-7: the `run_checks` tool (`run_checks.run`): who may call it (a worker in its own copy, a first mate in its project),
// what it sends the app, and that what comes back is only the summary, the failing tests, the counts, the log's path and
// the outcome. The run itself is src-tauri/src/run_checks.rs.
import { describe, expect, it, vi } from "vitest";
import { CHECKER_MONO_ID } from "../../hub/model/hubMcp";
import { newSession, type Session } from "../../sessions/model/session";
import { appActions, handleAgentApp, type AgentAppHost } from "./agentApp";
import type { RunChecksReport } from "./agentAppRunChecks";

vi.mock("../../../integrations/harness/core/availability", () => ({ isHarnessAvailable: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const REPORT: RunChecksReport = {
  outcome: "red",
  summary: "Tests  1 failed | 2 passed (3)",
  total: 3,
  failed: 1,
  failures: [{ name: "src/sort.test.ts > sorts", message: "AssertionError: expected [2,1] to equal [1,2]" }],
  log: "/data/run-checks/t-9/1700000000000.log",
  command: "web",
};

type Who = "worker" | "mono" | "mono-two" | "team" | "habit" | "checker";

type Run = (input: { cwd: string; owner: string; command?: string; paths?: string[] }) => Promise<unknown>;

function fixture(who: Who, run: Run = vi.fn(async () => REPORT), selfTask?: () => Promise<{ id: string } | undefined>) {
  const source: Session = {
    ...newSession("claude", who === "mono-two" ? "/code/mono-home" : who === "worker" ? "/work/copy-1" : "/code/hivra", "claude:opus-5-5"),
    id: who === "worker" ? "app-w1" : `chat-${who}`,
  };
  const projects = who === "mono-two" ? ["/code/hivra", "/code/other"] : ["/code/hivra"];
  const host = {
    isMono: () => who === "mono" || who === "mono-two" || who === "habit" || who === "checker",
    isHabitRun: () => who === "habit",
    monoOf: () =>
      who === "mono" || who === "mono-two" || who === "habit" || who === "checker"
        ? { id: who === "checker" ? CHECKER_MONO_ID : "hivra-lead", name: "Hivra lead", projects }
        : undefined,
    codingTeamOf: () => (who === "team" ? { project: "hivra", name: "Hivra coding team", folder: "/code/hivra" } : undefined),
    tasks: selfTask ? { selfTask } : undefined,
    runChecks: { run },
  } as unknown as AgentAppHost;
  return { source, host, run };
}

describe("run_checks.run", () => {
  it("is an app action", () => {
    expect(appActions()).toContain("run_checks.run");
  });

  it("runs a worker's tests in its own copy, under the task it is doing", async () => {
    const run = vi.fn(async () => REPORT);
    const { source, host } = fixture("worker", run, async () => ({ id: "t-9" }));
    const answer = await handleAgentApp(source, "r1", "run_checks.run", { command: "web", paths: ["web/a.ts", "web/é b.ts"] }, host);
    expect(run).toHaveBeenCalledWith({ cwd: "/work/copy-1", owner: "t-9", command: "web", paths: ["web/a.ts", "web/é b.ts"] });
    expect(answer).toEqual(REPORT);
  });

  it("sends nothing it was not given, and names the chat when no task is its own", async () => {
    const run = vi.fn(async () => REPORT);
    const { source, host } = fixture("worker", run, async () => undefined);
    await handleAgentApp(source, "r1", "run_checks.run", {}, host);
    expect(run).toHaveBeenCalledWith({ cwd: "/work/copy-1", owner: "app-w1" });
    // A lookup that fails is not a refusal: the run is kept under the chat.
    const broken = fixture("worker", run, async () => {
      throw new Error("the store was busy");
    });
    await handleAgentApp(broken.source, "r2", "run_checks.run", {}, broken.host);
    expect(run).toHaveBeenLastCalledWith({ cwd: "/work/copy-1", owner: "app-w1" });
  });

  it("runs for a Mono's chat in its project and for a coding-team chat in the team's", async () => {
    const mono = fixture("mono");
    await handleAgentApp(mono.source, "r1", "run_checks.run", {}, mono.host);
    expect(mono.run).toHaveBeenCalledWith({ cwd: "/code/hivra", owner: "chat-mono" });
    const team = fixture("team");
    await handleAgentApp(team.source, "r1", "run_checks.run", {}, team.host);
    expect(team.run).toHaveBeenCalledWith({ cwd: "/code/hivra", owner: "chat-team" });
  });

  it("makes a Mono with two projects name one", async () => {
    const { source, host, run } = fixture("mono-two");
    await expect(handleAgentApp(source, "r1", "run_checks.run", {}, host)).rejects.toThrow(/Pass "project"/);
    expect(run).not.toHaveBeenCalled();
    await handleAgentApp(source, "r2", "run_checks.run", { project: "/code/other" }, host);
    expect(run).toHaveBeenCalledWith({ cwd: "/code/other", owner: "chat-mono-two" });
  });

  it("gives a worker no project to name", async () => {
    const { source, host, run } = fixture("worker");
    await expect(handleAgentApp(source, "r1", "run_checks.run", { project: "/code/other" }, host)).rejects.toThrow(
      /project is only for a Mono/,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a habit run and the checker, and runs nothing for them", async () => {
    const habit = fixture("habit");
    await expect(handleAgentApp(habit.source, "r1", "run_checks.run", {}, habit.host)).rejects.toThrow(
      "A habit run doesn't run the project's tests. The first mate does, from its own chat.",
    );
    const checker = fixture("checker");
    await expect(handleAgentApp(checker.source, "r1", "run_checks.run", {}, checker.host)).rejects.toThrow(/checker only reads/);
    expect(habit.run).not.toHaveBeenCalled();
    expect(checker.run).not.toHaveBeenCalled();
  });

  it("refuses a field it doesn't know and a value of the wrong kind before it runs anything", async () => {
    const { source, host, run } = fixture("worker");
    await expect(handleAgentApp(source, "r1", "run_checks.run", { cmd: "rm -rf /" }, host)).rejects.toThrow(
      /Unknown run_checks.run fields: cmd/,
    );
    for (const bad of [
      { command: 5 },
      { command: ["web"] },
      { command: "x".repeat(401) },
      { paths: "web/a.ts" },
      { paths: [1] },
      { paths: Array.from({ length: 201 }, (_, i) => `f${i}.ts`) },
      { paths: ["x".repeat(1025)] },
    ]) {
      await expect(handleAgentApp(source, "r2", "run_checks.run", bad, host), JSON.stringify(bad).slice(0, 40)).rejects.toThrow();
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("leaves out a blank command and blank paths", async () => {
    const { source, host, run } = fixture("worker");
    await handleAgentApp(source, "r1", "run_checks.run", { command: "  ", paths: ["", "  ", "web/a.ts"] }, host);
    expect(run).toHaveBeenCalledWith({ cwd: "/work/copy-1", owner: "app-w1", paths: ["web/a.ts"] });
  });

  it("answers only with the summary, the failing tests, the counts, the log and the outcome", async () => {
    const run = vi.fn(async () => ({
      ...REPORT,
      moreFailures: 4,
      note: "Web tests: inconclusive, the runner ran zero tests.",
      // What the app must never send, and the tool must never pass on.
      output: "RUN v2.1.8 ... 40,000 lines",
      exitCode: 1,
      failures: [{ name: "a", message: "m", stack: "deep" }, { name: 5 }, "junk"],
    }));
    const { source, host } = fixture("worker", run);
    const answer = (await handleAgentApp(source, "r1", "run_checks.run", {}, host)) as Record<string, unknown>;
    expect(Object.keys(answer).sort()).toEqual(["command", "failed", "failures", "log", "moreFailures", "note", "outcome", "summary", "total"]);
    expect(answer.failures).toEqual([{ name: "a", message: "m" }]);
    expect(answer).not.toHaveProperty("output");
    expect(answer).not.toHaveProperty("exitCode");
  });

  it("refuses an answer that isn't a report instead of reporting a result", async () => {
    for (const raw of [null, "green", { outcome: "passed" }, { ...REPORT, outcome: "maybe" }, { ...REPORT, total: "3" }, { ...REPORT, log: 5 }]) {
      const { source, host } = fixture("worker", vi.fn(async () => raw));
      await expect(handleAgentApp(source, "r1", "run_checks.run", {}, host)).rejects.toThrow(/couldn't be read/);
    }
  });

  it("says why when the app could not run it, in the app's own words", async () => {
    const { source, host } = fixture(
      "worker",
      vi.fn(async () => {
        throw "This project declares no test command. Run its tests yourself and say so in your report.";
      }),
    );
    await expect(handleAgentApp(source, "r1", "run_checks.run", {}, host)).rejects.toThrow(
      "This project declares no test command. Run its tests yourself and say so in your report.",
    );
  });
});
