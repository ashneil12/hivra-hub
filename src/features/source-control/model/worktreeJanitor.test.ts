import { describe, expect, it } from "vitest";
import {
  buildOutputBytes,
  buildOutputFolders,
  formatAge,
  formatBytes,
  tapBytes,
  tapTargets,
  type JanitorEntry,
  type JanitorReport,
} from "./worktreeJanitor";
import { applyActionEvent } from "../ui/ProjectActionsPanel";
import type { ActionRun, ActionsListing } from "../../projects/model/projectActions";
import { waitForRun } from "../../projects/model/projectActions";

const entry = (
  name: string,
  outcome: JanitorEntry["verdict"]["outcome"],
  freeableBytes: number,
  reclaimBytes: number,
): JanitorEntry => ({
  path: `/w/${name}`,
  kind: "linked",
  repo: "/repo",
  branch: name,
  head: "abc",
  chats: 0,
  lastActivity: 0,
  totalBytes: reclaimBytes,
  buildOutput: [],
  verdict: { outcome, state: outcome, reason: "", freeableBytes, reclaimBytes },
});

const report = (entries: JanitorEntry[]): JanitorReport => ({
  generatedAt: 0,
  roots: ["/w"],
  entries,
  totalBytes: 0,
  buildOutputBytes: 0,
  buildOutputCount: 0,
  removeCount: 0,
  removeBytes: 0,
  freeCount: 0,
  freeBytes: 0,
  keepCount: 0,
  notes: [],
});

describe("clean-up taps", () => {
  it("remove takes merged worktrees only; free takes every non-kept one with build output", () => {
    const r = report([
      entry("merged", "remove", 500, 900),
      entry("idle", "free", 2_000, 2_000),
      entry("kept", "keep", 0, 0),
      entry("merged-small", "remove", 0, 10),
    ]);
    const remove = tapTargets(r, "remove");
    expect(remove.map((e) => e.branch)).toEqual(["merged", "merged-small"]);
    expect(tapBytes(remove, "remove")).toBe(910);
    const free = tapTargets(r, "free");
    expect(free.map((e) => e.branch)).toEqual(["merged", "idle"]);
    expect(tapBytes(free, "free")).toBe(2_500);
  });

  it("adds up the build output a worktree holds, never counting a link", () => {
    const output = {
      buildOutput: [
        { path: "node_modules", bytes: 400_000_000, linked: false, ignored: true },
        { path: "target", bytes: 9_100_000_000, linked: false, ignored: true },
        { path: "dist", bytes: 0, linked: false, ignored: true },
        { path: "coverage", bytes: null, linked: false, ignored: true },
        { path: ".next", bytes: 5_000, linked: true, ignored: false },
      ],
    };
    expect(buildOutputBytes(output)).toBe(9_500_000_000);
    // Biggest first; an empty folder and a link are left out; one that couldn't be measured is said so.
    expect(buildOutputFolders(output)).toBe(
      "target 9.1 GB, node_modules 400 MB, coverage size unknown",
    );
    expect(buildOutputBytes({ buildOutput: [] })).toBe(0);
    expect(buildOutputFolders({ buildOutput: [] })).toBe("");
  });

  it("formats sizes and ages like the report", () => {
    expect(formatBytes(null)).toBe("size unknown");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(43_200_000_000)).toBe("43.2 GB");
    expect(formatBytes(250_000_000_000)).toBe("250 GB");
    expect(formatAge(5 * 60_000)).toBe("5 min");
    expect(formatAge(3_600_000)).toBe("1 hour");
    expect(formatAge(9 * 86_400_000)).toBe("9 days");
  });
});

const run = (over: Partial<ActionRun> = {}): ActionRun => ({
  id: "r1",
  projectRoot: "/repo",
  cwd: "/repo",
  actionId: "check",
  actionName: "Check",
  command: "npm run check",
  trigger: "app",
  status: "running",
  exitCode: null,
  startedAt: 2,
  endedAt: null,
  logPath: "/l",
  tail: [],
  longRunning: false,
  error: null,
  ...over,
});

describe("live action runs", () => {
  const listing = (runs: ActionRun[]): ActionsListing => ({
    status: {
      projectRoot: "/repo",
      path: "/repo/.monocode/project.json",
      state: "trusted",
      error: null,
      fileHash: "h",
      file: null,
      trustedHash: "h",
      trusted: null,
      importedAt: 1,
    },
    actions: [],
    runs,
  });

  it("adds runs, appends lines, and keeps the finished record", () => {
    let current = applyActionEvent(listing([run({ id: "old", startedAt: 1, status: "succeeded" })]), {
      runId: "r1",
      run: run(),
    });
    expect(current.runs.map((r) => r.id)).toEqual(["r1", "old"]);
    current = applyActionEvent(current, { runId: "r1", line: "one" });
    current = applyActionEvent(current, { runId: "r1", line: "two" });
    expect(current.runs[0].tail).toEqual(["one", "two"]);
    // A late start record never wipes lines already shown.
    current = applyActionEvent(current, { runId: "r1", run: run() });
    expect(current.runs[0].tail).toEqual(["one", "two"]);
    current = applyActionEvent(current, {
      runId: "r1",
      run: run({ status: "failed", exitCode: 2, tail: ["one", "two", "three"] }),
    });
    expect(current.runs[0]).toMatchObject({ status: "failed", exitCode: 2 });
    expect(applyActionEvent(current, { runId: "r1", line: "late" })).toBe(current);
    expect(applyActionEvent(current, { runId: "x", run: run({ id: "x", projectRoot: "/other" }) })).toBe(current);
  });

  it("waits for a run in short steps until it ends or is cancelled", async () => {
    const steps = [run(), run(), run({ status: "succeeded" })];
    const wait = async () => steps.shift()!;
    expect((await waitForRun(run(), { wait })).status).toBe("succeeded");
    let cancel = false;
    const forever = async () => {
      cancel = true;
      return run();
    };
    expect((await waitForRun(run(), { wait: forever, cancelled: () => cancel })).status).toBe(
      "running",
    );
  });
});
