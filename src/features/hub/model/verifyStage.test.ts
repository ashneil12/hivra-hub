// The verify stage's words (hub/model/verifyStage.ts, board I2). The point of these is the honesty rule: a verdict
// that could not run says so and is never described as a pass, and a project with nothing to run is not offered one.
import { describe, expect, it, vi } from "vitest";
import type { Block } from "../../sessions/model/session";
import type { VerifyRecord, VerifyStatus, VerifyStep } from "./verifyStage";
import {
  citeStage,
  latestVerifyStage,
  runVerifyStage,
  stageAge,
  stageProves,
  stageReadiness,
  stageOutcomeWord,
  touchedPaths,
  verifyStageStatus,
} from "./verifyStage";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
import { invoke } from "@tauri-apps/api/core";

const now = Date.UTC(2026, 9, 23, 12, 0);

function step(over: Partial<VerifyStep>): VerifyStep {
  return {
    kind: "check",
    id: "check",
    name: "Web checks",
    outcome: "passed",
    detail: "ran and passed",
    runId: "r1",
    logPath: "/tmp/log",
    seconds: 4,
    ...over,
  };
}

function record(over: Partial<VerifyRecord>): VerifyRecord {
  return {
    id: "v1",
    projectRoot: "/repo",
    checkout: "/repo",
    startedAt: now - 120_000,
    endedAt: now - 60_000,
    outcome: "passed",
    summary: "Verified: Web checks passed.",
    steps: [step({})],
    gaps: [],
    changedFiles: ["src/a.ts"],
    ...over,
  };
}

describe("a citation says only what the verdict can stand behind", () => {
  it("names a pass and what ran", () => {
    const line = citeStage(record({}), now);
    expect(line).toContain("Verification (1 min ago)");
    expect(line).toContain("every check that ran passed");
    expect(line).toContain("Web checks: ran and passed");
  });

  it("a failure is not proven", () => {
    const line = citeStage(
      record({ outcome: "failed", steps: [step({ outcome: "failed", detail: "failed (exit 1)" })] }),
      now,
    );
    expect(line).toContain("failed");
    expect(line).toContain("Not proven");
    expect(line).not.toMatch(/\bpassed\b/i);
    expect(line).not.toContain("every check");
  });

  it("a verdict that could not be exercised is not a pass", () => {
    const line = citeStage(
      record({
        outcome: "couldNotExercise",
        steps: [step({ kind: "realPath", name: "Real path", outcome: "couldNotExercise", detail: "the bench could not run" })],
      }),
      now,
    );
    expect(line).toContain("couldn't exercise this change");
    expect(line).toContain("Not proven");
    expect(line).not.toMatch(/\bpassed\b/i);
  });

  it("nothing run says so and is not a pass", () => {
    const line = citeStage(record({ outcome: "notRun", steps: [] }), now);
    expect(line).toContain("ran nothing");
    expect(line).toContain("Not a pass");
    expect(line).not.toMatch(/\bpassed\b/i);
  });

  it("only a pass may stand behind a done claim", () => {
    expect(stageProves(record({ outcome: "passed" }))).toBe(true);
    expect(stageProves(record({ outcome: "failed" }))).toBe(false);
    expect(stageProves(record({ outcome: "couldNotExercise" }))).toBe(false);
    expect(stageProves(record({ outcome: "notRun" }))).toBe(false);
    expect(stageProves(null)).toBe(false);
  });

  it("names a folder no check covers, even in a passing verdict", () => {
    const line = citeStage(record({ gaps: ["src-tauri/"] }), now);
    expect(line).toContain("every check that ran passed");
    expect(line).toContain("No checks are declared for src-tauri/");
  });

  it("uses words a person would say", () => {
    expect(stageOutcomeWord("passed")).toBe("passed");
    expect(stageOutcomeWord("couldNotExercise")).toBe("couldn't be exercised");
    expect(stageOutcomeWord("notRun")).toBe("not run");
  });

  it("shows how old a verdict is", () => {
    expect(stageAge(now - 20_000, now)).toBe("just now");
    expect(stageAge(now - 4 * 60_000, now)).toBe("4 min ago");
    expect(stageAge(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(stageAge(now - 2 * 86_400_000, now)).toBe("2 d ago");
  });
});

describe("the card only offers to run what can run", () => {
  const status = (over: Partial<VerifyStatus>): VerifyStatus => ({
    projectRoot: "/repo",
    checkout: "/repo",
    imported: true,
    verify: { checks: [{ id: "web", name: "Web checks", command: "npm run check" }] },
    note: null,
    latest: null,
    ...over,
  });

  it("runs when the project is imported and declares something", () => {
    expect(stageReadiness(status({})).canRun).toBe(true);
    expect(stageReadiness(status({ verify: { realPath: { command: "npm run verify-live" } } })).canRun).toBe(true);
  });

  it("says why when the project file is not imported", () => {
    const ready = stageReadiness(
      status({ imported: false, verify: {}, note: "This project's .monocode/project.json isn't imported yet." }),
    );
    expect(ready.canRun).toBe(false);
    expect(ready.why).toContain("isn't imported yet");
  });

  it("says why when nothing is declared", () => {
    const ready = stageReadiness(status({ verify: {} }));
    expect(ready.canRun).toBe(false);
    expect(ready.why).toContain("nothing to run");
  });

  it("is honest outside the app", () => {
    expect(stageReadiness(null)).toEqual({ canRun: false, why: "Verification isn't available here." });
  });
});

describe("the stage reads the turn's own writes", () => {
  const write = (id: string, path: string): Block => ({
    id,
    role: "tool",
    text: "",
    tool: { callId: id, title: "Write", kind: "execute", status: "completed", preview: { kind: "write", path } },
  });

  it("keeps write paths once each, in order", () => {
    const turn = [
      write("a", "src/save.ts"),
      write("b", "src/save.ts"),
      write("c", "/repo/src-tauri/src/lib.rs"),
      { id: "r", role: "tool", text: "", tool: { callId: "r", title: "Read", kind: "read", status: "completed", preview: { kind: "read", path: "README.md" } } } as Block,
      { id: "s", role: "tool", text: "", tool: { callId: "s", title: "npm test", kind: "execute", status: "completed", preview: { kind: "shell", title: "npm test" } } } as Block,
    ];
    expect(touchedPaths(turn)).toEqual(["src/save.ts", "/repo/src-tauri/src/lib.rs"]);
  });

  it("keeps every file of a multi-file edit", () => {
    const edit: Block = {
      id: "m",
      role: "tool",
      text: "",
      tool: { callId: "m", title: "Edit", kind: "execute", status: "completed", paths: ["src/a.ts", "src/b.ts"] },
    };
    expect(touchedPaths([edit])).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("names no paths when the turn wrote nothing", () => {
    expect(touchedPaths([])).toEqual([]);
  });
});

describe("the invokes use the names the Rust side reads", () => {
  it("passes the turn's paths, and null so the stage can read git", async () => {
    await verifyStageStatus("/repo");
    expect(invoke).toHaveBeenCalledWith("verify_stage_status", { cwd: "/repo" });
    await runVerifyStage("/repo", ["src/a.ts"]);
    expect(invoke).toHaveBeenCalledWith("verify_stage_run", { cwd: "/repo", paths: ["src/a.ts"] });
    await runVerifyStage("/repo", []);
    expect(invoke).toHaveBeenCalledWith("verify_stage_run", { cwd: "/repo", paths: null });
    await latestVerifyStage("/repo");
    expect(invoke).toHaveBeenCalledWith("verify_stage_latest", { cwd: "/repo" });
  });
});
