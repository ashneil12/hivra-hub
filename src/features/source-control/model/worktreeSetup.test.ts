import { describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../../../integrations/harness/core/types";
import type {
  ActionRun,
  ProjectActionEvent,
  WorktreeSetup,
} from "../../projects/model/projectActions";
import { showWorktreeSetup } from "./worktreeSetup";

const run = (over: Partial<ActionRun> = {}): ActionRun => ({
  id: "setup-1",
  projectRoot: "/repo",
  cwd: "/wt/feature",
  actionId: "setup",
  actionName: "Setup",
  command: "node scripts/setup-worktree.mjs",
  trigger: "worktree-create",
  status: "running",
  exitCode: null,
  startedAt: 1,
  endedAt: null,
  logPath: "/data/action-runs/setup-1.log",
  tail: [],
  longRunning: false,
  error: null,
  ...over,
});

const setup = (over: Partial<WorktreeSetup> = {}): WorktreeSetup => ({
  actionId: "setup",
  name: "Setup",
  command: "node scripts/setup-worktree.mjs",
  hold: true,
  run: run(),
  skipped: null,
  ...over,
});

function bench(finalRun: ActionRun) {
  const events: HarnessEvent[] = [];
  let handler: ((event: ProjectActionEvent) => void) | undefined;
  const subscribe = vi.fn((h: (event: ProjectActionEvent) => void) => {
    handler = h;
    return () => {
      handler = undefined;
    };
  });
  let calls = 0;
  const wait = vi.fn(async () => {
    calls += 1;
    if (calls === 1) {
      handler?.({ runId: "setup-1", line: "setup: node_modules linked" });
      handler?.({ runId: "other", line: "not ours" });
      return run();
    }
    return finalRun;
  });
  return { events, emit: (event: HarnessEvent) => events.push(event), subscribe, wait, handler: () => handler };
}

describe("worktree setup in the chat", () => {
  it("holds until setup ends and shows its log as a shell step", async () => {
    const b = bench(run({ status: "succeeded", exitCode: 0, tail: ["setup: done"] }));
    const finished = await showWorktreeSetup(setup(), b);
    expect(finished?.status).toBe("succeeded");
    expect(b.wait).toHaveBeenCalledTimes(2);
    expect(b.events[0]).toMatchObject({
      type: "tool.started",
      callId: "worktree-setup-setup-1",
      title: "node scripts/setup-worktree.mjs",
      kind: "execute",
    });
    const last = b.events.at(-1)!;
    expect(last).toMatchObject({ type: "tool.updated", status: "completed" });
    expect((last as { detail: string }).detail).toContain("node_modules linked");
    expect((last as { detail: string }).detail).not.toContain("not ours");
    expect(b.handler()).toBeUndefined();
    expect(b.events.some((event) => event.type === "notice")).toBe(false);
  });

  it("lets the agent start after a failed setup, and says so", async () => {
    const b = bench(run({ status: "failed", exitCode: 1 }));
    await showWorktreeSetup(setup(), b);
    expect(b.events.at(-2)).toMatchObject({ type: "tool.updated", status: "failed" });
    expect(b.events.at(-1)).toMatchObject({ type: "notice", level: "warning" });
    expect((b.events.at(-1) as { text: string }).text).toContain("failed (exit 1)");
    expect((b.events.at(-1) as { text: string }).text).toContain("The agent starts anyway");
  });

  it("stops waiting when the turn is cancelled", async () => {
    const b = bench(run({ status: "succeeded" }));
    let cancelled = false;
    b.wait.mockImplementationOnce(async () => {
      cancelled = true;
      return run();
    });
    const finished = await showWorktreeSetup(setup(), { ...b, cancelled: () => cancelled });
    expect(finished?.status).toBe("running");
    expect((b.events.at(-1) as { detail: string }).detail).toContain("stopped waiting");
  });

  it("doesn't wait when the setup doesn't hold, and notes a skipped setup", async () => {
    const b = bench(run({ status: "succeeded" }));
    expect(await showWorktreeSetup(setup({ hold: false }), b)).toBeNull();
    expect(b.events[0]).toMatchObject({ type: "tool.started" });

    const skipped = bench(run());
    await showWorktreeSetup(
      setup({ run: null, skipped: "Setup didn't run: this project's .monocode/project.json isn't imported yet" }),
      skipped,
    );
    expect(skipped.events).toEqual([
      expect.objectContaining({ type: "notice", text: expect.stringContaining("isn't imported") }),
    ]);
    expect(await showWorktreeSetup(undefined, skipped)).toBeNull();
  });
});
