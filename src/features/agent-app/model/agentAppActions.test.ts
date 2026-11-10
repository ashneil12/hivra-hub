// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { newSession } from "../../sessions/model/session";
import type { Worktree } from "../../source-control/model/worktrees";
import type {
  ActionRun,
  ActionsListing,
  ProjectFileStatus,
} from "../../projects/model/projectActions";
import { actionsListing, handleAgentApp, type AgentAppHost } from "./agentApp";

beforeEach(() => {
  localStorage.setItem("monocode:hub-team-pack", "ash"); // Ash's install: the app's words name him (userName.ts)
});

vi.mock("../../../integrations/harness/core/availability", () => ({
  isHarnessAvailable: (id: string) => id === "codex",
}));

const feature: Worktree = {
  path: "/tmp/project-worktrees/feature",
  branch: "feature",
  head: "abc123",
  isMain: false,
  locked: false,
  prunable: false,
  missing: false,
  dirty: false,
  unpushed: 0,
  sessionIds: [],
};

const status = (state: ProjectFileStatus["state"]): ProjectFileStatus => ({
  projectRoot: "/tmp/project",
  path: "/tmp/project/.monocode/project.json",
  state,
  error: null,
  fileHash: "h",
  file: null,
  trustedHash: state === "trusted" ? "h" : null,
  trusted: null,
  importedAt: null,
});

const run = (over: Partial<ActionRun> = {}): ActionRun => ({
  id: "run-1",
  projectRoot: "/tmp/project",
  cwd: "/tmp/project",
  actionId: "check",
  actionName: "Check",
  command: "npm run check",
  trigger: "agent",
  status: "running",
  exitCode: null,
  startedAt: 1,
  endedAt: null,
  logPath: "/data/action-runs/run-1.log",
  tail: Array.from({ length: 50 }, (_, i) => `line ${i}`),
  longRunning: false,
  error: null,
  ...over,
});

function fixture(listing: Partial<ActionsListing> = {}) {
  const source = newSession("codex", "/tmp/project", "codex:test");
  source.id = "lead";
  const host: AgentAppHost = {
    start: vi.fn(async () => {}),
    sessions: vi.fn(async () => []),
    session: vi.fn(async () => null),
    send: vi.fn(async () => ({ alreadySubmitted: false })),
    draft: vi.fn(async () => ({ alreadySaved: false, draft: true })),
    stop: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    worktrees: vi.fn(async () => ({
      worktrees: [
        { ...feature },
        { ...feature, path: source.cwd, isMain: true, branch: "main" },
      ],
      defaultRoot: "/tmp/project-worktrees",
    })),
    createWorktree: vi.fn(async () => ({ ...feature })),
    notes: vi.fn(async () => []),
    note: vi.fn(async () => null),
    saveNote: vi.fn(async (input) => ({ ...input, id: "n", slug: "n", title: "n", tags: [], slugPending: false, createdAt: 1, updatedAt: 1 }) as never),
    isMono: () => false,
    projectActions: vi.fn(async () => ({
      status: status("trusted"),
      actions: [
        { id: "setup", name: "Setup", command: "node scripts/setup-worktree.mjs", runOnWorktreeCreate: true },
        { id: "check", name: "Check", command: "npm run check" },
      ],
      runs: [run({ status: "succeeded", exitCode: 0 })],
      ...listing,
    })),
    runProjectAction: vi.fn(async (cwd: string) => run({ cwd })),
    waitProjectAction: vi.fn(async () => run({ status: "failed", exitCode: 1 })),
  };
  return { source, host };
}

describe("project actions for agents", () => {
  it("lists only the imported actions, with recent runs and short tails", async () => {
    const { source, host } = fixture();
    const result = (await handleAgentApp(source, "a1", "actions.list", {}, host)) as ReturnType<
      typeof actionsListing
    >;
    expect(host.projectActions).toHaveBeenCalledWith("/tmp/project");
    expect(result.projectFile.state).toBe("trusted");
    expect(result.actions.map((action) => action.id)).toEqual(["setup", "check"]);
    expect(result.actions[0]).toMatchObject({ runOnWorktreeCreate: true });
    expect(result.runs[0]).toMatchObject({ runId: "run-1", status: "succeeded", exitCode: 0 });
    expect(result.runs[0].tail).toHaveLength(20);
    expect(result).not.toHaveProperty("note");
  });

  it("reads the stack's name and fake services, and nothing else", async () => {
    const { source, host } = fixture();
    const status = {
      declared: true,
      url: "http://shop-wp-90.localhost:7400",
      mode: "Tests use fake GitHub",
      stacks: [
        {
          id: "s01234567",
          names: [{ hostname: "github-wp-90.localhost", url: "http://github-wp-90.localhost:7400" }],
          emulated: ["github"],
          running: true,
        },
      ],
    };
    host.stacks = vi.fn(async () => status);
    const result = await handleAgentApp(source, "s1", "stacks.list", {}, host);
    expect(host.stacks).toHaveBeenCalledWith("/tmp/project");
    expect(result).toEqual(status);
    await expect(
      handleAgentApp(source, "s2", "stacks.list", { start: true }, host),
    ).rejects.toThrow("Unknown stacks.list fields: start");
  });

  it("says when Ash hasn't imported the project file", () => {
    const listing = actionsListing({ status: status("new"), actions: [], runs: [] });
    expect(listing.actions).toEqual([]);
    expect(listing.note).toContain("hasn't imported");
    expect(actionsListing({ status: status("changed"), actions: [], runs: [] }).note).toContain(
      "imported version still runs",
    );
  });

  it("runs in the caller's own worktree by default, or a chosen one, and can wait", async () => {
    const { source, host } = fixture();
    source.worktreeCwd = feature.path;
    const started = await handleAgentApp(source, "r1", "actions.run", { action: "check" }, host);
    expect(host.runProjectAction).toHaveBeenCalledWith(feature.path, "check");
    expect(started).toMatchObject({ runId: "run-1", status: "running" });
    expect((started as { note: string }).note).toContain("actions.list");

    await handleAgentApp(
      source,
      "r2",
      "actions.run",
      { action: "check", worktreeCwd: "/tmp/project" },
      host,
    );
    expect(host.runProjectAction).toHaveBeenLastCalledWith("/tmp/project", "check");

    const waited = await handleAgentApp(
      source,
      "r3",
      "actions.run",
      { action: "check", waitSeconds: 20 },
      host,
    );
    expect(host.waitProjectAction).toHaveBeenCalledWith("run-1", 20_000);
    expect(waited).toMatchObject({ status: "failed", exitCode: 1 });
  });

  it("refuses checkouts outside the project and bad waits", async () => {
    const { source, host } = fixture();
    await expect(
      handleAgentApp(source, "x1", "actions.run", { action: "check", worktreeCwd: "/elsewhere" }, host),
    ).rejects.toThrow("Worktree is unavailable");
    await expect(
      handleAgentApp(source, "x2", "actions.run", { action: "check", waitSeconds: 60 }, host),
    ).rejects.toThrow("waitSeconds");
    await expect(
      handleAgentApp(source, "x3", "actions.run", { action: "check", command: "rm -rf ~" }, host),
    ).rejects.toThrow("Unknown actions.run fields: command");
    expect(host.runProjectAction).not.toHaveBeenCalled();
  });

  it("never runs an action that asks Ash first, and lists which ones do", async () => {
    const { source, host } = fixture({
      actions: [
        { id: "check", name: "Check", command: "npm run check" },
        { id: "ship", name: "Ship", command: "npm run hub:ship", confirm: "Replace the daily app?" },
      ],
    });
    await expect(handleAgentApp(source, "c1", "actions.run", { action: "ship" }, host)).rejects.toThrow(
      "Ship asks Ash first; ask him in your chat",
    );
    expect(host.runProjectAction).not.toHaveBeenCalled();
    const listing = (await handleAgentApp(source, "c2", "actions.list", {}, host)) as ReturnType<typeof actionsListing>;
    expect(listing.actions.find((action) => action.id === "ship")).toMatchObject({ confirm: true });
    expect(listing.actions.find((action) => action.id === "check")).not.toHaveProperty("confirm");
    await handleAgentApp(source, "c3", "actions.run", { action: "check" }, host);
    expect(host.runProjectAction).toHaveBeenCalledWith("/tmp/project", "check");
  });

  it("creates a worktree with or without its setup, and says when setup is still running", async () => {
    const { source, host } = fixture();
    vi.mocked(host.createWorktree).mockResolvedValueOnce({
      ...feature,
      setup: {
        actionId: "setup",
        name: "Setup",
        command: "node scripts/setup-worktree.mjs",
        hold: true,
        run: run({ id: "setup-run", actionId: "setup" }),
        skipped: null,
      },
    });
    const created = await handleAgentApp(source, "w1", "worktrees.create", { branch: "feature" }, host);
    expect(host.createWorktree).toHaveBeenLastCalledWith(source.cwd, "feature", "HEAD", false);
    expect((created as { setupNote: string }).setupNote).toContain("setup-run");

    await handleAgentApp(source, "w2", "worktrees.create", { branch: "other", runSetup: false }, host);
    expect(host.createWorktree).toHaveBeenLastCalledWith(source.cwd, "other", "HEAD", false, {
      runSetup: false,
    });
    await expect(
      handleAgentApp(source, "w3", "worktrees.create", { branch: "x", runSetup: "no" }, host),
    ).rejects.toThrow("runSetup must be a boolean");
  });
});
