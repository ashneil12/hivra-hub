// @vitest-environment happy-dom
// The delegate tool's app actions (agentAppTasks.ts): who may call them, what a delegation starts and records, and that
// a chat only ever sees and moves its own tasks. The store is a stand-in with delegations.rs's owner rule.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newSession, type Session } from "../../sessions/model/session";
import {
  nativeModelId,
  resetHarnessModelOverlays,
  setHarnessModels,
} from "../../sessions/model/models";
import type { Delegation } from "../../monos/model/delegations";
import { askFakeClaude, fakeClaudeLaunch } from "../../phases/model/fakeClaude";
import { begin, counter } from "../../phases/model/machine";
import { deliverPhaseResult } from "../../phases/model/phaseBridge";
import { loadPhaseSettings, savePhaseSettings, seedWork, taskForCrew, workFor } from "../../phases/model/store";
import { handleAgentApp as handleRaw, type AgentAppHost } from "./agentApp";
import { handleWithBriefParts as handleAgentApp, TEST_GOAL, TEST_INTENT } from "../../firstmate/testing/briefParts";
import { renderBrief, type BriefIsolation } from "../../firstmate/model/brief";
import { classifyBriefTask } from "../../firstmate/model/briefSkills";
import {
  briefPrompt,
  markAppDelegate,
  portOfBrief,
  WORKER_PORT_BASE,
  WORKER_PORT_SPAN,
  workerPort,
  workerRules,
  type AgentAppTasksHost,
} from "./agentAppTasks";
import { goalFromBrief } from "../../../integrations/harness/providers/claude/claudeGoal";
import {
  memoryWorkerQueue,
  pumpWorkers,
  queuedWorkers,
  setWorkerQueueBackend,
  resetWorkerPool,
  setProjectWorkerModel,
  setSystemWorkerDefault,
  setWorkerLimits,
  workerLimits,
  workerPoolHost,
  type ProviderRoom,
} from "../../monos/model/workerPool";
import { isOpenDelegation } from "../../monos/model/delegations";
import { fanoutDependency, forgetVerifications, settleFanout, verificationOf } from "../../firstmate/model/fanoutChecks";
import type { DependencyLookup } from "../../firstmate/model/fanoutWaves";
import { addMono, findMono, updateMono } from "../../monos/model/mono";
import { setLineRulesSource } from "../../crew/model/lineRules";
import { customModelRoute, importCustomModels } from "../../sessions/model/customModels";
import { launchCatalog } from "../../crew/model/launchCatalog";
import { resolveRoute } from "../../crew/model/resolve";
import type { CrewRouteQuery } from "../../crew/model/taskRoute";
import {
  buildClaudeSpawnArgs,
  normalizeClaudeCliEffort,
  resolveClaudeApiModelId,
} from "../../../integrations/harness/providers/claude/claudeProtocol";
import { parseCliArgs } from "../../../../scripts/fake-claude.mjs";

// `onlyClaude` is a bench plan (src-tauri/src/verify_live.rs): no CLI but the run's own Claude wrapper resolves.
// `codexOff` is a Mac without the Codex CLI: the setting is in force, the binary simply isn't installed.
const probe = vi.hoisted(() => ({ probed: true, runs: 0, onlyClaude: false, codexOff: false }));
// The DeepSeek launcher can be on or off for a case. The Grok CLI stays available either way.
const bridge = vi.hoisted(() => ({ on: false }));
vi.mock("../../../integrations/harness/providers/claude/claudeDeepseekBridge", async (actual) => {
  const real = await actual<typeof import("../../../integrations/harness/providers/claude/claudeDeepseekBridge")>();
  return { ...real, claudeRunsOnSubscriptionBridge: () => bridge.on };
});
// Hivra WP-10 review: hub.change goes through tasks.delegate; its preview copy is stood in for here.
vi.mock("../../selfBuild/model/hubCode", async (actual) => ({
  ...(await actual<typeof import("../../selfBuild/model/hubCode")>()),
  startHubChange: vi.fn(async () => ({ changeId: "hc-1", folder: PROJECT_PREVIEW })),
}));
const PROJECT_PREVIEW = "/tmp/hub-preview";

vi.mock("../../../integrations/harness/core/availability", () => ({
  // Before the first probe ends every harness reads as missing. A bench plan resolves only the Claude wrapper.
  isHarnessAvailable: (id: string) =>
    probe.probed &&
    (id === "claude" ||
      (!probe.onlyClaude && ((id === "codex" && !probe.codexOff) || (bridge.on && id === "grok")))),
  hasProbedHarnessAvailability: () => probe.probed,
  probeHarnessAvailability: async () => {
    probe.runs += 1;
    probe.probed = true;
  },
}));

const storedValues = new Map<string, string>();
vi.stubGlobal("localStorage", {
  clear: () => storedValues.clear(),
  getItem: (key: string) => storedValues.get(key) ?? null,
  setItem: (key: string, value: string) => storedValues.set(key, value),
  removeItem: (key: string) => storedValues.delete(key),
});

const PROJECT = "/tmp/vg-game";
/** Hivra WP-10: a worker's brief body, from the template around the test's intent and spec. */
const scaffold = (spec: string, isolation: BriefIsolation = { kind: "shared", folder: PROJECT }) =>
  renderBrief({ intent: TEST_INTENT, spec }, isolation, classifyBriefTask(`${TEST_INTENT}\n${spec}`));

beforeEach(() => {
  localStorage.setItem("monocode:hub-team-pack", "ash"); // Ash's install: the app's words name him (userName.ts)
  setHarnessModels("claude", [
    { id: "claude:opus-5-5", harness: "claude", name: "Opus 5.5", settings: [] },
    { id: "claude:sonnet-5", harness: "claude", name: "Sonnet 5", settings: [] },
    { id: "claude:sonnet-4.6", harness: "claude", name: "Sonnet 4.6", settings: [] },
  ]);
});

afterEach(() => resetHarnessModelOverlays());

function row(patch: Partial<Delegation> & Pick<Delegation, "id">): Delegation {
  return {
    ownerSession: "mono-exo",
    ownerMono: "vg-game-lead",
    batchId: "turn-1",
    parentId: null,
    rootId: patch.id,
    childSession: `app-mono-exo-${patch.id}`,
    requestId: `app-mono-exo-${patch.id}`,
    generation: 1,
    project: "vg-game",
    title: "Fix the save bug",
    brief: "Fix it",
    goal: null,
    askIds: [],
    state: "running",
    errorClass: null,
    error: null,
    retryable: null,
    resetsAt: null,
    result: null,
    pendingQuestion: null,
    delivery: "pending",
    deliveryMessage: null,
    createdAt: 1_000,
    updatedAt: 2_000,
    settledAt: null,
    log: [],
    version: 1,
    mirroredVersion: 0,
    mirrorError: null,
    ...patch,
  };
}

/** The rows, with delegations.rs's rule: a chat's queries only ever return its own. */
function tasksHost(rows: Delegation[], clock = { now: 0 }) {
  const acknowledged: string[] = [];
  const cancelled: Array<[string, string]> = [];
  const answered: unknown[] = [];
  /** tasks.cannot, as the row would record it: the caller, the task, the reason. */
  const declared: Array<[string, string, string]> = [];
  const host: AgentAppTasksHost = {
    owned: vi.fn(async (owner, query) => {
      const mine = rows.filter((entry) => entry.ownerSession === owner);
      if (!query.ids?.length && !query.requestIds?.length)
        return mine.filter(
          (entry) =>
            entry.state === "running" ||
            entry.state === "question" ||
            entry.delivery === "pending" ||
            entry.delivery === "queued",
        );
      return mine.filter(
        (entry) =>
          query.ids?.includes(entry.id) || query.requestIds?.includes(entry.requestId),
      );
    }),
    tree: vi.fn(async (id) => rows.filter((entry) => entry.rootId === id)),
    acknowledge: vi.fn(async (_owner, read) => {
      for (const entry of read) {
        acknowledged.push(entry.id);
        entry.delivery = "acknowledged";
      }
    }),
    nextChange: vi.fn(async (ms) => {
      clock.now += ms;
    }),
    cancel: vi.fn(async (_owner, entry, reason) => {
      cancelled.push([entry.id, reason]);
      entry.state = "cancelled";
      entry.delivery = "disposed";
      return { stopFailed: [] };
    }),
    answer: vi.fn(async (...args) => {
      answered.push(args.slice(1));
    }),
    // The running task working in a chat itself (tasks.cannot with no taskId).
    selfTask: vi.fn(async (session: string) =>
      rows.find((entry) => entry.childSession === session && entry.state === "running"),
    ),
    // The declared block, as delegations.rs records it: only a running row takes it.
    cannot: vi.fn(async (by: string, entry: Delegation, reason: string) => {
      if (entry.state !== "running") return false;
      declared.push([by, entry.id, reason]);
      Object.assign(entry, { stallKind: "blocked", stallReason: reason, stalledAt: clock.now });
      return true;
    }),
    child: (id) =>
      id === "app-mono-exo-t-busy" ? { busy: true, lastActiveAt: 9_000 } : undefined,
    hubProjectId: (folder) => (folder === PROJECT ? "vg-game" : undefined),
    hubProjectFolder: (id) => (id === "vg-game" ? PROJECT : undefined),
    now: () => clock.now,
  };
  return { api: host, acknowledged, cancelled, answered, declared, clock };
}

/** What the window is handed on a bench (appIdentity.ts): a dev copy with a verify plan. */
function benchIdentity() {
  return {
    product: "MonoCode Hub Dev",
    version: "0.16.0",
    identifier: "com.ash.monocode-hub.dev.verify",
    kind: "dev",
    slot: "verify",
    stamp: { sha: "09141d88a1b2c3d4e5f60718293a4b5c6d7e8f90", branch: "bench", dirty: false, builtAt: "2026-11-05T00:00:00Z" },
    schemaVersion: 19,
    policy: {},
    verify: { runId: "bench-1" },
  };
}

function fixture(
  rows: Delegation[] = [],
  who: "mono" | "plain" | "habit" | "checker" | "worker" | "team" = "mono",
  onPhase?: (launch: { prompt: string }, id: string) => Promise<void>,
) {
  const source: Session = {
    ...newSession("claude", PROJECT, "claude:opus-5-5"),
    id: who === "worker" ? "app-mono-exo-r0" : who === "checker" ? "mono-checker" : who === "team" ? "team-exo" : "mono-exo",
  };
  const tasks = tasksHost(rows);
  const started: unknown[][] = [];
  const host: AgentAppHost = {
    start: vi.fn(async (...args: unknown[]) => {
      started.push(args);
      const [launch, id, , notify, meta] = args as [
        { prompt: string; cwd?: string },
        string,
        unknown,
        string,
        { title?: string; project?: string } | undefined,
      ];
      // WP-84: a phase worker's reply is the document. It is not a coding-worker row.
      if (id.includes("-phase-")) {
        if (onPhase) await onPhase(launch, id);
        else deliverPhaseResult(id, { body: "A fact about the code." });
        return;
      }
      // As the app records it: the hub project id, else the folder the worker runs in.
      rows.push(
        row({
          id: `t-${rows.length + 1}`,
          ownerSession: notify,
          childSession: id,
          requestId: id,
          title: meta?.title ?? "",
          brief: launch.prompt,
          project: meta?.project ?? launch.cwd ?? null,
        }),
      );
    }),
    sessions: vi.fn(async () => []),
    session: vi.fn(async () => null),
    send: vi.fn(async () => ({ alreadySubmitted: false })),
    draft: vi.fn(async () => ({ alreadySaved: false, draft: true })),
    stop: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    worktrees: vi.fn(async () => ({ worktrees: [], defaultRoot: "/tmp/w" })),
    createWorktree: vi.fn(),
    notes: vi.fn(async () => []),
    note: vi.fn(async () => null),
    saveNote: vi.fn(),
    agentFiles: vi.fn(),
    readAgentFile: vi.fn(),
    writeAgentFile: vi.fn(),
    isMono: () => who === "mono" || who === "checker",
    isHabitRun: () => who === "habit",
    codingTeamOf: () => (who === "team" ? { project: "vg-game", name: "EXO coding team", folder: PROJECT } : undefined),
    monoOf: () =>
      who === "plain" || who === "worker" || who === "team"
        ? undefined
        : {
            id: who === "checker" ? "checker" : "vg-game-lead",
            name: who === "checker" ? "Checker" : "EXO lead",
            projects: [PROJECT],
          },
    tasks: tasks.api,
  } as unknown as AgentAppHost;
  return { source, host, started, ...tasks };
}

describe("tasks.delegate redoes: the Lead retries or splits its stuck task", () => {
  it("notes the new task on the stuck one, after the worker starts", async () => {
    const stuck = row({ id: "t-stuck", stallKind: "loop", stallReason: "No commits, file changes or test runs for 2 hours" });
    const rows = [stuck];
    const { source, host, api, started } = fixture(rows);
    const redone: Array<[string, string, string]> = [];
    api.redo = vi.fn(async (owner, entry, task) => void redone.push([owner, entry.id, task]));
    const result = await handleAgentApp(source, "r-retry", "tasks.delegate", { brief: "Fix the save bug, smaller: only the slot file.", redoes: "t-stuck" }, host);
    expect(started).toHaveLength(1);
    expect(redone).toEqual([["mono-exo", "t-stuck", (result as { taskId: string }).taskId]]);
  });

  it("refuses another chat's task, or a Lead brief, before anything starts", async () => {
    const theirs = row({ id: "t-theirs", ownerSession: "mono-hivra" });
    const { source, host, api, started } = fixture([theirs]);
    api.redo = vi.fn(async () => undefined);
    await expect(
      handleAgentApp(source, "r-x", "tasks.delegate", { brief: "Take it over.", redoes: "t-theirs" }, host),
    ).rejects.toThrow(/No task t-theirs of yours/);
    const mine = row({ id: "t-mine" });
    const second = fixture([mine]);
    await expect(
      handleAgentApp(second.source, "r-y", "tasks.delegate", { brief: "Hand it on.", lead: "hub", redoes: "t-mine" }, second.host),
    ).rejects.toThrow(/redoes is for your own workers' tasks/);
    expect([...started, ...second.started]).toEqual([]);
    expect(api.redo).not.toHaveBeenCalled();
  });
});

// A Lead on the DeepSeek launcher delegates. Workers run as DeepSeek, including when the Lead names another engine.
describe("tasks.delegate on the DeepSeek launcher: workers run Claude Code on DeepSeek", () => {
  beforeEach(() => {
    bridge.on = true;
    setHarnessModels("grok", [{ id: "grok:grok-4.6", harness: "grok", name: "Grok 4.6", settings: [] }]);
  });
  afterEach(() => {
    bridge.on = false;
  });

  function onBridge() {
    const f = fixture();
    f.source.model = "claude:sonnet-5";
    return f;
  }

  it("starts a worker the app routes itself on the bridge's DeepSeek at high effort", async () => {
    const { source, host, started } = onBridge();
    const result = await handleAgentApp(source, "r-b1", "tasks.delegate", { brief: "Make every window see a lead mid-turn." }, host);
    expect(started).toHaveLength(1);
    expect(started[0][0]).toMatchObject({
      harness: "claude",
      model: "claude:deepseek-v4.1-flash",
      modelSettings: { effort: "high" },
    });
    expect(result).toMatchObject({ harness: "claude", model: "claude:deepseek-v4.1-flash", effort: "High" });
    // r61 (PM): the Lead names it as Ash sees it, not by its raw id.
    expect(result).toMatchObject({ modelName: "DeepSeek V4.1 Flash · High" });
    expect(String((result as { note?: string }).note)).toContain("never the raw model id");
  });

  it("runs DeepSeek or a Grok name the Lead names as DeepSeek, on Claude Code", async () => {
    for (const [asked, model] of [
      ["deepseek-v4.1-flash", "claude:deepseek-v4.1-flash"],
      ["omp:deepseek/deepseek-v4-pro", "claude:deepseek-v4.1-flash"],
      ["grok-4", "claude:deepseek-v4.1-flash"],
      ["grok:grok-4.6", "claude:deepseek-v4.1-flash"],
    ] as const) {
      const { source, host, started } = onBridge();
      await handleAgentApp(source, `r-${asked.replace(/[^a-z0-9]/gi, "")}`, "tasks.delegate", { brief: "Do it.", model: asked }, host);
      expect(started[0][0]).toMatchObject({ harness: "claude", model });
    }
  });

  it("runs another engine's model on the bridge's DeepSeek, and a Claude name too, never the Claude subscription", async () => {
    for (const asked of ["codex:gpt-5.5", "claude:opus-4.6", "sonnet"]) {
      const { source, host, started } = onBridge();
      setHarnessModels("codex", [{ id: "codex:gpt-5.5", harness: "codex", name: "GPT-5.5", settings: [] }]);
      const result = await handleAgentApp(source, `r-${asked.replace(/[^a-z0-9]/gi, "")}`, "tasks.delegate", { brief: "Do it.", model: asked }, host);
      expect(started[0][0]).toMatchObject({ harness: "claude", model: "claude:deepseek-v4.1-flash" });
      if (asked.startsWith("codex:"))
        expect((result as { modelWhy: string }).modelWhy).toContain(`"${asked}" doesn't run on the bridge`);
    }
  });
});

// 28 Oct blind run: each redo/finish worker started in the main checkout, not the first worker's worktree.
describe("tasks.delegate redoes: the redo works where the job did", () => {
  const TREE = "/tmp/vg-game-worktrees/mc-1";
  function withFirstWorker(worktreeCwd: string | undefined, onDisk = true) {
    const first = row({ id: "t-first", childSession: "app-mono-exo-first", state: "failed", delivery: "acknowledged" });
    const f = fixture([first]);
    f.api.redo = vi.fn(async () => undefined);
    f.host.session = vi.fn(async (id: string) =>
      id === "app-mono-exo-first"
        ? ({ ...newSession("claude", PROJECT, "claude:sonnet-5"), id, ...(worktreeCwd ? { worktreeCwd } : {}) } as Session)
        : null,
    );
    f.host.worktrees = vi.fn(async () => ({
      worktrees: onDisk && worktreeCwd ? [{ path: worktreeCwd, branch: "mc/fix", missing: false }] : [],
      defaultRoot: "/tmp/vg-game-worktrees",
    })) as unknown as AgentAppHost["worktrees"];
    return f;
  }

  it("reuses the first worker's own checkout, with its half-done work", async () => {
    const { source, host, started } = withFirstWorker(TREE);
    const result = await handleAgentApp(source, "r-finish", "tasks.delegate", { brief: "Finish the half-written fix.", redoes: "t-first" }, host);
    expect(started[0][0]).toMatchObject({ cwd: PROJECT, workspaceMode: "current", worktreeCwd: TREE });
    expect(result).toMatchObject({ isolation: "worktree", isolationWhy: expect.stringContaining("same checkout") });
  });

  it("gives a fresh checkout when the first worker had none, or it is gone; never the shared one", async () => {
    for (const [tree, onDisk] of [[undefined, true], [TREE, false]] as const) {
      const { source, host, started } = withFirstWorker(tree, onDisk);
      await handleAgentApp(source, "r-again", "tasks.delegate", { brief: "Try it again, smaller.", redoes: "t-first" }, host);
      expect(started[0][0]).toMatchObject({ workspaceMode: "worktree" });
      expect(started[0][0]).not.toHaveProperty("worktreeCwd");
    }
  });

  it("still works in the shared checkout when the chat asks for shared", async () => {
    const { source, host, started } = withFirstWorker(TREE);
    await handleAgentApp(source, "r-shared", "tasks.delegate", { brief: "Again.", redoes: "t-first", isolation: "shared" }, host);
    expect(started[0][0]).toMatchObject({ workspaceMode: "current" });
    expect(started[0][0]).not.toHaveProperty("worktreeCwd");
  });
});

describe("a first mate's workers (Hivra WP-10)", () => {
  it("each get a checkout of their own, so the first mate's main checkout is never theirs to edit", async () => {
    const { source, host, started } = fixture([]);
    const mate = { ...source, firstMate: true };
    const result = await handleAgentApp(mate, "r-mate", "tasks.delegate", { brief: "Fix the save bug." }, host);
    expect(started[0][0]).toMatchObject({ workspaceMode: "worktree" });
    expect((started[0][0] as { prompt: string }).prompt).toContain("STOP - do not branch or commit here");
    expect(result).toMatchObject({ isolation: "worktree", isolationWhy: expect.stringContaining("first mate") });
    await expect(
      handleAgentApp(mate, "r-mate-shared", "tasks.delegate", { brief: "Fix it here.", isolation: "shared" }, host),
    ).rejects.toThrow(/checkout of their own/);
  });
});

describe("tasks.delegate", () => {
  it("passes the shared task through, and refuses one that is not an id", async () => {
    const { source, host, started } = fixture();
    await handleAgentApp(source, "r-link", "tasks.delegate", { brief: "Pick up the save bug.", taskId: "task-abc" }, host);
    expect(started[0]?.[4]).toMatchObject({ taskId: "task-abc" });
    const second = fixture();
    await expect(
      handleAgentApp(second.source, "r-bad", "tasks.delegate", { brief: "Pick it up.", taskId: "  " }, second.host),
    ).rejects.toThrow("taskId must be the shared task's id");
    expect(second.started).toEqual([]);
  });

  it("refuses a task from another project before a worker starts", async () => {
    const blocked = fixture();
    blocked.host.taskStore = vi.fn(async () => {
      throw new Error("No task with that id.");
    });
    await expect(
      handleAgentApp(blocked.source, "r-other", "tasks.delegate", { brief: "Pick up the save bug.", taskId: "task-other" }, blocked.host),
    ).rejects.toThrow("No task with that id.");
    expect(blocked.started).toEqual([]);

    const elsewhere = fixture();
    elsewhere.host.taskStore = vi.fn(async () => ({ projectId: "other-project" }));
    await expect(
      handleAgentApp(elsewhere.source, "r-else", "tasks.delegate", { brief: "Pick up the save bug.", taskId: "task-else" }, elsewhere.host),
    ).rejects.toThrow("That task is in another project.");
    expect(elsewhere.started).toEqual([]);

    const same = fixture();
    same.host.taskStore = vi.fn(async () => ({ projectId: PROJECT }));
    await handleAgentApp(same.source, "r-same", "tasks.delegate", { brief: "Pick up the save bug.", taskId: "task-abc" }, same.host);
    expect(same.started[0]?.[4]).toMatchObject({ taskId: "task-abc" });
  });

  it("holds a hard task until the phase documents are accepted, and still starts a usual one", async () => {
    const hard = fixture();
    // WP-84: the phase worker reads the task itself, not just its id.
    hard.host.taskStore = vi.fn(async (_command, args) => ({
      id: args.id,
      projectId: PROJECT,
      title: "Rework how saving works",
      description: "The save drops the last line of a file that ends with CRLF.",
    }));
    const held = await handleAgentApp(
      hard.source,
      "r-hard",
      "tasks.delegate",
      { brief: "Rework how saving works.", taskId: "task-hard", hard: true },
      hard.host,
    );
    const phaseStarts = hard.started.filter((args) => String(args[1]).includes("-phase-"));
    expect(phaseStarts).toHaveLength(2);
    expect(hard.started.some((args) => args[1] === "app-mono-exo-r-hard")).toBe(false);
    const prompts = phaseStarts.map((args) => (args[0] as { prompt: string }).prompt);
    expect(prompts[0].startsWith("Hivra runs this phase.")).toBe(true);
    expect(prompts[0]).toContain("Skill: research-questions");
    expect(prompts[0]).toContain("You are a research orchestrator helping to create research questions");
    expect(prompts[1].startsWith("Hivra runs this phase.")).toBe(true);
    expect(prompts[1]).toContain("Skill: research\n");
    for (const prompt of prompts) {
      expect(prompt).toContain("Task: task-hard");
      expect(prompt).toContain("Title: Rework how saving works");
      expect(prompt).toContain("The save drops the last line of a file that ends with CRLF.");
    }
    expect(held).toMatchObject({ phased: true, taskId: null });
    const usual = fixture();
    await handleAgentApp(usual.source, "r-usual", "tasks.delegate", { brief: "Pick up the save bug.", taskId: "task-usual" }, usual.host);
    expect(usual.started[0]?.[4]).toMatchObject({ taskId: "task-usual" });
  });

  it("starts the coding worker once the phases have reached building", async () => {
    const ready = fixture();
    const phase = begin("task-ready", { weight: "costly" }, {}, counter());
    seedWork({
      ...phase,
      building: true,
      waiting: null,
      cursor: "done",
      runs: phase.runs.map((run) => ({ ...run, status: "done" as const })),
    });
    const result = (await handleAgentApp(
      ready.source,
      "r-ready",
      "tasks.delegate",
      { brief: "Pick up the save bug.", taskId: "task-ready", hard: true },
      ready.host,
    )) as { taskId?: string | null };
    expect(ready.started[0]?.[4]).toMatchObject({ taskId: "task-ready" });
    expect(taskForCrew(String(result.taskId))).toBe("task-ready");
  });

  it("walks research, plan and build to done with the fake Claude", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hivra-phase-walk-"));
    const scenario = join(dir, "rules.json");
    writeFileSync(
      scenario,
      JSON.stringify({
        version: 1,
        rules: [
          { name: "questions", match: "Skill: research-questions", steps: [{ say: "Questions about the save path." }] },
          { name: "research", match: "Skill: research\\n", steps: [{ say: "The save drops the last line." }] },
          { name: "design", match: "Skill: design-discussion", steps: [{ say: "Keep the last line." }] },
          { name: "outline", match: "Skill: create-structure-outline", times: 1, steps: [{ say: "Outline the save function." }] },
          { name: "build", match: "Skill: implement-outline", steps: [{ say: "Build the save function." }] },
        ],
      }),
    );
    const previous = loadPhaseSettings(PROJECT);
    savePhaseSettings(PROJECT, { ...previous, continueWithoutWaiting: true });
    try {
      const { source, host, started } = fixture([], "mono", async (launch, id) => {
        const reply = await askFakeClaude(launch.prompt, fakeClaudeLaunch(scenario, join(dir, "state"), id), 8_000);
        deliverPhaseResult(id, reply);
      });
      const result = await handleAgentApp(
        source,
        "r-walk",
        "tasks.delegate",
        { brief: "Rework how saving works.", taskId: "task-walk", hard: true },
        host,
      );
      const work = workFor("task-walk");
      expect(work?.docs.map((doc) => doc.phase)).toEqual(["research-questions", "research", "design", "outline", "build"]);
      expect(work?.docs.map((doc) => doc.body)).toEqual([
        "Questions about the save path.",
        "The save drops the last line.",
        "Keep the last line.",
        "Outline the save function.",
        "Build the save function.",
      ]);
      expect(work?.cursor).toBe("done");
      expect(work?.building).toBe(true);
      expect(started.filter((args) => String(args[1]).includes("-phase-"))).toHaveLength(5);
      expect(started.some((args) => args[1] === "app-mono-exo-r-walk")).toBe(true);
      expect(result).toMatchObject({ childSessionId: "app-mono-exo-r-walk" });
    } finally {
      savePhaseSettings(PROJECT, previous);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts a worker nested under the Mono, monitored, with a signed brief and a row that carries the job", async () => {
    const rows: Delegation[] = [];
    const { source, host, started } = fixture(rows);
    const result = await handleAgentApp(
      source,
      "r1",
      "tasks.delegate",
      {
        brief: "Ash: \"the save bug on mission two\". Fix it and prove it with a restart.",
        asks: ["a_1016abc", "a_1016def", "a_1016abc"],
        goal: "Saving survives a restart",
        model: "sonnet",
        isolation: "worktree",
      },
      host,
    );
    expect(started).toHaveLength(1);
    const [launch, id, placement, notify, meta] = started[0] as [
      Record<string, unknown>,
      string,
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(id).toBe("app-mono-exo-r1");
    expect(placement).toBeUndefined();
    expect(notify).toBe("mono-exo");
    expect(launch).toMatchObject({
      cwd: PROJECT,
      harness: "claude",
      model: "claude:sonnet-5",
      workspaceMode: "worktree",
      reveal: false,
    });
    expect(launch.prompt).toBe(
      briefPrompt(
        "EXO lead",
        scaffold("Ash: \"the save bug on mission two\". Fix it and prove it with a restart.", {
          kind: "own-checkout",
          mainCheckout: PROJECT,
        }),
        "Saving survives a restart",
        undefined,
        workerRules(workerPort("app-mono-exo-r1")),
      ),
    );
    expect(String(launch.prompt).startsWith("[MonoCode brief from EXO lead]\n\n")).toBe(true);
    expect(String(launch.prompt).endsWith("\n\nDone when: Saving survives a restart")).toBe(true);
    expect(meta).toEqual({
      title: "Ash: \"the save bug on mission two\". Fix it and prove it with a restart.",
      askIds: ["a_1016abc", "a_1016def"],
      goal: "Saving survives a restart",
      project: "vg-game",
    });
    expect(result).toMatchObject({
      taskId: "t-1",
      childSessionId: "app-mono-exo-r1",
      status: "running",
      isolation: "worktree",
      port: workerPort("app-mono-exo-r1"),
    });
    // Asked for, not chosen for it: no reason given.
    expect(result).not.toHaveProperty("isolationWhy");
    // The Mono hears it doesn't wait: the report comes as its own turn, and Ash gets answers meanwhile.
    expect((result as { note: string }).note).toContain("soon after it finishes");
    expect((result as { note: string }).note).toContain("answer him at once");
    // Hub lead replies quoted raw task ids and folder paths to Ash (22 Oct): the result says plain words only.
    expect((result as { note: string }).note).toContain("never its task id or a folder path");
  });

  it("gives a Lead's worker its project's memory after the brief, on the worker's own engine", async () => {
    const { source, host, started, api } = fixture([]);
    const block = "<project_memory>\n- Never ship work another session made\n</project_memory>";
    api.memoryBrief = vi.fn(async () => block);
    await handleAgentApp(source, "r-mem", "tasks.delegate", { brief: "Fix the save bug.", goal: "It saves", model: "sonnet" }, host);
    expect(api.memoryBrief).toHaveBeenCalledWith("mono-exo", "claude");
    const [launch] = started[0] as [{ prompt: string }];
    const rules = workerRules(portOfBrief(launch.prompt)!);
    expect(launch.prompt).toBe(briefPrompt("EXO lead", scaffold("Fix the save bug."), "It saves", block, rules));
    expect(launch.prompt.startsWith(`[MonoCode brief from EXO lead]\n\n${scaffold("Fix the save bug.")}\n\n${rules}\n\nDone when: It saves\n\n<project_memory>`)).toBe(true);
    // The memory after it is not part of the finish line the worker's /goal is set to (claudeGoal.ts).
    expect(goalFromBrief(launch.prompt)).toBe("It saves");
    // a worker on another engine: its own engine decides how the block tells it to read more (no memory tools there)
    setHarnessModels("codex", [{ id: "codex:gpt-5", harness: "codex", name: "GPT-5", settings: [] }]);
    await handleAgentApp(source, "r-mem-2", "tasks.delegate", { brief: "Draw it.", model: "codex:gpt-5" }, host);
    expect(api.memoryBrief).toHaveBeenLastCalledWith("mono-exo", "codex");
    // a chat with no project (the leadership team) gets the brief alone; a primer that fails never blocks the brief (the
    // earlier workers still run in this project, so these get checkouts of their own)
    api.memoryBrief = vi.fn(async () => undefined);
    await handleAgentApp(source, "r-plain", "tasks.delegate", { brief: "Look at CI." }, host);
    const plain = (started.at(-1) as [{ prompt: string }])[0].prompt;
    expect(plain).toBe(briefPrompt("EXO lead", scaffold("Look at CI.", { kind: "own-checkout", mainCheckout: PROJECT }), TEST_GOAL, undefined, workerRules(portOfBrief(plain)!)));
    api.memoryBrief = vi.fn(async () => Promise.reject(new Error("Ash OS is down")));
    await handleAgentApp(source, "r-down", "tasks.delegate", { brief: "Look again." }, host);
    const down = (started.at(-1) as [{ prompt: string }])[0].prompt;
    expect(down).toBe(briefPrompt("EXO lead", scaffold("Look again.", { kind: "own-checkout", mainCheckout: PROJECT }), TEST_GOAL, undefined, workerRules(portOfBrief(down)!)));
  });

  it("tells every worker it has no memory of the chat, never asks the person, and hands back a blocked path exactly (WP-171)", () => {
    const rules = workerRules(41_000);
    expect(rules).toMatch(/no memory of the chat that sent you/);
    expect(rules).toMatch(/the person's own request quoted in it/);
    expect(rules).toMatch(/Never ask the person a question/);
    expect(rules).toMatch(/most reasonable reading/);
    expect(rules).toMatch(/say in your report what you assumed/);
    expect(rules).toMatch(/nobody can approve it for you/);
    expect(rules).toMatch(/exactly what was blocked and where/);
    // One block, and the ones it had are all still there.
    expect(rules.match(/<worker_rules>/g)).toHaveLength(1);
    expect(rules).toMatch(/stop and ask your Lead/);
    expect(rules).not.toMatch(/[\u2014\u2013]/);
  });

  it("waits for the first harness probe before starting a worker (a Mono briefed right after a launch)", async () => {
    const { source, host, started } = fixture([]);
    probe.probed = false;
    probe.runs = 0;
    await handleAgentApp(source, "r-early", "tasks.delegate", { brief: "Fix the save bug." }, host);
    expect(probe.runs).toBe(1);
    expect(started).toHaveLength(1);
    await handleAgentApp(source, "r-later", "tasks.delegate", { brief: "Fix it again." }, host);
    expect(probe.runs).toBe(1);
  });

  it("names a project by its hub id and defaults to the shared checkout and Sonnet for a usual job", async () => {
    const { source, host, started } = fixture();
    const result = await handleAgentApp(
      source,
      "r2",
      "tasks.delegate",
      { brief: "Look at the CI failure\nthen report", project: "vg-game", title: "CI" },
      host,
    );
    const [launch, , , , meta] = started[0] as [
      Record<string, unknown>,
      string,
      unknown,
      string,
      Record<string, unknown>,
    ];
    // E7: Sonnet is the worker unless the job is hard, and the Lead is told why in one plain sentence.
    expect(launch).toMatchObject({
      cwd: PROJECT,
      model: "claude:sonnet-5",
      workspaceMode: "current",
    });
    expect(result).toMatchObject({ model: "claude:sonnet-5", modelWhy: "A usual job (a usual job), so Sonnet 5." });
    expect(meta).toEqual({ title: "CI", askIds: [], goal: TEST_GOAL, project: "vg-game" });
  });

  it("gives a hard job the stronger model, and leaves a usual one on the model it already runs", async () => {
    const hard = fixture();
    hard.source.model = "claude:sonnet-5";
    const result = await handleAgentApp(
      hard.source,
      "r-hard",
      "tasks.delegate",
      // The Lead's own mark: the brief's prose is never read for a difficulty guess.
      { brief: "Add the tags migration.", hard: true },
      hard.host,
    );
    expect(hard.started[0][0]).toMatchObject({ model: "claude:opus-5-5" });
    expect(result).toMatchObject({ model: "claude:opus-5-5" });
    expect((result as { modelWhy: string }).modelWhy).toBe("A hard job (marked hard), so Opus 5.5.");

    // A brief that would once have read as a migration is a usual job without a signal.
    expect(
      await handleAgentApp(hard.source, "r-prose", "tasks.delegate", { brief: "Add a migration for the tags table." }, hard.host),
    ).not.toHaveProperty("modelWhy");

    const usual = fixture();
    usual.source.model = "claude:sonnet-5";
    const plain = await handleAgentApp(usual.source, "r-usual", "tasks.delegate", { brief: "Tidy the title." }, usual.host);
    expect(usual.started[0][0]).toMatchObject({ model: "claude:sonnet-5" });
    expect(plain).not.toHaveProperty("modelWhy");
  });

  it("escalates each signal the Lead declares: heavy, a retry, a wide scope", async () => {
    for (const [name, input, why] of [
      ["heavy", { heavy: true }, "A hard job (a heavy job)"],
      ["scope", { scope: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts", "src/g.ts", "src/h.ts"] }, "A hard job (a declared scope of 8 files or areas)"],
    ] as const) {
      const { source, host, started } = fixture();
      source.model = "claude:sonnet-5";
      const result = await handleAgentApp(source, `r-${name}`, "tasks.delegate", { brief: "Do it.", ...input }, host);
      expect(started[0][0]).toMatchObject({ model: "claude:opus-5-5" });
      expect((result as { modelWhy: string }).modelWhy).toContain(why);
    }
    // A retry is a second go at a task that failed: the row it redoes is the signal.
    const rows = [row({ id: "t-stuck", stallKind: "loop" })];
    const retry = fixture(rows);
    retry.source.model = "claude:sonnet-5";
    const result = await handleAgentApp(
      retry.source,
      "r-retry",
      "tasks.delegate",
      { brief: "Fix the save bug, smaller: only the slot file.", redoes: "t-stuck" },
      retry.host,
    );
    expect(retry.started[0][0]).toMatchObject({ model: "claude:opus-5-5" });
    expect((result as { modelWhy: string }).modelWhy).toContain("A hard job (a retry of a task that failed)");
  });

  it("lets a model or effort the Lead names win over every rule, and passes the effort to the spawn", async () => {
    setHarnessModels("claude", [
      {
        id: "claude:opus-5-5",
        harness: "claude",
        name: "Opus 5.5",
        settings: [
          {
            id: "effort",
            label: "Effort",
            kind: "select",
            value: "medium",
            options: [
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
            ],
          },
        ],
      },
      { id: "claude:sonnet-5", harness: "claude", name: "Sonnet 5", settings: [] },
    ]);
    const { source, host, started } = fixture();
    source.model = "claude:sonnet-5";
    // Named: a hard job still runs the model the Lead chose.
    const named = await handleAgentApp(
      source,
      "r-named-hard",
      "tasks.delegate",
      { brief: "Do it.", hard: true, model: "sonnet" },
      host,
    );
    expect(started[0][0]).toMatchObject({ model: "claude:sonnet-5" });
    expect(named).not.toHaveProperty("modelWhy");
    // Its own effort: the spawn carries it, and the result says the same value the picker words.
    const effort = await handleAgentApp(
      source,
      "r-effort",
      "tasks.delegate",
      { brief: "Do it.", model: "opus-5-5", effort: "high" },
      host,
    );
    expect((started[1] as [Record<string, unknown>])[0]).toMatchObject({
      model: "claude:opus-5-5",
      modelSettings: { effort: "high" },
    });
    expect(effort).toMatchObject({ model: "claude:opus-5-5", effort: "High" });
  });

  it("sends a design Mono's crew rule with the route so it can beat the project's", async () => {
    setHarnessModels("codex", [{ id: "codex:gpt-5", harness: "codex", name: "GPT-5", settings: [] }]);
    const { source, host, api } = fixture();
    const design = { labels: ["screen"], paths: [] as string[], cli: "codex", source: "person" as const };
    (host as { monoOf: () => unknown }).monoOf = () => ({
      id: "design",
      name: "Ada",
      projects: [PROJECT],
      crewRules: [design],
    });
    api.crewRoute = vi.fn(async () => ({ cli: "codex", cliFrom: "rule", modelFrom: "none", effortFrom: "none" }));
    await handleAgentApp(source, "r-design-rule", "tasks.delegate", { brief: "Review the screen." }, host);
    expect(api.crewRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        mono: "design",
        monoRules: [expect.objectContaining({ cli: "codex", labels: ["screen"] })],
      }),
    );
  });

  it("sends the Mono, project and system defaults, and a default changes the launch", async () => {
    setHarnessModels("codex", [{ id: "codex:gpt-5", harness: "codex", name: "GPT-5", settings: [] }]);
    resetWorkerPool();
    setProjectWorkerModel("vg-game", { cli: "cursor", model: "composer", effort: "medium" });
    setSystemWorkerDefault({ effort: "high" });
    const { source, host, api, started } = fixture();
    api.pool = workerPoolHost({ openRows: () => [], room: () => ({ room: true }) });
    host.monoOf = () => ({
      id: "vg-game-lead",
      name: "EXO lead",
      projects: [PROJECT],
      workerDefault: { cli: "codex", model: "codex:gpt-5" },
    });
    api.crewRoute = vi.fn(async () => ({
      cli: "codex",
      model: "codex:gpt-5",
      cliFrom: "mono",
      modelFrom: "mono",
      effortFrom: "none",
    }));
    await handleAgentApp(source, "r-worker-default", "tasks.delegate", { brief: "Review the screen." }, host);
    expect(api.crewRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        defaults: {
          mono: { cli: "codex", model: "codex:gpt-5" },
          project: { cli: "cursor", model: "composer", effort: "medium" },
          system: { effort: "high" },
        },
      }),
    );
    expect(started[0][0]).toMatchObject({ harness: "codex", model: "codex:gpt-5" });
  });

  it("asks the crew which CLI to start, and uses that CLI, model and effort", async () => {
    setHarnessModels("codex", [
      {
        id: "codex:gpt-5",
        harness: "codex",
        name: "GPT-5",
        settings: [
          {
            id: "effort",
            label: "Effort",
            kind: "select",
            value: "low",
            options: [
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
            ],
          },
        ],
      },
    ]);
    const { source, host, started, api } = fixture();
    api.memoryBrief = vi.fn(async () => undefined);
    api.crewRoute = vi.fn(async () => ({
      cli: "codex",
      model: "codex:gpt-5",
      effort: "medium",
      cliFrom: "rule",
      modelFrom: "rule",
      effortFrom: "rule",
    }));
    await handleAgentApp(source, "r-crew", "tasks.delegate", { brief: "Build the UI.", files: ["src/app/main.tsx"] }, host);
    expect(api.crewRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: ["ui"],
        paths: ["src/app/main.tsx"],
        project: PROJECT,
        mono: "vg-game-lead",
      }),
    );
    const asked = (api.crewRoute as ReturnType<typeof vi.fn>).mock.calls[0][0] as { labels: string[]; paths: string[] };
    expect(asked.labels.some((label) => label.startsWith("area:"))).toBe(false);
    expect(api.memoryBrief).toHaveBeenCalledWith("mono-exo", "codex");
    expect(started[0][0]).toMatchObject({
      harness: "codex",
      model: "codex:gpt-5",
      modelSettings: { effort: "medium" },
    });
  });

  it("keeps the model already chosen when the crew route fails or names no usable CLI", async () => {
    const down = fixture();
    down.api.crewRoute = vi.fn(async () => {
      throw new Error("crew route timed out");
    });
    await handleAgentApp(down.source, "r-down", "tasks.delegate", { brief: "Tidy the title." }, down.host);
    expect(down.api.crewRoute).toHaveBeenCalled();
    expect(down.started[0][0]).toMatchObject({ harness: "claude", model: "claude:sonnet-5" });

    const odd = fixture();
    odd.api.crewRoute = vi.fn(async () => ({ cli: "not-a-cli", model: "nope", cliFrom: "rule", modelFrom: "rule" }));
    await handleAgentApp(odd.source, "r-odd", "tasks.delegate", { brief: "Tidy the title." }, odd.host);
    expect(odd.started[0][0]).toMatchObject({ harness: "claude", model: "claude:sonnet-5" });

    // Cursor is a real CLI, and this test's harness probe does not have it. The start still uses the model already chosen.
    const missing = fixture();
    missing.api.crewRoute = vi.fn(async () => ({
      cli: "cursor",
      model: "cursor:composer",
      cliFrom: "rule",
      modelFrom: "rule",
    }));
    await handleAgentApp(missing.source, "r-missing", "tasks.delegate", { brief: "Tidy the title." }, missing.host);
    expect(missing.started[0][0]).toMatchObject({ harness: "claude", model: "claude:sonnet-5" });
  });

  it("does not send another engine's model id when the crew names a CLI and no model", async () => {
    setHarnessModels("codex", [{ id: "codex:gpt-5", harness: "codex", name: "GPT-5", settings: [] }]);
    const { source, host, started, api } = fixture();
    api.crewRoute = vi.fn(async () => ({ cli: "codex", cliFrom: "rule", modelFrom: "none", effortFrom: "none" }));
    await handleAgentApp(source, "r-bare", "tasks.delegate", { brief: "Tidy the title." }, host);
    expect(api.crewRoute).toHaveBeenCalled();
    const launch = started[0][0] as { harness: string; model: string };
    expect(launch.harness).toBe("codex");
    expect(launch.model.startsWith("claude:")).toBe(false);
  });

  it("keeps a project's Codex worker when the crew only has its default", async () => {
    setHarnessModels("codex", [
      {
        id: "codex:gpt-5",
        harness: "codex",
        name: "GPT-5",
        settings: [
          {
            id: "effort",
            label: "Effort",
            kind: "select",
            value: "low",
            options: [
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
            ],
          },
        ],
      },
    ]);
    resetWorkerPool();
    setProjectWorkerModel("vg-game", { model: "codex:gpt-5", effort: "medium" });
    const pool = workerPoolHost({ openRows: () => [], room: () => ({ room: true }), card: () => {} });
    const asCodex = (source: Session) => {
      source.harness = "codex";
      source.model = "codex:gpt-5";
      source.modelSettings = { effort: "medium" };
    };
    const plain = fixture();
    asCodex(plain.source);
    const plainHost = { ...plain.host, tasks: { ...(plain.host.tasks as object), pool } } as AgentAppHost;
    await handleAgentApp(plain.source, "r-plain-codex", "tasks.delegate", { brief: "Tidy the title." }, plainHost);
    const without = plain.started[0][0] as { harness: string; model: string; modelSettings?: { effort?: string } };

    const routed = fixture();
    asCodex(routed.source);
    routed.api.crewRoute = vi.fn(async () => ({
      cli: "claude",
      cliFrom: "default",
      modelFrom: "none",
      effortFrom: "none",
    }));
    const routedHost = { ...routed.host, tasks: { ...routed.api, pool } } as AgentAppHost;
    await handleAgentApp(routed.source, "r-default-codex", "tasks.delegate", { brief: "Tidy the title." }, routedHost);
    const withCrew = routed.started[0][0] as { harness: string; model: string; modelSettings?: { effort?: string } };
    expect(withCrew.harness).toBe(without.harness);
    expect(withCrew.model).toBe(without.model);
    expect(withCrew.modelSettings?.effort).toBe(without.modelSettings?.effort);
    expect(withCrew).toMatchObject({ harness: "codex", model: "codex:gpt-5", modelSettings: { effort: "medium" } });
  });

  it("moves a Claude task to Codex when a rule for its label says so", async () => {
    setHarnessModels("codex", [{ id: "codex:gpt-5", harness: "codex", name: "GPT-5", settings: [] }]);
    const { source, host, started, api } = fixture();
    api.crewRoute = vi.fn(async () => ({ cli: "codex", cliFrom: "rule", modelFrom: "none", effortFrom: "none" }));
    await handleAgentApp(source, "r-rule-ui", "tasks.delegate", { brief: "Build the UI.", files: ["src/app/main.tsx"] }, host);
    expect(api.crewRoute).toHaveBeenCalledWith(expect.objectContaining({ labels: ["ui"] }));
    const launch = started[0][0] as { harness: string; model: string };
    expect(launch.harness).toBe("codex");
    expect(launch.model.startsWith("claude:")).toBe(false);
  });

  it("sends a model or effort the caller names as the override, which beats a rule", async () => {
    setHarnessModels("claude", [
      {
        id: "claude:opus-5-5",
        harness: "claude",
        name: "Opus 5.5",
        settings: [
          {
            id: "effort",
            label: "Effort",
            kind: "select",
            value: "medium",
            options: [
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
            ],
          },
        ],
      },
      { id: "claude:sonnet-5", harness: "claude", name: "Sonnet 5", settings: [] },
    ]);
    const { source, host, started, api } = fixture();
    source.model = "claude:sonnet-5";
    api.crewRoute = vi.fn(async (query: { override?: { cli?: string; model?: string; effort?: string } }) => ({
      cli: query.override?.cli ?? "codex",
      model: query.override?.model ?? "codex:gpt-5",
      effort: query.override?.effort ?? null,
      cliFrom: "override",
      modelFrom: "override",
      effortFrom: "override",
    }));
    await handleAgentApp(
      source,
      "r-named-crew",
      "tasks.delegate",
      { brief: "Do it.", hard: true, model: "opus-5-5", effort: "high" },
      host,
    );
    expect(api.crewRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        override: { cli: "claude", model: "claude:opus-5-5", effort: "high" },
      }),
    );
    expect(started[0][0]).toMatchObject({
      harness: "claude",
      model: "claude:opus-5-5",
      modelSettings: { effort: "high" },
    });
  });

  it("runs a project's jobs on its own worker model, and an explicit one per task still wins", async () => {
    resetWorkerPool();
    const { source, host, started } = fixture();
    const f = started;
    // As Ash saved it in the project's Workers dialog (H8's store, model column).
    setProjectWorkerModel("vg-game", { model: "claude:opus-5-5" });
    const pool = workerPoolHost({ openRows: () => [], room: () => ({ room: true }), card: () => {} });
    const pooledHost = { ...host, tasks: { ...(host.tasks as object), pool } } as AgentAppHost;
    source.model = "claude:sonnet-5";
    const usual = await handleAgentApp(source, "r-proj", "tasks.delegate", { brief: "Tidy the title." }, pooledHost);
    expect(f[0][0]).toMatchObject({ model: "claude:opus-5-5" });
    expect((usual as { modelWhy: string }).modelWhy).toBe("This project's workers run on Opus 5.5.");
    const named = await handleAgentApp(
      source,
      "r-proj-named",
      "tasks.delegate",
      { brief: "Tidy the title.", model: "sonnet" },
      pooledHost,
    );
    expect(f[1][0]).toMatchObject({ model: "claude:sonnet-5" });
    expect(named).not.toHaveProperty("modelWhy");
  });

  it("keeps a model the caller names, whatever the job is", async () => {
    const { source, host, started } = fixture();
    const result = await handleAgentApp(
      source,
      "r-named",
      "tasks.delegate",
      { brief: "Add a migration for the tags table.", model: "sonnet" },
      host,
    );
    expect(started[0][0]).toMatchObject({ model: "claude:sonnet-5" });
    expect(result).not.toHaveProperty("modelWhy");
  });

  it("never swaps one of Ash's own models for a subscription one", async () => {
    const { source, host, started } = fixture();
    source.model = "custom:deepseek-test";
    const result = await handleAgentApp(source, "r-custom", "tasks.delegate", { brief: "Tidy the title." }, host);
    expect(started[0][0]).toMatchObject({ model: "custom:deepseek-test" });
    expect(result).toMatchObject({ model: "custom:deepseek-test" });
    expect(result).not.toHaveProperty("modelWhy");
  });

  // E7: a worker on one of Ash's own models keeps the reasoning effort the Lead named, all the way to the router's route.
  it("carries a custom model's reasoning effort through to the provider route", async () => {
    importCustomModels([
      { id: "deepseek-test", name: "DeepSeek", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-chat" },
    ]);
    const { source, host, started } = fixture();
    const result = await handleAgentApp(
      source,
      "r-custom-effort",
      "tasks.delegate",
      { brief: "Tidy the title.", model: "custom:deepseek-test", effort: "high" },
      host,
    );
    const launch = started[0][0];
    expect(launch).toMatchObject({ model: "custom:deepseek-test", modelSettings: { effort: "high" } });
    expect(result).toMatchObject({ model: "custom:deepseek-test", effort: "High" });
    expect(customModelRoute(launch)?.reasoningEffort).toBe("high");
  });

  it("is refused for anything but a Mono's own chat or a coding-team chat, and the checker", async () => {
    for (const [who, message] of [
      ["plain", "Only a Mono's own chat or a chat in a project's coding team can delegate"],
      ["worker", "Only a Mono's own chat or a chat in a project's coding team can delegate"],
      ["habit", "A habit run can't delegate"],
      ["checker", "The checker only reads"],
    ] as const) {
      const { source, host, started } = fixture([], who);
      await expect(
        handleAgentApp(source, "r3", "tasks.delegate", { brief: "x" }, host),
      ).rejects.toThrow(message);
      await expect(handleAgentApp(source, "r4", "tasks.status", {}, host)).rejects.toThrow(
        message,
      );
      expect(started).toHaveLength(0);
    }
  });

  // Ash, 20 Oct: the coding team is the main place he talks, and its chats delegate like the Lead (codingTeam.ts).
  it("lets a coding-team chat delegate on its own project, signed as its coding team, nested under it", async () => {
    const rows: Delegation[] = [];
    const { source, host, started, api } = fixture(rows, "team");
    api.memoryBrief = vi.fn(async () => "<project_memory>\n- EXO is dark blue\n</project_memory>");
    const result = await handleAgentApp(
      source,
      "r1",
      "tasks.delegate",
      { brief: "Fix the save bug.", title: "Save bug", goal: "It saves", project: "vg-game", isolation: "worktree" },
      host,
    );
    const [launch, id, , notify, meta] = started[0] as [Record<string, unknown>, string, unknown, string, Record<string, unknown>];
    // The worker's chat is `app-<this chat>-<request>`: the coding team's Sessions list nests it under this chat.
    expect(id).toBe("app-team-exo-r1");
    expect(notify).toBe("team-exo");
    expect(launch).toMatchObject({ cwd: PROJECT, workspaceMode: "worktree", reveal: false });
    expect(launch.project).toBeUndefined();
    expect(launch.prompt).toBe(
      briefPrompt(
        "EXO coding team",
        scaffold("Fix the save bug.", { kind: "own-checkout", mainCheckout: PROJECT }),
        "It saves",
        "<project_memory>\n- EXO is dark blue\n</project_memory>",
        workerRules(workerPort("app-team-exo-r1")),
      ),
    );
    expect(api.memoryBrief).toHaveBeenCalledWith("team-exo", "claude");
    expect(meta).toMatchObject({ title: "Save bug", project: "vg-game" });
    expect(result).toMatchObject({ taskId: "t-1", childSessionId: "app-team-exo-r1", status: "running" });
    // Its rows are its own: task_status reads them.
    expect(await handleAgentApp(source, "r2", "tasks.status", {}, host)).toMatchObject({
      tasks: [{ taskId: "t-1", childSessionId: "app-team-exo-r1" }],
    });
  });

  // Baseline, 20 Oct: two workers on the test project shared port 4317 and one ran pkill on the other's dev server.
  it("gives every worker its own port and rules, and a second worker in the same project its own checkout", async () => {
    const rows: Delegation[] = [];
    const { source, host, started } = fixture(rows);
    const first = (await handleAgentApp(source, "r1", "tasks.delegate", { brief: "Build the API." }, host)) as Record<string, unknown>;
    const second = (await handleAgentApp(source, "r2", "tasks.delegate", { brief: "Build the UI." }, host)) as Record<string, unknown>;
    const [launch1] = started[0] as [{ prompt: string; workspaceMode: string }];
    const [launch2] = started[1] as [{ prompt: string; workspaceMode: string }];
    // The first works in the project's checkout; the second, while the first still runs there, in one of its own.
    expect(launch1.workspaceMode).toBe("current");
    expect(first).not.toHaveProperty("isolation");
    expect(launch2.workspaceMode).toBe("worktree");
    expect(second).toMatchObject({ isolation: "worktree", isolationWhy: expect.stringContaining("Another worker") });
    // Each has a port of its own, named in its brief with the rules it works by.
    expect(first.port).not.toBe(second.port);
    expect(portOfBrief(launch1.prompt)).toBe(first.port);
    expect(portOfBrief(launch2.prompt)).toBe(second.port);
    for (const prompt of [launch1.prompt, launch2.prompt]) {
      expect(prompt).toContain("<worker_rules>");
      expect(prompt).toContain("Never stop, kill or restart a process you didn't start");
      expect(prompt).toContain("never on the project's default port");
    }
    // Asked to share, it shares.
    await handleAgentApp(source, "r3", "tasks.delegate", { brief: "Read the docs.", isolation: "shared" }, host);
    expect((started[2] as [{ workspaceMode: string }])[0].workspaceMode).toBe("current");
    // Once the others are done, the next one works in the project's checkout again.
    for (const row of rows) row.state = "completed";
    await handleAgentApp(source, "r4", "tasks.delegate", { brief: "One more." }, host);
    expect((started[3] as [{ workspaceMode: string }])[0].workspaceMode).toBe("current");
  });

  it("falls back to the shared checkout when one of its own can't be made", async () => {
    const rows: Delegation[] = [];
    const { source, host, started } = fixture(rows);
    await handleAgentApp(source, "r1", "tasks.delegate", { brief: "Build the API." }, host);
    const start = host.start as ReturnType<typeof vi.fn>;
    const real = start.getMockImplementation()!;
    start.mockImplementationOnce(async () => {
      throw new Error("not a git repository");
    });
    start.mockImplementation(real);
    const result = await handleAgentApp(source, "r2", "tasks.delegate", { brief: "Build the UI." }, host);
    expect((started.at(-1) as [{ workspaceMode: string }])[0].workspaceMode).toBe("current");
    expect(result).not.toHaveProperty("isolation");
  });

  it("picks a worker's port from its chat id, the same every time, past the ones its siblings hold", () => {
    const port = workerPort("app-mono-exo-r1");
    expect(port).toBe(workerPort("app-mono-exo-r1"));
    expect(port).toBeGreaterThanOrEqual(WORKER_PORT_BASE);
    expect(port).toBeLessThan(WORKER_PORT_BASE + WORKER_PORT_SPAN);
    const next = workerPort("app-mono-exo-r1", new Set([port]));
    expect(next).not.toBe(port);
    expect(next).toBe(port + 1 === WORKER_PORT_BASE + WORKER_PORT_SPAN ? WORKER_PORT_BASE : port + 1);
    expect(portOfBrief(workerRules(next))).toBe(next);
    expect(portOfBrief("no port here")).toBeUndefined();
  });

  it("keeps a coding-team chat on its own project and away from briefing Leads", async () => {
    const { source, host, started } = fixture([], "team");
    await expect(
      handleAgentApp(source, "r1", "tasks.delegate", { brief: "x", project: "hivra" }, host),
    ).rejects.toThrow("delegates on its own project (vg-game)");
    await expect(
      handleAgentApp(source, "r2", "tasks.delegate", { brief: "x", lead: "hivra" }, host),
    ).rejects.toThrow("only a Mono briefs a project's Lead");
    expect(started).toHaveLength(0);
  });

  // Ash, 20 Oct: "monos shouldn't really have sub chats, if its stuff to fix it should either do it itself or pick it up
  // with the coding team. IF they do need to do work ... something like coding team should be created for that mono".
  describe("a Mono's work goes to a team (monoTeams.ts)", () => {
    const TEAM = "/data/mono-teams/cam";
    function cam(rows: Delegation[] = []) {
      const fx = fixture(rows);
      const ownTeam = vi.fn(async () => ({ folder: TEAM, name: "Alfred's team" }));
      fx.api.monoWork = {
        isLead: (id) => id === "vg-game-lead",
        codingTeam: (named) =>
          named === "vg-game" || named === PROJECT || named === "EXO"
            ? { projectId: "vg-game", leadName: "EXO lead", name: "EXO coding team" }
            : undefined,
        ownTeam,
      };
      // Alfred works on EXO too; its team's folder is its own once it has one.
      (fx.host as { monoOf: unknown }).monoOf = () => ({ id: "cam", name: "Alfred", projects: [PROJECT], team: TEAM });
      return { ...fx, ownTeam };
    }

    it("sends a project's work to that project's coding team, never to a worker of its own", async () => {
      const { source, host, started, ownTeam } = cam();
      for (const project of ["vg-game", PROJECT, "EXO"])
        await expect(
          handleAgentApp(source, `r-${project.length}`, "tasks.delegate", { brief: "Fix the save bug.", project }, host),
        ).rejects.toThrow(`has a coding team: hand its work to EXO coding team instead, with delegate_task and lead "vg-game"`);
      expect(started).toHaveLength(0);
      expect(ownTeam).not.toHaveBeenCalled();
    });

    it("starts its own work in its own team, made the first time, nested under its chat", async () => {
      const rows: Delegation[] = [];
      const { source, host, started, ownTeam } = cam(rows);
      const result = await handleAgentApp(source, "r-own", "tasks.delegate", { brief: "Research the launch copy.", title: "Launch copy" }, host);
      expect(ownTeam).toHaveBeenCalledWith(expect.objectContaining({ id: "cam" }));
      const [launch, id, , notify, meta] = started[0] as [Record<string, unknown>, string, unknown, string, Record<string, unknown>];
      // Its chat is `app-<Alfred's chat>-<request>` in the team's folder: the team's list nests it under Alfred's chat.
      expect(id).toBe("app-mono-exo-r-own");
      expect(notify).toBe("mono-exo");
      expect(launch).toMatchObject({ cwd: TEAM, workspaceMode: "current", reveal: false });
      expect(String(launch.prompt).startsWith("[MonoCode brief from Alfred]\n\n## Isolation check\n")).toBe(true);
      expect(String(launch.prompt)).toContain(`## Intent\n${TEST_INTENT}\n\n## Spec\nResearch the launch copy.`);
      // Not a hub project: the row carries no project.
      expect(meta).toEqual({ title: "Launch copy", askIds: [], goal: TEST_GOAL });
      expect(result).toMatchObject({ childSessionId: "app-mono-exo-r-own", cwd: TEAM, team: "Alfred's team" });
      expect((result as { note: string }).note).toContain("Running in Alfred's team, where its chat shows under yours");
      // A second worker there shares the folder: it isn't a repository, so there is no checkout of its own to make (the
      // bench, 20 Oct: one was asked for, never made, and the worker never ran). Asking for one is refused.
      expect(rows[0].project).toBe(TEAM);
      const second = await handleAgentApp(source, "r-own-2", "tasks.delegate", { brief: "Draft the post." }, host);
      expect((started[1] as [Record<string, unknown>])[0]).toMatchObject({ cwd: TEAM, workspaceMode: "current" });
      expect(second).not.toHaveProperty("isolation");
      await expect(
        handleAgentApp(source, "r-own-wt", "tasks.delegate", { brief: "Draft it again.", isolation: "worktree" }, host),
      ).rejects.toThrow("isn't a repository");
      // Naming its own team's folder is the same.
      await handleAgentApp(source, "r-own-3", "tasks.delegate", { brief: "Check the draft.", project: TEAM }, host);
      expect((started[2] as [Record<string, unknown>])[0]).toMatchObject({ cwd: TEAM });
    });

    it("leaves a Lead, a coding-team chat and a project with no coding team as they were", async () => {
      // The Lead starts its workers in its project, as before.
      const lead = fixture();
      lead.api.monoWork = { isLead: () => true, codingTeam: () => ({ projectId: "vg-game", leadName: "EXO lead", name: "EXO coding team" }), ownTeam: vi.fn() };
      await handleAgentApp(lead.source, "r-lead", "tasks.delegate", { brief: "Fix it.", project: "vg-game" }, lead.host);
      expect((lead.started[0] as [Record<string, unknown>])[0]).toMatchObject({ cwd: PROJECT });
      expect(lead.api.monoWork.ownTeam).not.toHaveBeenCalled();
      // A folder of its own that is no hub project has no coding team: a worker may start there.
      const { source, host, started } = cam();
      (host as { monoOf: unknown }).monoOf = () => ({ id: "cam", name: "Alfred", projects: [PROJECT, "/tmp/scratch"] });
      await handleAgentApp(source, "r-scratch", "tasks.delegate", { brief: "Tidy it.", project: "/tmp/scratch" }, host);
      expect((started[0] as [Record<string, unknown>])[0]).toMatchObject({ cwd: "/tmp/scratch" });
    });
  });

  it("refuses bad input before anything starts", async () => {
    const { source, host, started } = fixture();
    for (const [input, message] of [
      [{ brief: "x", prompt: "y" }, "Unknown tasks.delegate fields: prompt"],
      [{ brief: "" }, "The spec (brief) is empty"],
      [{ brief: "x", asks: ["not-an-ask"] }, "asks must be"],
      [{ brief: "x", isolation: "fork" }, "isolation must be"],
      [{ brief: "x", model: "gpt-9" }, 'Unknown model "gpt-9"'],
      [{ brief: "x", project: "/tmp/elsewhere" }, "Not one of your projects"],
    ] as const) {
      await expect(
        handleAgentApp(source, "r5", "tasks.delegate", input, host),
      ).rejects.toThrow(message);
    }
    await expect(
      handleAgentApp(source, "bad id", "tasks.delegate", { brief: "x" }, host),
    ).rejects.toThrow("request ID");
    expect(started).toHaveLength(0);
  });

  // Hivra WP-10: the model fills intent, spec and definition of done; the app refuses a brief with any left empty or as
  // a placeholder, before anything starts.
  it("refuses a brief with an empty or placeholder section, before anything starts", async () => {
    const { source, host, started } = fixture();
    const good = { intent: "Ash: \"fix the save bug\"", brief: "Fix the save bug in src/save.ts.", goal: "npm test passes" };
    for (const [input, message] of [
      [{ brief: good.brief, goal: good.goal }, "The intent (intent) is empty"],
      [{ ...good, intent: "TODO" }, "The intent (intent) is a placeholder"],
      [{ ...good, brief: "<your spec here>" }, "The spec (brief) still has a placeholder"],
      [{ ...good, brief: "Fix {TASK} today" }, "The spec (brief) still has a placeholder ({TASK})"],
      [{ ...good, goal: "TBD" }, "The definition of done (goal) is a placeholder"],
      [{ ...good, goal: "   " }, "The definition of done (goal) is empty"],
      [{ intent: "...", brief: "[fill in]", goal: "" }, "intent) is a placeholder; The spec (brief) still has a placeholder ([fill in]); The definition of done (goal) is empty"],
    ] as const) {
      await expect(handleRaw(source, "r-brief", "tasks.delegate", input, host)).rejects.toThrow(message);
    }
    expect(started).toHaveLength(0);
    // A good one goes out from the template, and the row stores it.
    await handleRaw(source, "r-good", "tasks.delegate", good, host);
    const [launch] = started[0] as [{ prompt: string }];
    for (const section of ["## Isolation check", "## Intent\nAsh: \"fix the save bug\"", "## Spec\nFix the save bug in src/save.ts.", "## Status protocol", "## Steering", "## Report\nSummary:", "Done when: npm test passes"])
      expect(launch.prompt).toContain(section);
  });

  it("starts a hub change's worker with Ash's ask as its intent and a definition of done", async () => {
    const { source, host, started } = fixture();
    // Straight through the app, not the test helper that fills intent and goal in.
    const out = (await handleRaw(source, "r-hub", "hub.change", { ask: "Make the Today cards smaller", title: "Smaller cards" }, host)) as {
      changeId: string;
    };
    expect(out.changeId).toBe("hc-1");
    expect(started).toHaveLength(1);
    const [launch, , , , meta] = started[0] as [{ prompt: string }, string, unknown, string, { goal?: string }];
    expect(launch.prompt).toContain("## Intent\nMake the Today cards smaller");
    expect(meta.goal).toBeTruthy();
    expect(launch.prompt).toContain(`Done when: ${meta.goal}`);
  });

  it("refuses a delegation deeper than first mate, first mate, workers, before anything starts", async () => {
    const { source, host, started, api } = fixture();
    (api as { checkDepth?: (owner: string) => Promise<number> }).checkDepth = vi.fn(async () => {
      throw new Error("This task would sit 3 levels deep; work stops at 2");
    });
    await expect(handleAgentApp(source, "r-deep", "tasks.delegate", { brief: "Split it further." }, host)).rejects.toThrow(
      "3 levels deep",
    );
    expect(started).toHaveLength(0);
    (api as { checkDepth?: (owner: string) => Promise<number> }).checkDepth = vi.fn(async () => 2);
    await handleAgentApp(source, "r-ok", "tasks.delegate", { brief: "Do the one part." }, host);
    expect(started).toHaveLength(1);
    expect((api as { checkDepth: ReturnType<typeof vi.fn> }).checkDepth).toHaveBeenCalledWith("mono-exo");
  });
});

describe("tasks.delegate gates (WP-40)", () => {
  it("refuses a word that isn't a gate before anything starts", async () => {
    const { source, host, started } = fixture();
    await expect(
      handleAgentApp(source, "r-gate", "tasks.delegate", { brief: "Add delete.", gates: ["made-up"] }, host),
    ).rejects.toThrow(`"made-up" isn't a gate. Use diff, checks, committed, ratchet or routes.`);
    expect(started).toHaveLength(0);
  });

  it("keeps a code brief's gates on the task, and again when the same task is asked for twice", async () => {
    const { source, host, started, api } = fixture();
    const saveGates = vi.fn(async () => {
      throw new Error("the store was busy");
    });
    api.saveGates = saveGates;
    const first = (await handleAgentApp(source, "r-code", "tasks.delegate", { brief: "Add delete.", code: true }, host)) as {
      taskId: string;
    };
    expect(started).toHaveLength(1);
    expect(first.taskId).toBeTruthy();
    expect(saveGates).toHaveBeenCalledWith(first.taskId, { code: true }, PROJECT);
    saveGates.mockResolvedValue(undefined);
    const again = (await handleAgentApp(source, "r-code", "tasks.delegate", { brief: "Add delete.", code: true, checks: ["lint"] }, host)) as {
      alreadyStarted: boolean;
    };
    expect(again.alreadyStarted).toBe(true);
    expect(started).toHaveLength(1);
    expect(saveGates).toHaveBeenLastCalledWith(first.taskId, { code: true, checks: ["lint"] }, PROJECT);
  });

  it("does not keep gates on a task that is only waiting", async () => {
    const { source, host, api } = fixture();
    api.saveGates = vi.fn(async () => undefined);
    api.pool = {
      limits: () => ({ workers: 1, heavy: 1 }),
      setLimits: () => ({ workers: 1, heavy: 1 }),
      model: () => undefined,
      openRows: () => [],
      admit: () => ({ start: false, line: "Waiting for a free worker.", reason: "workers" }),
      enqueue: () => undefined,
      started: () => undefined,
      queued: () => [],
    } as unknown as AgentAppTasksHost["pool"];
    const out = (await handleAgentApp(source, "r-wait", "tasks.delegate", { brief: "Add delete.", code: true }, host)) as {
      status: string;
    };
    expect(out.status).toBe("waiting");
    expect(api.saveGates).not.toHaveBeenCalled();
  });
});

describe("tasks.delegate reads the machine first (WP-161)", () => {
  it("looks at the machine before it decides, so the very first launch meets a pause", async () => {
    const { source, host, api, started } = fixture();
    const seen: string[] = [];
    let diskLow = false;
    api.pool = {
      limits: () => ({ workers: 6, heavy: 2 }),
      setLimits: () => ({ workers: 6, heavy: 2 }),
      model: () => undefined,
      openRows: () => [],
      refreshHealth: async () => {
        seen.push("read");
        diskLow = true;
      },
      admit: () => {
        seen.push("admit");
        return diskLow
          ? { start: false, line: "Free disk is 24 GB, which is below 30 GB. Running builders keep going.", reason: "health" }
          : { start: true };
      },
      enqueue: () => void seen.push("enqueue"),
      started: () => undefined,
      queued: () => [],
    } as unknown as AgentAppTasksHost["pool"];
    const out = (await handleAgentApp(source, "r-disk", "tasks.delegate", { brief: "Add delete." }, host)) as {
      status: string;
      waiting: string;
    };
    expect(seen).toEqual(["read", "admit", "enqueue"]);
    expect(out.status).toBe("waiting");
    expect(out.waiting).toContain("Free disk is 24 GB");
    expect(started).toHaveLength(0);
  });

  it("starts as before when the host does not read the machine", async () => {
    const { source, host, api, started } = fixture();
    api.pool = {
      limits: () => ({ workers: 6, heavy: 2 }),
      setLimits: () => ({ workers: 6, heavy: 2 }),
      model: () => undefined,
      openRows: () => [],
      admit: () => ({ start: true }),
      enqueue: () => undefined,
      started: () => undefined,
      queued: () => [],
    } as unknown as AgentAppTasksHost["pool"];
    await handleAgentApp(source, "r-plain", "tasks.delegate", { brief: "Add delete." }, host);
    expect(started).toHaveLength(1);
  });
});

describe("tasks.accept (WP-40)", () => {
  it("accepts one of its own and refuses one that isn't, or a refusal with no reason", async () => {
    const rows = [
      row({ id: "t-held", state: "completed", gateVerdict: "unsure" }),
      row({ id: "t-theirs", ownerSession: "mono-hivra", state: "completed", gateVerdict: "unsure" }),
    ];
    const { source, host, api } = fixture(rows);
    const decideGates = vi.fn(async () => undefined);
    api.decideGates = decideGates;
    await expect(handleAgentApp(source, "a1", "tasks.accept", { taskId: "t-held", accept: false }, host)).rejects.toThrow(
      "Say why it isn't done (reason), in one plain line.",
    );
    expect(decideGates).not.toHaveBeenCalled();
    await expect(handleAgentApp(source, "a2", "tasks.accept", { taskId: "t-theirs", accept: true }, host)).rejects.toThrow(
      "No task t-theirs of yours",
    );
    expect(decideGates).not.toHaveBeenCalled();
    const refused = await handleAgentApp(source, "a3", "tasks.accept", {
      taskId: "t-held",
      accept: false,
      reason: "The route still answers 404.",
    }, host);
    expect(refused).toEqual({ taskId: "t-held", accepted: false, gateVerdict: "failed" });
    expect(decideGates).toHaveBeenCalledWith("mono-exo", "t-held", false, "The route still answers 404.");
    const accepted = await handleAgentApp(source, "a4", "tasks.accept", { taskId: "t-held", accept: true }, host);
    expect(accepted).toMatchObject({ taskId: "t-held", accepted: true, gateVerdict: "passed" });
  });
});

describe("tasks.status", () => {
  it("reports a chat's own tasks and marks a finished result read, never an open one", async () => {
    const rows = [
      row({ id: "t-busy" }),
      row({
        id: "t-done",
        state: "completed",
        result: "Fixed: saves survive a restart (commit abc123)",
        askIds: ["a_1"],
        goal: "Saving survives a restart",
      }),
      row({
        id: "t-limit",
        state: "failed",
        errorClass: "billing",
        error: "Credit balance too low",
        retryable: false,
      }),
      row({ id: "t-child", rootId: "t-done", parentId: "t-done", ownerSession: "app-mono-exo-t-done" }),
      row({ id: "t-theirs", ownerSession: "mono-hivra" }),
    ];
    const { source, host, acknowledged } = fixture(rows);
    const out = (await handleAgentApp(source, "s1", "tasks.status", {}, host)) as {
      tasks: Array<Record<string, unknown>>;
    };
    expect(out.tasks.map((task) => task.taskId)).toEqual(["t-busy", "t-done", "t-limit"]);
    expect(acknowledged).toEqual(["t-done", "t-limit"]);
    expect(out.tasks[0]).toMatchObject({
      status: "running",
      activity: "working",
      lastActiveAt: new Date(9_000).toISOString(),
      hasPendingQuestion: false,
    });
    expect(out.tasks[0]).not.toHaveProperty("result");
    expect(out.tasks[1]).toMatchObject({
      status: "completed",
      activity: "stopped",
      result: "Fixed: saves survive a restart (commit abc123)",
      asks: ["a_1"],
      goal: "Saving survives a restart",
      delegated: { total: 1, running: 1 },
    });
    expect(out.tasks[2]).toMatchObject({
      status: "failed",
      errorClass: "billing",
      reason: "failed: billing refused",
      retryable: false,
      error: "Credit balance too low",
    });
    // A result read once is not "owed" any more.
    const again = (await handleAgentApp(source, "s2", "tasks.status", {}, host)) as {
      tasks: unknown[];
    };
    expect(again.tasks).toHaveLength(1);
  });

  it("says what the checks did, and says nothing when they have not run", async () => {
    const rows = [
      row({ id: "t-unsure", state: "completed", gateVerdict: "unsure" }),
      row({ id: "t-failed", state: "failed", gateVerdict: "failed" }),
      row({ id: "t-pending", gateVerdict: "pending" }),
      row({ id: "t-passed", state: "completed", gateVerdict: "passed" }),
      row({ id: "t-other", state: "completed", gateVerdict: "not-run" }),
      row({ id: "t-none", state: "completed" }),
    ];
    const { source, host } = fixture(rows);
    const out = (await handleAgentApp(source, "s-gates", "tasks.status", {
      taskIds: rows.map((entry) => entry.id),
    }, host)) as { tasks: Array<{ taskId: string; gates?: string }> };
    const line = (id: string) => out.tasks.find((task) => task.taskId === id)?.gates;
    expect(line("t-unsure")).toBe(
      "Its checks need you. Accept with task_accept, or refuse with a reason. It is not done until you do.",
    );
    expect(line("t-failed")).toBe("Its checks failed.");
    expect(line("t-pending")).toBe("Its checks are still running.");
    expect(line("t-passed")).toBe("Its checks passed.");
    expect(line("t-other")).toBe("Its checks have not passed.");
    expect(out.tasks.find((task) => task.taskId === "t-none")).not.toHaveProperty("gates");
  });

  it("with no ids, also lists the team's other open jobs read only (AD3: PM saw none while CoS's brief to EXO lead ran)", async () => {
    const rows = [
      row({ id: "t-cos", ownerSession: "mono-cos", ownerMono: "ada", title: "Fix EXO footer and mobile nav" }),
      row({ id: "t-cos-child", ownerSession: "lead-chat", ownerMono: "vg-game-lead", parentId: "t-cos", rootId: "t-cos" }),
      row({ id: "t-old", ownerSession: "mono-cos", ownerMono: "ada", state: "completed", delivery: "pending" }),
    ];
    const { source, host, api, acknowledged } = fixture(rows);
    api.teamOpen = vi.fn(async () => rows);
    const out = (await handleAgentApp(source, "s-team", "tasks.status", {}, host)) as {
      tasks: unknown[];
      othersRunning?: Array<Record<string, unknown>>;
      note?: string;
    };
    expect(out.tasks).toEqual([]);
    expect(out.othersRunning).toEqual([
      expect.objectContaining({ taskId: "t-cos", title: "Fix EXO footer and mobile nav", from: "ada", project: "vg-game", status: "running" }),
    ]);
    expect(out.note).toContain("no tasks of your own");
    expect(acknowledged).toEqual([]); // reading the team's jobs never marks someone else's result read
    // By id it stays the caller's own only.
    await expect(handleAgentApp(source, "s-team2", "tasks.status", { taskIds: ["t-cos"] }, host)).rejects.toThrow("No task t-cos of yours");
  });

  it("with no ids and nobody running, says so plainly", async () => {
    const { source, host, api } = fixture([]);
    api.teamOpen = vi.fn(async () => []);
    const out = (await handleAgentApp(source, "s-none", "tasks.status", {}, host)) as Record<string, unknown>;
    expect(out).not.toHaveProperty("othersRunning");
    expect(out.note).toBe("You have no tasks running or owed, and nobody else on the team has one open.");
  });

  it("never reads another chat's task, even by its id", async () => {
    const rows = [row({ id: "t-mine" }), row({ id: "t-theirs", ownerSession: "mono-hivra" })];
    const { source, host, acknowledged, cancelled, answered } = fixture(rows);
    for (const [action, input] of [
      ["tasks.status", { taskIds: ["t-mine", "t-theirs"] }],
      ["tasks.wait", { taskIds: ["t-theirs"] }],
      ["tasks.cancel", { taskId: "t-theirs" }],
      ["tasks.cannot", { taskId: "t-theirs", reason: "Waiting on a key" }],
      ["tasks.answer", { taskId: "t-theirs", requestId: 1, skip: true }],
    ] as const) {
      await expect(handleAgentApp(source, `x-${action}`, action, input, host)).rejects.toThrow(
        "No task t-theirs of yours",
      );
    }
    expect(acknowledged).toEqual([]);
    expect(cancelled).toEqual([]);
    expect(answered).toEqual([]);
    expect(rows[1].state).toBe("running");
  });
});

describe("tasks.wait", () => {
  it("returns at once when a task it waits on has finished or asks a question", async () => {
    const rows = [row({ id: "t-1" }), row({ id: "t-2", state: "question", pendingQuestion: "Which save slot?" })];
    const { source, host, clock } = fixture(rows);
    const out = await handleAgentApp(source, "w1", "tasks.wait", { taskIds: ["t-1", "t-2"] }, host);
    expect(out).toMatchObject({ settled: ["t-2"], running: 1, timedOut: false });
    expect(clock.now).toBe(0);
  });

  it("waits on the open tasks until one settles, without acknowledging it", async () => {
    const rows = [row({ id: "t-1" }), row({ id: "t-2" })];
    const { source, host, clock, acknowledged } = fixture(rows);
    vi.mocked(host.tasks!.nextChange).mockImplementation(async (ms) => {
      clock.now += ms;
      if (clock.now >= 6_000) rows[1].state = "completed";
    });
    const out = await handleAgentApp(source, "w2", "tasks.wait", {}, host);
    expect(out).toMatchObject({ settled: ["t-2"], running: 1, timedOut: false });
    expect(clock.now).toBe(6_000);
    expect(acknowledged).toEqual([]);
    expect(rows[1].delivery).toBe("pending");
  });

  it("gives up after its timeout, which is at most 25 seconds", async () => {
    const { source, host, clock } = fixture([row({ id: "t-1" })]);
    const out = await handleAgentApp(source, "w3", "tasks.wait", { timeoutSeconds: 5 }, host);
    expect(out).toMatchObject({ settled: [], running: 1, timedOut: true });
    expect(clock.now).toBe(5_000);
    await expect(
      handleAgentApp(source, "w4", "tasks.wait", { timeoutSeconds: 26 }, host),
    ).rejects.toThrow("timeoutSeconds must be a whole number from 0 to 25");
    const none = await handleAgentApp(source, "w5", "tasks.wait", { timeoutSeconds: 0 }, host);
    expect(none).toMatchObject({ running: 1, timedOut: true });
  });

  it("returns at once when nothing runs", async () => {
    const { source, host, clock } = fixture([row({ id: "t-1", state: "completed" })]);
    expect(await handleAgentApp(source, "w6", "tasks.wait", {}, host)).toMatchObject({
      tasks: [],
      running: 0,
      timedOut: false,
    });
    expect(clock.now).toBe(0);
  });
});

describe("tasks.cancel and tasks.answer", () => {
  it("cancels a task with its reason", async () => {
    const rows = [row({ id: "t-1" })];
    const { source, host, cancelled } = fixture(rows);
    expect(
      await handleAgentApp(source, "c1", "tasks.cancel", { taskId: "t-1", reason: "Ash changed his mind" }, host),
    ).toEqual({ taskId: "t-1", status: "cancelled", stopFailed: [] });
    expect(cancelled).toEqual([["t-1", "Ash changed his mind"]]);
    await handleAgentApp(source, "c2", "tasks.cancel", { taskId: "t-1" }, host);
    expect(cancelled[1]).toEqual(["t-1", "Cancelled by its owner."]);
  });

  it("answers only an open question, with answers or a skip", async () => {
    const rows = [row({ id: "t-q", state: "question", pendingQuestion: "Which slot?" }), row({ id: "t-run" })];
    const { source, host, answered } = fixture(rows);
    await expect(
      handleAgentApp(source, "a1", "tasks.answer", { taskId: "t-run", requestId: 3, skip: true }, host),
    ).rejects.toThrow("has no open question");
    await expect(
      handleAgentApp(source, "a2", "tasks.answer", { taskId: "t-q", requestId: 3 }, host),
    ).rejects.toThrow("Pass answers, or skip:true");
    await expect(
      handleAgentApp(
        source,
        "a3",
        "tasks.answer",
        { taskId: "t-q", requestId: 3, skip: true, answers: { q1: ["o1"] } },
        host,
      ),
    ).rejects.toThrow("Pass answers, or skip:true");
    await expect(
      handleAgentApp(source, "a4", "tasks.answer", { taskId: "t-q", requestId: -1, skip: true }, host),
    ).rejects.toThrow("requestId");
    expect(
      await handleAgentApp(
        source,
        "a5",
        "tasks.answer",
        { taskId: "t-q", requestId: 3, answers: { slot: ["two"] } },
        host,
      ),
    ).toEqual({ taskId: "t-q", answered: true });
    expect(answered).toEqual([[rows[0], 3, { kind: "answered", answers: { slot: ["two"] } }]]);
  });
});

// D5: the real "I cannot finish" signal. A Lead (or the worker itself) says it with one plain reason; the row carries a
// declared block, so the job lands in Ash's Needs you at once instead of looking merely idle, and a done claim over it
// is checked against it (leadFlow.ts, followedBriefs.ts).
describe("tasks.cannot: the agent's own word that it cannot finish", () => {
  it("records a block on its own running task, with the reason, and says it is Ash's at once", async () => {
    const rows = [row({ id: "t-1", title: "Deploy staging" })];
    const { source, host, declared } = fixture(rows);
    expect(
      await handleAgentApp(
        source,
        "nc1",
        "tasks.cannot",
        { taskId: "t-1", reason: "The staging deploy key is not on this machine." },
        host,
      ),
    ).toEqual({
      taskId: "t-1",
      title: "Deploy staging",
      status: "running",
      needsYou: true,
      reason: "The staging deploy key is not on this machine.",
      note: "It is in Ash's Needs you now. Say in one line what would unblock it, and do not report the work as done.",
    });
    expect(declared).toEqual([["owner:mono-exo", "t-1", "The staging deploy key is not on this machine."]]);
    expect(rows[0]).toMatchObject({
      stallKind: "blocked",
      stallReason: "The staging deploy key is not on this machine.",
    });
    // Declaring is not cancelling: it keeps running until it settles or is stopped.
    expect(rows[0].state).toBe("running");
  });

  it("needs a reason, a running task of the caller's, and says so when the row moved before the write", async () => {
    const rows = [
      row({ id: "t-1" }),
      row({ id: "t-done", state: "completed" }),
      row({ id: "t-theirs", ownerSession: "mono-hivra" }),
    ];
    const { source, host, api, declared } = fixture(rows);
    await expect(handleAgentApp(source, "nc2", "tasks.cannot", { taskId: "t-1" }, host)).rejects.toThrow("reason");
    await expect(
      handleAgentApp(source, "nc3", "tasks.cannot", { taskId: "t-done", reason: "Waiting on a key" }, host),
    ).rejects.toThrow("Task t-done is completed: only running work can be declared unfinished.");
    await expect(
      handleAgentApp(source, "nc4", "tasks.cannot", { taskId: "t-theirs", reason: "Waiting on a key" }, host),
    ).rejects.toThrow("No task t-theirs of yours");
    expect(declared).toEqual([]);
    // The row moved between the read and the write: saying so beats a false "it is in Needs you".
    api.cannot = vi.fn(async () => false);
    await expect(
      handleAgentApp(source, "nc5", "tasks.cannot", { taskId: "t-1", reason: "Waiting on a key" }, host),
    ).rejects.toThrow("Task t-1 moved before that was recorded. Read it with task_status.");
  });

  it("a worker leaves the taskId out and declares on the task working in its own chat", async () => {
    const rows = [
      row({ id: "t-mine", childSession: "app-mono-exo-r0" }),
      row({ id: "t-other", childSession: "app-mono-exo-t-other" }),
    ];
    const { source, host, declared, api } = fixture(rows, "worker");
    expect(source.id).toBe("app-mono-exo-r0");
    const result = await handleAgentApp(
      source,
      "nc6",
      "tasks.cannot",
      { reason: "Two tests disagree about the cache." },
      host,
    );
    // A worker's own block goes to its Lead first (workerStuck.ts stuckOwner), so it isn't Ash's yet.
    expect(result).toMatchObject({ taskId: "t-mine", status: "running", needsYou: false });
    expect((result as { note: string }).note).toMatch(/^Your Lead has it now/);
    expect(declared).toEqual([["self:app-mono-exo-r0", "t-mine", "Two tests disagree about the cache."]]);
    // No task of its own running: it says so rather than reaching for someone else's.
    api.selfTask = vi.fn(async () => undefined);
    await expect(
      handleAgentApp(source, "nc7", "tasks.cannot", { reason: "Two tests disagree about the cache." }, host),
    ).rejects.toThrow("No running task works in this chat.");
  });

  it("reads as Cannot finish in task_status, with its reason", async () => {
    const rows = [row({ id: "t-1", title: "Deploy staging" })];
    const { source, host } = fixture(rows);
    await handleAgentApp(
      source,
      "nc8",
      "tasks.cannot",
      { taskId: "t-1", reason: "The staging deploy key is not on this machine." },
      host,
    );
    const out = (await handleAgentApp(source, "nc9", "tasks.status", {}, host)) as {
      tasks: Array<Record<string, unknown>>;
    };
    expect(out.tasks[0]).toMatchObject({
      taskId: "t-1",
      status: "running",
      activity: "cannot finish: The staging deploy key is not on this machine.",
    });
  });
});

describe("questions and the tree (H4)", () => {
  it("starts every worker with full access, so no permission prompt strands it", async () => {
    const { source, host, started } = fixture();
    await handleAgentApp(source, "fa1", "tasks.delegate", { brief: "Fix the save bug" }, host);
    expect((started[0] as [Record<string, unknown>])[0]).toMatchObject({ runtimeMode: "full-access" });
  });

  it("marks the chat as waiting for the length of a wait, and ends it with hasPendingQuestion when a worker asks", async () => {
    const rows = [row({ id: "t-1" })];
    const { source, host, api } = fixture(rows);
    const waiting: boolean[] = [];
    api.waiting = (owner, on) => {
      expect(owner).toBe("mono-exo");
      waiting.push(on);
    };
    api.nextChange = vi.fn(async () => {
      rows[0].state = "question";
      rows[0].pendingQuestion = "Which branch?";
    });
    const result = await handleAgentApp(source, "qw1", "tasks.wait", { taskIds: ["t-1"], timeoutSeconds: 25 }, host);
    expect(result).toMatchObject({
      settled: ["t-1"],
      hasPendingQuestion: true,
      tasks: [{ taskId: "t-1", status: "question", hasPendingQuestion: true }],
    });
    expect(waiting).toEqual([true, false]);
    // A refused wait still ends the chat's waiting.
    await expect(
      handleAgentApp(source, "qw2", "tasks.wait", { taskIds: ["t-nobody"] }, host),
    ).rejects.toThrow("No task t-nobody of yours");
    expect(waiting).toEqual([true, false, true, false]);
  });

  it("ends a wait when a worker stalls, and says how it is stuck, so the Lead can steer or stop it", async () => {
    const rows = [row({ id: "t-1" }), row({ id: "t-2" })];
    const { source, host, api } = fixture(rows);
    api.nextChange = vi.fn(async () => {
      Object.assign(rows[0], { stallKind: "quiet", stallReason: "Still running npm test", stalledAt: 1_500 });
    });
    const result = await handleAgentApp(source, "sw1", "tasks.wait", { timeoutSeconds: 25 }, host);
    expect(result).toMatchObject({
      settled: [],
      running: 2,
      stalled: ["t-1"],
      timedOut: false,
      tasks: [
        {
          taskId: "t-1",
          status: "running",
          stalled: { kind: "quiet", reason: "Still running npm test", since: new Date(1_500).toISOString() },
        },
        { taskId: "t-2", status: "running" },
      ],
    });
    expect((result as { tasks: Array<Record<string, unknown>> }).tasks[1].stalled).toBeUndefined();
  });

  it("says how many tasks beneath a cancelled one stopped with it", async () => {
    const rows = [row({ id: "t-1" })];
    const { source, host, api } = fixture(rows);
    api.cancel = vi.fn(async (_owner, entry) => {
      entry.state = "cancelled";
      return { stopFailed: ["app-helper"], stopped: ["app-mono-exo-t-1"], cancelled: ["t-1", "t-2", "t-3"] };
    });
    expect(await handleAgentApp(source, "cc1", "tasks.cancel", { taskId: "t-1" }, host)).toEqual({
      taskId: "t-1",
      status: "cancelled",
      cancelledBeneath: 2,
      stopFailed: ["app-helper"],
    });
  });
});

describe("sessions.stop with cascade (H4)", () => {
  it("stops the session and everything beneath it, and reports what would not stop", async () => {
    const { source, host } = fixture();
    const worker: Session = { ...newSession("claude", PROJECT), id: "app-mono-exo-r1" };
    host.session = vi.fn(async (id: string) => (id === worker.id ? worker : null));
    host.sessions = vi.fn(async () => [{ id: worker.id }] as never);
    host.isMono = (id: string) => id === source.id;
    host.stopTree = vi.fn(async () => ({ stopFailed: ["app-app-mono-exo-r1-h"], stopped: [worker.id], cancelled: ["t-7"] }));
    expect(
      await handleAgentApp(source, "sc1", "sessions.stop", { sessionId: worker.id, cascade: true }, host),
    ).toEqual({
      sessionId: worker.id,
      stopped: true,
      cascade: true,
      cancelled: 1,
      stopFailed: ["app-app-mono-exo-r1-h"],
    });
    expect(host.stop).not.toHaveBeenCalled();
    await expect(
      handleAgentApp(source, "sc2", "sessions.stop", { sessionId: worker.id, cascade: "yes" }, host),
    ).rejects.toThrow("cascade must be a boolean");
    await handleAgentApp(source, "sc3", "sessions.stop", { sessionId: worker.id }, host);
    expect(host.stop).toHaveBeenCalledWith(worker.id);
  });

  it("says when it couldn't load the workers under the session, so the Stop isn't read as clean", async () => {
    const { source, host } = fixture();
    const worker: Session = { ...newSession("claude", PROJECT), id: "app-mono-exo-r2" };
    host.session = vi.fn(async (id: string) => (id === worker.id ? worker : null));
    host.sessions = vi.fn(async () => [{ id: worker.id }] as never);
    host.isMono = (id: string) => id === source.id;
    host.stopTree = vi.fn(async () => ({ stopFailed: [], stopped: [worker.id], cancelled: [], unloaded: [worker.id] }));
    expect(await handleAgentApp(source, "sc4", "sessions.stop", { sessionId: worker.id, cascade: true }, host)).toEqual({
      sessionId: worker.id,
      stopped: true,
      cascade: true,
      cancelled: 0,
      stopFailed: [],
      unloaded: [worker.id],
      note: `Couldn't load the workers under ${worker.id}; they may still be running.`,
    });
  });
});

// H8, Ash 16 Oct 17:40: "maybe today I want, like, 10 or 20 parallel workers, obviously ones that need to do heavy
// testing, then it would get throttled. But then it's really a per-project thing".
describe("parallel workers per project, with throttling (H8)", () => {
  function pooled(rows: Delegation[] = [], who: "mono" | "team" = "mono", room: () => ProviderRoom = () => ({ room: true })) {
    resetWorkerPool();
    const f = fixture(rows, who);
    const cards: Array<{ id: string; cwd: string; title: string }> = [];
    const cardLaunches: Array<Record<string, unknown>> = [];
    f.api.pool = workerPoolHost({
      openRows: () => rows.filter(isOpenDelegation),
      room: () => room(),
      card: (job, launch) => {
        cards.push({ id: job.id, cwd: launch.cwd, title: job.title });
        cardLaunches.push({ ...launch });
      },
    });
    // What App.tsx's pump does: ask the same delegate_task again, under the same request.
    const pump = () =>
      pumpWorkers({
        openRows: () => rows.filter(isOpenDelegation),
        room: () => room(),
        start: (job) => handleAgentApp(f.source, job.requestId, "tasks.delegate", markAppDelegate(job.input), f.host),
      });
    return { ...f, cards, cardLaunches, pump };
  }

  it("runs Ash's 20 workers at once in a project he set to 20; the 21st waits visibly and starts by itself", async () => {
    const rows: Delegation[] = [];
    const { source, host, started, cards, pump } = pooled(rows);
    setWorkerLimits("vg-game", { workers: 20 });
    for (let i = 1; i <= 20; i++) {
      const out = (await handleAgentApp(source, `r${i}`, "tasks.delegate", { brief: `Part ${i}.` }, host)) as Record<string, unknown>;
      expect(out.status).toBe("running");
    }
    expect(started).toHaveLength(20);
    const extra = (await handleAgentApp(source, "r21", "tasks.delegate", { brief: "Part 21.", title: "Part 21" }, host)) as Record<string, unknown>;
    // Not started, not failed: it waits, says why, and the Lead has nothing to do about it.
    expect(started).toHaveLength(20);
    expect(extra).toMatchObject({
      taskId: null,
      childSessionId: "app-mono-exo-r21",
      status: "waiting",
      waiting: "Waiting for a free worker: all 20 of vg-game's are busy.",
    });
    expect(extra.note).toContain("starts by itself");
    expect(extra.note).toContain("never a task id or a folder path");
    // Its card is in the Lead's chat already, under the chat it will be.
    expect(cards).toEqual([{ id: "app-mono-exo-r21", cwd: PROJECT, title: "Part 21" }]);
    // Nothing frees up: it keeps waiting.
    await pump();
    expect(started).toHaveLength(20);
    // One finishes: the waiting one starts on its own, as the same chat, and is a task of the Lead's like any other.
    rows[0].state = "completed";
    await pump();
    expect(started).toHaveLength(21);
    expect((started[20] as unknown[])[1]).toBe("app-mono-exo-r21");
    expect((started[20] as unknown[])[3]).toBe(source.id);
    expect(queuedWorkers()).toEqual([]);
    expect(rows.at(-1)).toMatchObject({ ownerSession: source.id, childSession: "app-mono-exo-r21", title: "Part 21" });
  });

  // r87 step 2: two jobs on the same file never run at once; the second waits, then starts by itself.
  it("holds a job whose files a running job changes, offers folding it in, and starts it once that one is done", async () => {
    const rows: Delegation[] = [];
    const { source, host, started, pump } = pooled(rows);
    const first = (await handleAgentApp(source, "ui", "tasks.delegate", { brief: "Use the shared type.", title: "UI uses shared type", files: ["src/App.tsx"] }, host)) as Record<string, unknown>;
    expect(first.status).toBe("running");
    const second = (await handleAgentApp(source, "week", "tasks.delegate", { brief: "Show last week's total in src/App.tsx.", title: "Last week" }, host)) as Record<string, unknown>;
    expect(second.status).toBe("waiting");
    expect(second.waiting).toContain('Waiting for "UI uses shared type" to land: both change src/App.tsx');
    expect(second.note).toContain("send that job a follow-up");
    const other = (await handleAgentApp(source, "api", "tasks.delegate", { brief: "Add /health.", files: ["api/server.ts"] }, host)) as Record<string, unknown>;
    expect(other.status).toBe("running");
    expect(started).toHaveLength(2);
    rows[0].state = "completed";
    await pump();
    expect(started).toHaveLength(3);
    expect((started[2] as unknown[])[1]).toBe("app-mono-exo-week");
  });

  it("refuses files that aren't a list of paths", async () => {
    const { source, host } = pooled([]);
    await expect(handleAgentApp(source, "bad", "tasks.delegate", { brief: "x", files: "src/App.tsx" }, host)).rejects.toThrow(/files must be a list/);
  });

  it("starts with a sensible default of 6 at once in a project Ash hasn't set", async () => {
    const rows: Delegation[] = [];
    const { source, host, started } = pooled(rows);
    expect(workerLimits("vg-game").workers).toBe(6);
    for (let i = 1; i <= 7; i++) await handleAgentApp(source, `r${i}`, "tasks.delegate", { brief: `Part ${i}.` }, host);
    expect(started).toHaveLength(6);
  });

  it("throttles the jobs the Lead marks heavy, while light ones keep starting", async () => {
    const rows: Delegation[] = [];
    const { source, host, started, pump } = pooled(rows);
    for (const id of ["e2e-1", "e2e-2"]) await handleAgentApp(source, id, "tasks.delegate", { brief: "Run the full e2e suite.", heavy: true }, host);
    const third = (await handleAgentApp(source, "e2e-3", "tasks.delegate", { brief: "Run the full e2e suite.", heavy: true }, host)) as Record<string, unknown>;
    expect(third).toMatchObject({ status: "waiting", heavy: true, waiting: "Waiting for a free worker: vg-game runs 2 heavy test jobs at once." });
    const light = (await handleAgentApp(source, "copy", "tasks.delegate", { brief: "Fix the button copy." }, host)) as Record<string, unknown>;
    expect(light.status).toBe("running");
    expect(started).toHaveLength(3);
    // A heavy one finishes: the waiting heavy one starts.
    rows.find((r) => r.childSession === "app-mono-exo-e2e-1")!.state = "completed";
    await pump();
    expect((started.at(-1) as unknown[])[1]).toBe("app-mono-exo-e2e-3");
    await expect(handleAgentApp(source, "bad", "tasks.delegate", { brief: "x", heavy: "yes" }, host)).rejects.toThrow("heavy must be true or false");
  });

  it("counts every chat working on the project, and gives a worker its own checkout next to another chat's", async () => {
    const rows: Delegation[] = [row({ id: "t-team", ownerSession: "team-exo", childSession: "app-team-exo-r1", requestId: "app-team-exo-r1" })];
    const { source, host, started } = pooled(rows);
    setWorkerLimits("vg-game", { workers: 2 });
    const first = (await handleAgentApp(source, "r1", "tasks.delegate", { brief: "Build the UI." }, host)) as Record<string, unknown>;
    // The Lead has no worker of its own out, but the coding-team chat's is in the same repo.
    expect((started[0] as [{ workspaceMode: string }])[0].workspaceMode).toBe("worktree");
    expect(first.isolationWhy).toContain("Another worker");
    const second = (await handleAgentApp(source, "r2", "tasks.delegate", { brief: "Build the API." }, host)) as Record<string, unknown>;
    expect(second.status).toBe("waiting");
  });

  it("backs off while the provider has no account with room, then starts by itself (E5's accounts decide)", async () => {
    const rows: Delegation[] = [];
    let limited = true;
    const until = new Date(2026, 9, 21, 15, 40).getTime();
    const { source, host, started, pump } = pooled(rows, "mono", () => (limited ? { room: false, provider: "Claude", until } : { room: true }));
    const out = (await handleAgentApp(source, "r1", "tasks.delegate", { brief: "Build it." }, host)) as Record<string, unknown>;
    expect(out.status).toBe("waiting");
    expect(String(out.waiting)).toMatch(/^Waiting for Claude's limit to reset at 3:40/);
    await pump();
    expect(started).toHaveLength(0);
    limited = false;
    await pump();
    expect(started).toHaveLength(1);
  });

  it("lists the waiting in task_status, and task_cancel takes one back (only the chat's own)", async () => {
    const rows: Delegation[] = [];
    const { source, host, started, pump } = pooled(rows);
    setWorkerLimits("vg-game", { workers: 1 });
    await handleAgentApp(source, "r1", "tasks.delegate", { brief: "One." }, host);
    await handleAgentApp(source, "r2", "tasks.delegate", { brief: "Two.", title: "Two" }, host);
    const status = (await handleAgentApp(source, "s", "tasks.status", {}, host)) as { tasks: unknown[]; waiting: unknown[] };
    expect(status.tasks).toHaveLength(1);
    expect(status.waiting).toEqual([
      { childSessionId: "app-mono-exo-r2", title: "Two", status: "waiting", waiting: "Waiting for a free worker: vg-game runs one at a time." },
    ]);
    // Another chat can't take it back.
    const other = { ...source, id: "mono-other" };
    await expect(handleAgentApp(other, "c0", "tasks.cancel", { taskId: "app-mono-exo-r2" }, host)).rejects.toThrow("No task");
    expect(await handleAgentApp(source, "c1", "tasks.cancel", { taskId: "app-mono-exo-r2" }, host)).toEqual({
      taskId: "app-mono-exo-r2",
      status: "cancelled",
      stopFailed: [],
    });
    rows[0].state = "completed";
    await pump();
    expect(started).toHaveLength(1);
  });

  it("saves the limit when Ash tells the Lead (tasks.workers), and reads it back", async () => {
    const { source, host } = pooled();
    expect(await handleAgentApp(source, "w0", "tasks.workers", {}, host)).toMatchObject({ project: "vg-game", workers: 6, heavy: 2 });
    const saved = await handleAgentApp(source, "w1", "tasks.workers", { workers: 20, heavy: 4 }, host);
    expect(saved).toEqual({
      project: "vg-game",
      workers: 20,
      heavy: 4,
      line: "vg-game runs up to 20 workers at once, 4 of them on heavy tests. Its workers use the usual model.",
      inForce: {
        cli: null,
        model: null,
        effort: null,
        cliFrom: "none",
        modelFrom: "none",
        effortFrom: "none",
        skipped: [],
      },
      scopes: { mono: null, project: null, system: null },
      spend: null,
    });
    expect(workerLimits("vg-game")).toEqual({ workers: 20, heavy: 4 });
    await expect(handleAgentApp(source, "w2", "tasks.workers", { workers: 40 }, host)).rejects.toThrow("from 1 to 30");
  });

  it("never starts a task twice: asked again for a request already started, it reads the task back (H8c)", async () => {
    const rows: Delegation[] = [];
    const { source, host, started } = pooled(rows);
    const first = (await handleAgentApp(source, "r1", "tasks.delegate", { brief: "Build it.", title: "Build it" }, host)) as Record<string, unknown>;
    const again = (await handleAgentApp(source, "r1", "tasks.delegate", { brief: "Build it.", title: "Build it" }, host)) as Record<string, unknown>;
    expect(started).toHaveLength(1);
    expect(again).toMatchObject({ taskId: first.taskId, childSessionId: "app-mono-exo-r1", status: "running", alreadyStarted: true });
    // A task its owner cancelled can be asked for again.
    rows[0].state = "cancelled";
    await handleAgentApp(source, "r1", "tasks.delegate", { brief: "Build it." }, host);
    expect(started).toHaveLength(2);
  });

  it("a waiting worker whose window died after it started, before it left the queue, isn't started again on relaunch", async () => {
    const rows: Delegation[] = [];
    const { source, host, started, pump } = pooled(rows);
    const store = memoryWorkerQueue();
    await setWorkerQueueBackend(store);
    setWorkerLimits("vg-game", { workers: 1 });
    await handleAgentApp(source, "r1", "tasks.delegate", { brief: "One." }, host);
    await handleAgentApp(source, "r2", "tasks.delegate", { brief: "Two." }, host);
    expect(store.jobs.map((q) => q.id)).toEqual(["app-mono-exo-r2"]);
    // r1 finishes; r2 is claimed and started, then the app dies before the queue hears it started.
    rows[0].state = "completed";
    await store.claim("app-mono-exo-r2", "dead-window");
    // (Its worker is running: the app recorded its task.)
    rows.push(row({ id: "t-r2", ownerSession: source.id, childSession: "app-mono-exo-r2", requestId: "app-mono-exo-r2" }));
    const before = started.length;
    // Relaunch: the claim is freed, the pump asks r2's delegate_task again, which finds its task and starts nothing.
    store.releaseAll();
    await setWorkerQueueBackend(store);
    rows.find((r) => r.id === "t-r2")!.state = "completed";
    await pump();
    expect(started.length).toBe(before);
    expect(store.jobs).toEqual([]);
    expect(queuedWorkers()).toEqual([]);
  });

  describe("what those workers run on (WP-89)", () => {
    const efforts = (values: string[]) => [
      {
        id: "effort",
        label: "Effort",
        kind: "select" as const,
        value: values[0],
        options: values.map((value) => ({ value, label: value })),
      },
    ];

    beforeEach(() => {
      localStorage.removeItem("monocode:mono-roster");
      setHarnessModels("claude", [
        { id: "claude:opus-4-7", harness: "claude", name: "Opus 4.7", settings: efforts(["low", "high", "max"]) },
        { id: "claude:sonnet-5", harness: "claude", name: "Sonnet", settings: efforts(["low", "medium", "high"]) },
      ]);
      setHarnessModels("cursor", [
        { id: "composer", harness: "cursor", name: "Composer", settings: efforts(["medium", "high"]) },
      ]);
      setHarnessModels("grok", [
        { id: "grok-4", harness: "grok", name: "Grok 4", settings: efforts(["low", "high"]) },
      ]);
      addMono({ id: "vg-game-lead", name: "EXO lead", mascot: "fox", color: "hsl(245 75% 65%)", projects: [PROJECT] });
      addMono({ id: "other-lead", name: "Other", mascot: "fox", color: "hsl(245 75% 65%)", projects: ["/tmp/other"] });
    });

    afterEach(() => {
      localStorage.removeItem("monocode:mono-roster");
      setLineRulesSource(undefined);
    });

    function lead(who: "mono" | "plain" | "habit" | "checker" | "worker" | "team" = "mono", rows: Delegation[] = []) {
      const f = pooled(rows, who === "team" ? "team" : "mono");
      if (who !== "mono" && who !== "team") {
        const again = fixture([], who);
        again.api.pool = f.api.pool;
        return again;
      }
      f.host.monoOf = () => {
        const stored = findMono("vg-game-lead");
        return {
          id: "vg-game-lead",
          name: stored?.name ?? "EXO lead",
          projects: stored?.projects ?? [PROJECT],
          ...(stored?.crewRules ? { crewRules: stored.crewRules } : {}),
          ...(stored?.workerDefault ? { workerDefault: stored.workerDefault } : {}),
        };
      };
      return f;
    }

    it("reads each scope and says what is in force", async () => {
      updateMono("vg-game-lead", (mono) => ({
        ...mono,
        workerDefault: { cli: "claude", model: "claude:opus-4-7", effort: "high" },
        crewRules: [{ labels: ["frontend"], paths: [], model: "claude:sonnet-5", source: "person" }],
      }));
      const { source, host } = lead();
      setSystemWorkerDefault({ effort: "low" });
      const read = await handleAgentApp(source, "w", "tasks.workers", {}, host) as {
        line: string;
        inForce: { model: string; modelFrom: string; effort: string };
        scopes: { mono: { model: string }; system: { effort: string } };
      };
      expect(read).toMatchObject({ project: "vg-game", workers: 6, heavy: 2 });
      expect(read.inForce).toMatchObject({ model: "claude:opus-4-7", modelFrom: "mono", effort: "high", effortFrom: "mono" });
      expect(read.scopes.mono.model).toBe("claude:opus-4-7");
      expect(read.scopes.system).toEqual({ effort: "low" });
      expect(read.line).toContain("vg-game runs up to 6 workers at once, 2 of them on heavy tests.");
      expect(read.line).toContain("Its workers use Opus 4.7 at high effort (set for this Mono).");
      expect(read.line).toContain("Crew rules still send `frontend` work to Sonnet.");
    });

    it("names a project rule and a plugin rule on the line", async () => {
      setLineRulesSource(async () => ({
        rules: [{ labels: ["backend"], paths: [], model: "claude:sonnet-5", source: "person" }],
        plugins: [{ labels: ["checks"], paths: [], cli: "cursor", source: "plugin" }],
      }));
      const { source, host } = lead();
      const read = await handleAgentApp(source, "w", "tasks.workers", {}, host) as { line: string };
      expect(read.line).toContain("`backend` work to Sonnet");
      expect(read.line).toContain("`checks` work to Cursor");
    });

    it("sets and clears each scope, and a plain name resolves", async () => {
      const { source, host } = lead();
      const mono = await handleAgentApp(source, "m", "tasks.workers", { scope: "mono", model: "opus", effort: "high" }, host) as { line: string };
      expect(findMono("vg-game-lead")?.workerDefault).toEqual({ cli: "claude", model: "claude:opus-4-7", effort: "high" });
      expect(findMono("other-lead")?.workerDefault).toBeUndefined();
      expect(mono.line).toContain("Its workers use Opus 4.7 at high effort (set for this Mono).");

      const project = await handleAgentApp(source, "p", "tasks.workers", { scope: "project", model: "grok 4", effort: "low" }, host) as { line: string; scopes: { project: { cli: string; model: string } } };
      expect(project.scopes.project).toEqual({ cli: "grok", model: "grok-4", effort: "low" });
      expect(project.line).toContain("set for this Mono");

      const cleared = await handleAgentApp(source, "c", "tasks.workers", { scope: "mono", clear: true }, host) as { line: string };
      expect(findMono("vg-game-lead")?.workerDefault).toBeUndefined();
      expect(cleared.line).toContain("Cleared the Mono's worker default.");
      expect(cleared.line).toContain("Grok 4");
      expect(cleared.line).toContain("set for this project");

      const everywhere = await handleAgentApp(source, "s", "tasks.workers", { scope: "system", effort: "high" }, host) as { scopes: { system: { effort: string } } };
      expect(everywhere.scopes.system).toEqual({ effort: "high" });
      const clearedSystem = await handleAgentApp(source, "sc", "tasks.workers", { scope: "system", clear: true }, host) as {
        scopes: { system: unknown; project: { cli: string } };
      };
      expect(clearedSystem.scopes.system).toBeNull();
      expect(clearedSystem.scopes.project).toEqual({ cli: "grok", model: "grok-4", effort: "low" });
      const clearedProject = await handleAgentApp(source, "pc", "tasks.workers", { scope: "project", clear: true }, host) as {
        scopes: { project: unknown; system: unknown };
      };
      expect(clearedProject.scopes.project).toBeNull();
      expect(clearedProject.scopes.system).toBeNull();
      expect(findMono("vg-game-lead")?.workerDefault).toBeUndefined();
    });

    it("refuses an unknown model, a wrong effort, and the callers who may not set it", async () => {
      const { source, host } = lead();
      await expect(handleAgentApp(source, "bad", "tasks.workers", { scope: "mono", model: "nope" }, host)).rejects.toThrow(
        /No CLI offers "nope"\. They offer Opus 4\.7.+Sonnet.+Composer.+Grok 4/,
      );
      await expect(
        handleAgentApp(source, "eff", "tasks.workers", { scope: "project", cli: "cursor", model: "composer", effort: "max" }, host),
      ).rejects.toThrow(/Composer doesn't offer "max"/);
      expect(findMono("vg-game-lead")?.workerDefault).toBeUndefined();
      expect(workerLimits("vg-game").model).toBeUndefined();

      for (const who of ["worker", "habit", "team"] as const) {
        const refused = lead(who);
        await expect(
          handleAgentApp(refused.source, who, "tasks.workers", { scope: "mono", model: "opus" }, refused.host),
        ).rejects.toThrow("Only a Mono sets what its workers run on, from its own chat.");
      }
      const checker = lead("checker");
      await expect(
        handleAgentApp(checker.source, "checker", "tasks.workers", { scope: "mono", model: "opus" }, checker.host),
      ).rejects.toThrow(/The checker only reads/);
      await expect(
        handleAgentApp(source, "proj", "tasks.workers", { scope: "project", project: "/tmp/other", model: "opus" }, host),
      ).rejects.toThrow("This Mono doesn't work on that project.");
      expect(findMono("vg-game-lead")?.workerDefault).toBeUndefined();
    });

    it("sets a spend limit from the first mate's own chat, and nobody else", async () => {
      const { source, host } = lead();
      const read = (await handleAgentApp(source, "r", "tasks.workers", {}, host)) as { spend: unknown; line: string };
      expect(read.spend).toBeNull();
      expect(read.line).not.toContain("Spend limit");
      const saved = (await handleAgentApp(
        source,
        "s",
        "tasks.workers",
        { scope: "project", amountUsd: 50, period: "month" },
        host,
      )) as { spend: { scope: string; amountUsd: number; period: string; warnAt: number }[]; line: string };
      expect(saved.spend).toEqual([
        expect.objectContaining({ scope: "project", project: "vg-game", period: "month", amountUsd: 50, warnAt: 0.8 }),
      ]);
      expect(saved.line).toContain("Spend limit for vg-game is $50 this month.");
      expect(saved.line).toContain("runs up to");
      // A first mate may lower its limit, and may not raise, clear or set the whole-app one (Settings only).
      await expect(
        handleAgentApp(source, "raise", "tasks.workers", { scope: "project", amountUsd: 900, period: "month" }, host),
      ).rejects.toThrow("Raising a spend limit needs your tap in Settings.");
      await expect(
        handleAgentApp(source, "clear", "tasks.workers", { scope: "project", spendClear: true, period: "month" }, host),
      ).rejects.toThrow("Clearing a spend limit needs your tap in Settings.");
      await expect(
        handleAgentApp(source, "system", "tasks.workers", { scope: "system", amountUsd: 10, period: "month" }, host),
      ).rejects.toThrow("The whole-app spend limit is set in Settings.");
      const lowered = (await handleAgentApp(
        source,
        "lower",
        "tasks.workers",
        { scope: "project", amountUsd: 20, period: "month" },
        host,
      )) as { line: string };
      expect(lowered.line).toContain("Spend limit for vg-game is $20 this month.");
      for (const who of ["worker", "habit"] as const) {
        const refused = lead(who);
        await expect(
          handleAgentApp(refused.source, who, "tasks.workers", { scope: "project", amountUsd: 10, period: "month" }, refused.host),
        ).rejects.toThrow("Only a first mate sets a spend limit, from its own chat.");
      }
      const checker = lead("checker");
      await expect(
        handleAgentApp(checker.source, "checker", "tasks.workers", { scope: "project", amountUsd: 10, period: "month" }, checker.host),
      ).rejects.toThrow(/checker only reads|Only a first mate sets a spend limit/);
      await expect(
        handleAgentApp(source, "mono", "tasks.workers", { scope: "mono", amountUsd: 10, period: "month" }, host),
      ).rejects.toThrow("not one Mono");
      await expect(
        handleAgentApp(source, "noscope", "tasks.workers", { amountUsd: 10, period: "month" }, host),
      ).rejects.toThrow("Say whether this is just this Mono, this project, or everything.");
      await expect(
        handleAgentApp(source, "bad", "tasks.workers", { scope: "project", amountUsd: 0, period: "month" }, host),
      ).rejects.toThrow("amountUsd must be a positive number.");
      await expect(
        handleAgentApp(source, "week", "tasks.workers", { scope: "project", amountUsd: 10, period: "week" }, host),
      ).rejects.toThrow('period must be "day" or "month".');
      await expect(
        handleAgentApp(source, "other", "tasks.workers", { scope: "project", project: "/tmp/other", amountUsd: 10, period: "month" }, host),
      ).rejects.toThrow("This Mono doesn't work on that project.");
      const cleared = (await handleAgentApp(
        source,
        "clear",
        "tasks.workers",
        { scope: "project", period: "month", spendClear: true },
        host,
      )) as { spend: unknown; line: string };
      expect(cleared.spend).toBeNull();
      expect(cleared.line).toContain("Spend limit cleared for vg-game.");
      // The whole-app limit is Settings only: a first mate's chat is refused, and the limit stays as it was.
      await expect(
        handleAgentApp(source, "app", "tasks.workers", { scope: "system", amountUsd: 5, period: "day" }, host),
      ).rejects.toThrow("The whole-app spend limit is set in Settings.");
    });

    it("posts a card with the previous setting, and a line in the activity log", async () => {
      updateMono("vg-game-lead", (mono) => ({ ...mono, workerDefault: { cli: "claude", model: "claude:sonnet-5", effort: "low" } }));
      const { source, host } = lead();
      const cards: unknown[] = [];
      const notes: unknown[] = [];
      host.postCard = (_id, card) => cards.push(card);
      host.noteActivity = (entry) => notes.push(entry);
      await handleAgentApp(source, "set", "tasks.workers", { scope: "mono", model: "opus", effort: "high" }, host);
      expect(cards).toEqual([
        expect.objectContaining({
          type: "worker-default",
          scope: "mono",
          previous: { cli: "claude", model: "claude:sonnet-5", effort: "low" },
        }),
      ]);
      expect(notes).toEqual([
        expect.objectContaining({ kind: "worker.default", target: "mono", project: "vg-game", actorId: "vg-game-lead" }),
      ]);
      const long = "n".repeat(200);
      updateMono("vg-game-lead", (mono) => ({
        ...mono,
        crewRules: [
          { labels: [long], paths: [], model: "claude:sonnet-5", source: "person" },
          { labels: ["m".repeat(200)], paths: [], model: "claude:opus-4-7", source: "person" },
        ],
      }));
      const wide = lead();
      const wideCards: { line?: string }[] = [];
      const wideNotes: { summary?: string }[] = [];
      wide.host.postCard = (_id, card) => wideCards.push(card as { line?: string });
      wide.host.noteActivity = (entry) => wideNotes.push(entry);
      await handleAgentApp(wide.source, "long", "tasks.workers", { scope: "mono", model: "opus", effort: "high" }, wide.host);
      expect(wideCards[0]?.line?.length ?? 0).toBeGreaterThan(500);
      expect(wideNotes[0]?.summary?.length ?? 0).toBeLessThanOrEqual(500);
      expect(wideNotes[0]?.summary?.startsWith("vg-game runs up to")).toBe(true);
      const limitsOnly = lead();
      const quiet: unknown[] = [];
      limitsOnly.host.postCard = () => quiet.push("card");
      await handleAgentApp(limitsOnly.source, "lim", "tasks.workers", { workers: 8 }, limitsOnly.host);
      expect(quiet).toEqual([]);
    });

    it("starts a worker on the default set before it, leaves a running one, and a queued one takes the change", async () => {
      const rows: Delegation[] = [];
      const { source, host, started, api, pump } = lead("mono", rows);
      // The command's route, without Tauri: a stored default is what the next start sees.
      api.crewRoute = vi.fn(async (query: CrewRouteQuery) =>
        resolveRoute(
          {
            labels: query.labels,
            paths: query.paths,
            ...(query.override ? { override: query.override } : {}),
          },
          query.monoRules ?? [],
          [
            { cli: "claude", installed: true, signedIn: true },
            { cli: "codex", installed: true, signedIn: true },
          ],
          {
            ...(query.defaults ? { defaults: query.defaults } : {}),
            catalog: query.catalog ?? launchCatalog(),
          },
        ),
      );
      const seen = (launch: { model?: string; modelSettings?: { effort?: string } }) => {
        const native = launch.model ? nativeModelId(launch.model) : undefined;
        const effort = normalizeClaudeCliEffort(launch.modelSettings?.effort, native);
        return parseCliArgs(
          buildClaudeSpawnArgs({
            ...(native ? { model: resolveClaudeApiModelId(native) } : {}),
            ...(effort ? { effort } : {}),
          }),
        );
      };

      setSystemWorkerDefault({ cli: "claude", model: "claude:opus-4-7", effort: "high" });
      await handleAgentApp(source, "after", "tasks.delegate", { brief: "Build the title." }, host);
      const first = started[0][0] as { model: string; modelSettings?: { effort?: string } };
      expect(first).toMatchObject({
        harness: "claude",
        model: "claude:opus-4-7",
        modelSettings: { effort: "high" },
        ranFrom: "set for every worker",
        ranEffort: "high",
      });
      expect(seen(first)).toMatchObject({ model: "claude-opus-4-7", effort: "high" });

      // Changed while it runs. Asked again, and pumped, it is not started over.
      setSystemWorkerDefault({ cli: "claude", model: "claude:sonnet-5", effort: "low" });
      const again = await handleAgentApp(source, "after", "tasks.delegate", { brief: "Build the title." }, host);
      await pump();
      expect(again).toMatchObject({ alreadyStarted: true, status: "running" });
      expect(started).toHaveLength(1);
      expect(started[0][0]).toMatchObject({ model: "claude:opus-4-7", modelSettings: { effort: "high" } });

      setWorkerLimits("vg-game", { workers: 1 });
      const waiting = (await handleAgentApp(source, "queued", "tasks.delegate", { brief: "Then the rest." }, host)) as {
        status: string;
      };
      expect(waiting.status).toBe("waiting");
      expect(started).toHaveLength(1);
      setSystemWorkerDefault({ cli: "claude", model: "claude:sonnet-5", effort: "medium" });
      // The queue's own refresh, started while the old default was still saved, must not put it back.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await pump();
      expect(started).toHaveLength(1);

      rows[0].state = "completed";
      await pump();
      expect(started).toHaveLength(2);
      const second = started[1][0] as { model: string; modelSettings?: { effort?: string } };
      expect(second).toMatchObject({ harness: "claude", model: "claude:sonnet-5", modelSettings: { effort: "medium" } });
      expect(seen(second)).toMatchObject({ model: "claude-sonnet-5", effort: "medium" });
      expect(started[0][0]).toMatchObject({ model: "claude:opus-4-7", modelSettings: { effort: "high" } });
    });

    /** The command's route, without Tauri: what crew_route answers for the defaults it is sent. */
    function realCrewRoute(available: string[] = ["claude", "codex"]) {
      return vi.fn(async (query: CrewRouteQuery) =>
        resolveRoute(
          {
            labels: query.labels,
            paths: query.paths,
            ...(query.override ? { override: query.override } : {}),
          },
          query.monoRules ?? [],
          available.map((cli) => ({ cli, installed: true, signedIn: true })),
          {
            ...(query.defaults ? { defaults: query.defaults } : {}),
            catalog: query.catalog ?? launchCatalog(),
          },
        ),
      );
    }

    it("starts a worker on the CLI this chat set for its Mono with tasks.workers, not the chat's own", async () => {
      setHarnessModels("codex", [{ id: "codex:gpt-5", harness: "codex", name: "GPT-5", settings: [] }]);
      const { source, host, started, api } = lead();
      api.crewRoute = realCrewRoute();
      const set = (await handleAgentApp(source, "m-codex", "tasks.workers", { scope: "mono", cli: "codex" }, host)) as {
        inForce: { cli: string; cliFrom: string };
      };
      expect(set.inForce).toMatchObject({ cli: "codex", cliFrom: "mono" });
      const result = (await handleAgentApp(source, "r-codex", "tasks.delegate", { brief: "Build the title." }, host)) as {
        cliFallback?: string;
      };
      // Installed: the setting applies, so nothing fell back and neither the result nor the card says otherwise.
      expect(result).not.toHaveProperty("cliFallback");
      expect(started).toHaveLength(1);
      expect(started[0][0]).toMatchObject({ harness: "codex", model: "codex:gpt-5" });
      expect(started[0][0]).not.toHaveProperty("cliFallback");
    });

    it("carries the model and effort this chat set for its Mono's workers", async () => {
      setHarnessModels("codex", [
        {
          id: "codex:gpt-5",
          harness: "codex",
          name: "GPT-5",
          settings: efforts(["low", "medium", "high"]),
        },
      ]);
      const { source, host, started, api } = lead();
      api.crewRoute = realCrewRoute();
      const set = (await handleAgentApp(
        source,
        "m-codex-effort",
        "tasks.workers",
        { scope: "mono", cli: "codex", model: "gpt 5", effort: "high" },
        host,
      )) as { inForce: { cli: string; model: string; effort: string } };
      expect(set.inForce).toMatchObject({ cli: "codex", model: "codex:gpt-5", effort: "high" });
      await handleAgentApp(source, "r-codex-effort", "tasks.delegate", { brief: "Build the title." }, host);
      expect(started[0][0]).toMatchObject({
        harness: "codex",
        model: "codex:gpt-5",
        modelSettings: { effort: "high" },
      });
    });

    it("says plainly when the CLI a Mono's workers were set to isn't installed, and what they run on instead", async () => {
      setHarnessModels("codex", [{ id: "codex:gpt-5", harness: "codex", name: "GPT-5", settings: [] }]);
      const { source, host, started, api } = lead();
      // The setting is in force (the route still answers codex); only the binary itself is missing on this Mac.
      api.crewRoute = realCrewRoute(["claude"]);
      probe.codexOff = true;
      const line = "Codex isn't installed here, so this worker runs on Claude Code.";
      try {
        const set = (await handleAgentApp(source, "m-codex", "tasks.workers", { scope: "mono", cli: "codex" }, host)) as {
          inForce: { cli: string; cliFrom: string };
        };
        expect(set.inForce).toMatchObject({ cli: "codex", cliFrom: "mono" });
        const result = (await handleAgentApp(source, "r-codex", "tasks.delegate", { brief: "Build the title." }, host)) as {
          cliFallback?: string;
          note: string;
        };
        expect(result.cliFallback).toBe(line);
        expect(result.note).toContain(line);
        // The fallback keeps the work moving: the worker starts on the chat's own CLI, and its card says why.
        expect(started).toHaveLength(1);
        expect(started[0][0]).toMatchObject({ harness: "claude", cliFallback: line });
      } finally {
        probe.codexOff = false;
      }
    });

    it("says it on a waiting worker's card too, and again when that worker starts", async () => {
      setHarnessModels("codex", [{ id: "codex:gpt-5", harness: "codex", name: "GPT-5", settings: [] }]);
      const rows: Delegation[] = [];
      const { source, host, started, api, cards, cardLaunches, pump } = lead("mono", rows);
      api.crewRoute = realCrewRoute(["claude"]);
      probe.codexOff = true;
      const line = "Codex isn't installed here, so this worker runs on Claude Code.";
      try {
        await handleAgentApp(source, "m-codex", "tasks.workers", { scope: "mono", cli: "codex" }, host);
        setWorkerLimits("vg-game", { workers: 1 });
        await handleAgentApp(source, "r-one", "tasks.delegate", { brief: "One." }, host);
        const waiting = (await handleAgentApp(source, "r-two", "tasks.delegate", { brief: "Two." }, host)) as {
          status: string;
          cliFallback?: string;
          note: string;
        };
        expect(waiting).toMatchObject({ status: "waiting", cliFallback: line });
        expect(waiting.note).toContain(line);
        expect(cards).toHaveLength(1);
        expect(cardLaunches[0]).toMatchObject({ harness: "claude", cliFallback: line });
        // It starts by itself later, still on the chat's CLI, with the same line.
        rows[0].state = "completed";
        await pump();
        expect(started).toHaveLength(2);
        expect(started[1][0]).toMatchObject({ harness: "claude", cliFallback: line });
      } finally {
        probe.codexOff = false;
      }
    });

    it("refuses a worker routed off the wrapper in a bench, instead of quietly running it on Claude", async () => {
      setHarnessModels("codex", [{ id: "codex:gpt-5", harness: "codex", name: "GPT-5", settings: [] }]);
      const { source, host, started, api } = lead();
      api.crewRoute = realCrewRoute();
      // The bench start: tasks.workers still says what is in force; only the CLI itself cannot start here.
      probe.onlyClaude = true;
      const global = globalThis as Record<string, unknown>;
      global.__MONOCODE_APP__ = benchIdentity();
      try {
        const set = (await handleAgentApp(source, "m-codex", "tasks.workers", { scope: "mono", cli: "codex" }, host)) as {
          inForce: { cli: string; cliFrom: string };
        };
        expect(set.inForce).toMatchObject({ cli: "codex", cliFrom: "mono" });
        await expect(
          handleAgentApp(source, "r-codex", "tasks.delegate", { brief: "Build the title." }, host),
        ).rejects.toThrow("This bench only starts the run's own Claude wrapper. It won't start codex.");
      } finally {
        delete global.__MONOCODE_APP__;
        probe.onlyClaude = false;
      }
      expect(started).toEqual([]);
    });
  });

  it("lets a coding-team chat's workers wait too, in its own project", async () => {
    const rows: Delegation[] = [];
    const { source, host, started } = pooled(rows, "team");
    setWorkerLimits("vg-game", { workers: 1 });
    await handleAgentApp(source, "r1", "tasks.delegate", { brief: "One." }, host);
    const out = (await handleAgentApp(source, "r2", "tasks.delegate", { brief: "Two." }, host)) as Record<string, unknown>;
    expect(started).toHaveLength(1);
    expect(out.status).toBe("waiting");
  });
});

describe("worker rules (r82, c02: a worker built Monday in while it was still Ash's pick)", () => {
  it("leaves Ash's choices to Ash and reports a mismatch at the top", () => {
    const rules = workerRules(4123);
    expect(rules).toMatch(/A choice that is Ash's .* is not yours to settle in code/);
    expect(rules).toMatch(/stop and ask your Lead/);
    expect(rules).toMatch(/doesn't match .* say so plainly at the top of your report/);
  });
});

describe("Hivra WP-14: tasks.message and tasks.ask", () => {
  const firstMate = () => {
    const recorded: unknown[] = [];
    const asked: unknown[] = [];
    const backend = {
      record: vi.fn(async (input: Record<string, unknown>) => {
        recorded.push(input);
        return { id: "s-1", state: "pending", heldAt: null, ...input };
      }),
      ask: vi.fn(async (input: Record<string, unknown>) => {
        asked.push(input);
        return {
          decision: { project: input.project, decisionKey: input.key, state: "open", waiting: input.taskIds },
          created: true,
          added: input.taskIds,
          released: [],
        };
      }),
    };
    return { host: { backend } as unknown as NonNullable<AgentAppTasksHost["firstMate"]>, recorded, asked };
  };

  it("sends a message to the caller's own running task, stored with its worker and request id", async () => {
    const { source, host, api } = fixture([row({ id: "t-1" })]);
    const fm = firstMate();
    api.firstMate = fm.host;
    const out = await handleAgentApp(source, "r-msg", "tasks.message", { taskId: "t-1", text: "Use the v2 API.", whenBusy: "queue" }, host);
    expect(fm.recorded).toEqual([
      { ownerSession: "mono-exo", childSession: "app-mono-exo-t-1", delegationId: "t-1", requestId: "r-msg", text: "Use the v2 API.", mode: "queue" },
    ]);
    expect(out).toMatchObject({ taskId: "t-1", messageId: "s-1", state: "pending" });
    await expect(handleAgentApp(source, "r-2", "tasks.message", { taskId: "t-nope", text: "x" }, host)).rejects.toThrow("No task t-nope");
  });

  it("asks the person under the waiting tasks' project, and a worker can't ask at all", async () => {
    const { source, host, api } = fixture([row({ id: "t-1" })]);
    const fm = firstMate();
    api.firstMate = fm.host;
    await handleAgentApp(
      source,
      "r-ask",
      "tasks.ask",
      { key: "retention", question: "Keep 30 days?", options: ["Yes", "No"], recommended: "Yes", taskIds: ["t-1"] },
      host,
    );
    expect(fm.asked).toEqual([
      expect.objectContaining({ askedBy: "mono-exo", askedByMono: "vg-game-lead", project: "vg-game", key: "retention", taskIds: ["t-1"] }),
    ]);
    const worker = fixture([], "worker");
    worker.api.firstMate = fm.host;
    await expect(
      handleAgentApp(worker.source, "r-w", "tasks.ask", { key: "k", question: "q", options: ["a", "b"], recommended: "a" }, worker.host),
    ).rejects.toThrow("A worker reports to the chat that delegated it");
  });
});

// WP-171: a contract, waves and the tasks that wait for what they need, through the same delegate every task uses.
describe("tasks.fanout: contracts and waves in the normal delegate path (WP-171)", () => {
  const INTENT = "Ash: a score board with an API behind it.";
  const api = {
    name: "api",
    brief: "Add GET /api/score in src/api/score.ts.",
    goal: "the route answers with a number",
    owns: ["src/api/score.ts"],
    provides: [
      { kind: "endpoint", name: "/api/score" },
      { kind: "file", name: "src/api/score.ts" },
    ],
    checks: ["api-tests"],
  };
  const board = {
    name: "board",
    brief: "Show the score in src/ui/Board.tsx.",
    goal: "the board shows the number",
    owns: ["src/ui/Board.tsx"],
    requires: ["/api/score"],
  };
  const docs = { name: "docs", brief: "Document the score in README.md.", goal: "the README explains it" };
  const FILE = `${PROJECT}/src/api/score.ts`;

  /** The delegate path as App.tsx wires it: the pool with dependencies, and the pump that settles them first. */
  function fanned(who: "mono" | "worker" | "checker" = "mono", rows: Delegation[] = []) {
    resetWorkerPool();
    forgetVerifications();
    const f = fixture(rows, who);
    const files: Record<string, string> = {};
    const time = { now: 1_000 };
    const io = { exists: async (path: string) => path in files, read: async (path: string) => files[path] ?? null };
    const lookup: DependencyLookup = {
      row: (session) => rows.find((entry) => entry.childSession === session),
      queued: (session) => queuedWorkers().some((entry) => entry.id === session),
      verified: (session, current) => verificationOf(session, current),
    };
    const dependency = fanoutDependency(lookup);
    const open = () => rows.filter(isOpenDelegation);
    f.api.pool = workerPoolHost({ openRows: open, room: () => ({ room: true }), dependency, card: () => {} });
    const pump = () =>
      pumpWorkers({
        openRows: open,
        room: () => ({ room: true }),
        dependency,
        settle: (queue) => settleFanout(queue, { row: lookup.row, folder: () => PROJECT, io, now: () => time.now }),
        start: (job) => handleAgentApp(f.source, job.requestId, "tasks.delegate", markAppDelegate(job.input), f.host),
      });
    const fan = (requestId: string, tasks: unknown[]) =>
      handleRaw(f.source, requestId, "tasks.fanout", { intent: INTENT, tasks }, f.host) as Promise<{
        waves: string[][];
        tasks: { name: string; wave: number; status: string; waiting?: string; error?: string; childSessionId?: string }[];
        warnings?: string[];
        note: string;
      }>;
    const finish = (index: number, patch: Partial<Delegation> = {}) =>
      Object.assign(rows[index], { state: "completed", status: "done", gateVerdict: "passed", version: 2, ...patch });
    return { ...f, rows, files, time, pump, fan, finish };
  }
  const startedIds = (started: unknown[][]) => started.map((call) => call[1]);
  const promptOf = (started: unknown[][], index: number) => (started[index][0] as { prompt: string }).prompt;

  it("starts the tasks that need nothing and holds the one that needs a provider, each as an ordinary task", async () => {
    const { fan, started, rows } = fanned();
    const out = await fan("r1", [api, board, docs]);
    expect(out.waves).toEqual([["api", "docs"], ["board"]]);
    expect(out.tasks.map((task) => [task.name, task.wave, task.status])).toEqual([
      ["api", 1, "running"],
      ["board", 2, "waiting"],
      ["docs", 1, "running"],
    ]);
    expect(out.tasks[1].waiting).toMatch(/^Waiting for api to finish and be checked/);
    expect(startedIds(started)).toEqual(["app-mono-exo-f2_r1-api", "app-mono-exo-f2_r1-docs"]);
    expect(rows.map((entry) => entry.childSession)).toEqual(["app-mono-exo-f2_r1-api", "app-mono-exo-f2_r1-docs"]);
    expect(queuedWorkers().map((entry) => entry.id)).toEqual(["app-mono-exo-f2_r1-board"]);
    expect(out.note).toContain("2 started now; 1 waits for what it needs");
    expect(out.note).not.toMatch(/[\u2014\u2013]/);
  });

  it("tells a room each task it handed out, as delegate_task does, so the work comes back to the room", async () => {
    const f = fanned();
    const delegated = vi.fn();
    (f.host as { rooms?: unknown }).rooms = { delegated };
    const out = await f.fan("r1", [api, board, docs]);
    expect(delegated.mock.calls.map((entry) => [entry[0], (entry[1] as { childSessionId: string }).childSessionId])).toEqual(
      out.tasks.map((task) => [f.source, task.childSessionId]),
    );
    expect(delegated.mock.calls[1][1]).toMatchObject({ childSessionId: "app-mono-exo-f2_r1-board", title: expect.any(String) });
  });

  it("with fresh-eyes on, holds each task for its review and keeps its place in the plan for the start", async () => {
    const f = fanned();
    const reviewed: { requestId: string; held?: Record<string, unknown> }[] = [];
    f.api.freshEyes = vi.fn(async (input) => {
      reviewed.push(input);
      return { hold: input.requestId.endsWith("-api"), why: "Fresh-eyes review: waiting on you" };
    });
    const out = await f.fan("r1", [api, board, docs]);
    expect(out.tasks.map((task) => [task.name, task.status, (task as { freshEyes?: boolean }).freshEyes ?? false])).toEqual([
      ["api", "waiting", true],
      ["board", "waiting", false],
      ["docs", "running", false],
    ]);
    // The call the review keeps is the one that starts later: it still says which plan it is part of.
    const held = reviewed.find((entry) => entry.requestId === "f2_r1-api")!.held!;
    expect(held.fanout).toMatchObject({ name: "api", plan: "r1" });
    expect(typeof held.originalRequest === "string" || held.originalRequest === undefined).toBe(true);
    expect(out.note).toContain("1 started now");
    expect(out.note).toContain("1 waits for its fresh-eyes review");
    expect(out.note).toContain("1 waits for what it needs");
  });

  it("starts all of them at once when none needs another, up to the first mate's eight", async () => {
    const { fan, started } = fanned();
    const many = Array.from({ length: 8 }, (_, i) => ({ name: `t${i}`, brief: `Do part ${i}.`, goal: `part ${i} works` }));
    const out = await fan("r8", many);
    expect(out.waves).toHaveLength(1);
    expect(started).toHaveLength(6); // the project's own limit of six still holds: the last two wait their turn
    expect(out.tasks.filter((task) => task.status === "waiting")).toHaveLength(2);
    await expect(fan("r9", [...many, { name: "t8", brief: "Do part 8.", goal: "part 8 works" }])).rejects.toThrow(/1 to 8 tasks/);
  });

  it("writes the contract into every brief: who it is, what it owns and provides, what it may rely on", async () => {
    const { fan, started, pump, rows, files, finish } = fanned();
    await fan("r1", [api, board]);
    const first = promptOf(started, 0);
    expect(first).toContain('## Fan-out contract\nYou are task "api" of a fan-out of 2 tasks, in wave 1.');
    expect(first).toContain("You provide: endpoint /api/score; file src/api/score.ts");
    expect(first).toContain("- [api] api-tests");
    // The intent the first mate sent is the Intent section of each brief.
    expect(first).toContain(`## Intent\n${INTENT}`);
    files[FILE] = 'app.get("/api/score", handler)';
    finish(0);
    await pump();
    const second = promptOf(started, 1);
    expect(second).toContain('You are task "board" of a fan-out of 2 tasks, in wave 2. What you waited for has been delivered and checked: api.');
    expect(second).toContain("You may rely on: /api/score (endpoint from api)");
    expect(rows).toHaveLength(2);
  });

  it("the dependent starts by itself once its provider is done, its checks passed and what it made is on disk", async () => {
    const { fan, started, pump, files, finish, time } = fanned();
    await fan("r1", [api, board]);
    await pump();
    expect(started).toHaveLength(1); // the provider is still working
    finish(0);
    await pump();
    expect(started).toHaveLength(1); // done, but the file is not there: not delivered
    files[FILE] = "export const x = 1;";
    time.now += 30_000;
    await pump();
    expect(started).toHaveLength(1); // the file is there but the route is not
    files[FILE] = 'app.get("/api/score", handler)';
    time.now += 30_000;
    await pump();
    expect(startedIds(started)).toEqual(["app-mono-exo-f2_r1-api", "app-mono-exo-f2_r1-board"]);
    expect(queuedWorkers()).toEqual([]);
  });

  it("never lets an unrun declared check pass: a done provider with no passing verdict holds its dependent", async () => {
    const { fan, started, pump, files, finish, source, host } = fanned();
    await fan("r1", [api, board]);
    files[FILE] = 'app.get("/api/score", handler)';
    finish(0, { gateVerdict: null });
    await pump();
    expect(started).toHaveLength(1);
    const status = (await handleAgentApp(source, "s1", "tasks.status", {}, host)) as { waiting: { waiting: string }[] };
    expect(status.waiting[0].waiting).toMatch(/^Held: api finished, but its declared check \(api-tests\) did not run or have not passed/);
  });

  it("holds the dependent when its provider fails, and the first mate reads what landed and what did not start", async () => {
    const { fan, started, pump, rows, source, host } = fanned();
    await fan("r1", [api, board, docs]);
    Object.assign(rows[0], { state: "failed", status: "failed", error: "the build broke in src/api/score.ts" });
    await pump();
    expect(startedIds(started)).toEqual(["app-mono-exo-f2_r1-api", "app-mono-exo-f2_r1-docs"]);
    const status = (await handleAgentApp(source, "s1", "tasks.status", {}, host)) as {
      waiting: { childSessionId: string; waiting: string }[];
    };
    expect(status.waiting).toHaveLength(1);
    expect(status.waiting[0].childSessionId).toBe("app-mono-exo-f2_r1-board");
    expect(status.waiting[0].waiting).toContain("Held: api failed: the build broke in src/api/score.ts.");
    expect(status.waiting[0].waiting).toContain("Not started: board.");
    // The first mate can take it back, as any waiting task.
    await handleAgentApp(source, "c1", "tasks.cancel", { taskId: "app-mono-exo-f2_r1-board" }, host);
    expect(queuedWorkers()).toEqual([]);
  });

  it("refuses a requirement nothing provides before anything starts", async () => {
    const { fan, started } = fanned();
    await expect(fan("r1", [api, { ...board, requires: ["/api/scores"] }])).rejects.toThrow(/Task board requires "\/api\/scores", but no task provides it/);
    expect(started).toEqual([]);
    expect(queuedWorkers()).toEqual([]);
  });

  it("says which tasks did not start, and does not run the ones that need them", async () => {
    const { fan, started, api: tasks, rows } = fanned();
    let calls = 0;
    tasks.checkDepth = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("Not started: you already have 8 tasks running, the most one first mate runs at once (8).");
      return 1;
    });
    const out = await fan("r1", [api, board, docs]);
    expect(out.tasks.map((task) => [task.name, task.status])).toEqual([
      ["api", "refused"],
      ["board", "not started"],
      ["docs", "running"],
    ]);
    expect(out.tasks[0].error).toContain("already have 8 tasks running");
    expect(out.tasks[1].error).toContain("It needs api, which did not start");
    expect(startedIds(started)).toEqual(["app-mono-exo-f2_r1-docs"]);
    expect(queuedWorkers()).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(out.note).toContain("2 did not start");
  });

  it("fails loudly when nothing at all could start", async () => {
    const { fan, api: tasks } = fanned();
    tasks.checkDepth = vi.fn(async () => {
      throw new Error("This task would sit 3 levels deep.");
    });
    await expect(fan("r1", [api, docs])).rejects.toThrow(/Nothing started\. api: This task would sit 3 levels deep\. docs: /);
  });

  it("sends the same call again without starting anything twice", async () => {
    const { fan, started } = fanned();
    await fan("r1", [api, board, docs]);
    const again = await fan("r1", [api, board, docs]);
    expect(started).toHaveLength(2);
    expect(again.tasks.find((task) => task.name === "api")).toMatchObject({ alreadyStarted: true });
    expect(queuedWorkers().map((entry) => entry.id)).toEqual(["app-mono-exo-f2_r1-board"]);
  });

  it("keeps each task's declared checks as its WP-40 checks gate", async () => {
    const { fan, api: tasks, rows } = fanned();
    const saved: unknown[][] = [];
    tasks.saveGates = vi.fn(async (...args: unknown[]) => void saved.push(args));
    await fan("r1", [api, docs]);
    expect(saved).toEqual([[rows[0].id, { gates: ["checks"], checks: ["api-tests"] }, PROJECT]]);
  });

  it("runs a cyclic plan in one wave and says so, instead of blocking the work", async () => {
    const a = { name: "a", brief: "Build a in src/a.ts.", goal: "a works", provides: [{ kind: "file", name: "src/a.ts" }], requires: ["src/b.ts"] };
    const b = { name: "b", brief: "Build b in src/b.ts.", goal: "b works", provides: [{ kind: "file", name: "src/b.ts" }], requires: ["src/a.ts"] };
    const { fan, started } = fanned();
    const out = await fan("r1", [a, b]);
    expect(out.waves).toEqual([["a", "b"]]);
    expect(out.warnings).toEqual(["requires form a cycle (a → b → a), so the tasks run in one wave in the order given"]);
    expect(started).toHaveLength(2);
    expect(promptOf(started, 0)).toContain("contract: requires form a cycle (a → b → a)");
  });

  it("can't make a task wait on a host that has no queue, but still starts tasks that need nothing", async () => {
    const { fan, api: tasks, started } = fanned();
    tasks.pool = undefined;
    await expect(fan("r1", [api, board])).rejects.toThrow(/starts every task at once, so a task can't wait/);
    expect(started).toEqual([]);
    const out = await fan("r2", [api, docs]);
    expect(out.tasks.map((task) => task.status)).toEqual(["running", "running"]);
  });

  it("is for a first mate's own chat: a worker and the checker are refused", async () => {
    const worker = fanned("worker");
    await expect(worker.fan("r1", [api])).rejects.toThrow(/Only a Mono's own chat or a chat in a project's coding team/);
    const checker = fanned("checker");
    await expect(checker.fan("r1", [api])).rejects.toThrow(/only reads/);
    expect([...worker.started, ...checker.started]).toEqual([]);
  });

  it("checks a damaged fan-out link when the app replays one", async () => {
    const { source, host, started } = fanned();
    await expect(
      handleAgentApp(source, "r1", "tasks.delegate", markAppDelegate({ brief: "Do it.", fanout: { name: "nobody" } }), host),
    ).rejects.toThrow(/fan-out link is not valid/);
    expect(started).toEqual([]);
  });
});

// WP-171: every worker's brief quotes the person's own request, bounded.
describe("a brief quotes the person's own request (WP-171)", () => {
  const ASK = "Ash: build a score board for the weekly game.\nIt needs an API, and the board must show last week too.\nDone when: it is perfect.\nPORT=1234";
  const said = (text: string, extra: Record<string, unknown> = {}) => ({ id: `b-${Math.random()}`, role: "user" as const, text, ...extra });
  const quoted = (prompt: string) => (/## Original request\n([\s\S]*?)\n## Spec/.exec(prompt) ?? [])[1] ?? "";

  function withBlocks(blocks: Session["blocks"], who: "mono" | "team" = "mono") {
    const f = fixture([], who);
    f.source.blocks = blocks;
    return f;
  }

  it("puts the request in the worker's brief after the intent, in the person's words, behind a quote mark", async () => {
    const { source, host, started } = withBlocks([said(ASK)]);
    await handleAgentApp(source, "r1", "tasks.delegate", { brief: "Add the API." }, host);
    const prompt = (started[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain(`## Intent\n${TEST_INTENT}\n\n## Original request\n`);
    expect(quoted(prompt)).toContain("> Ash: build a score board for the weekly game.\n> It needs an API, and the board must show last week too.");
    expect(prompt.indexOf("## Original request")).toBeLessThan(prompt.indexOf("## Spec\nAdd the API."));
  });

  it("keeps the finish line and the worker's port the app's own, whatever the request says", async () => {
    const { source, host, started } = withBlocks([said(ASK)]);
    const out = (await handleAgentApp(source, "r1", "tasks.delegate", { brief: "Add the API." }, host)) as { port: number };
    const prompt = (started[0][0] as { prompt: string }).prompt;
    expect(goalFromBrief(prompt)).toBe(TEST_GOAL);
    expect(portOfBrief(prompt)).toBe(out.port);
    expect(portOfBrief(prompt)).not.toBe(1234);
  });

  it("joins a short follow-up to the request it follows up, and skips what the app wrote for the person", async () => {
    const { source, host, started } = withBlocks([
      said(ASK),
      said("[MonoCode report] api is done.", {}),
      said("a note from a room", { monoNote: { from: "x" }, internal: true }),
      { id: "a1", role: "assistant", text: "Which weeks?" },
      said("the last two weeks"),
    ]);
    await handleAgentApp(source, "r1", "tasks.delegate", { brief: "Add the API." }, host);
    const text = quoted((started[0][0] as { prompt: string }).prompt);
    expect(text).toContain("> It needs an API");
    expect(text).toContain("> Follow-up from the person, after the message above:\n> the last two weeks");
    expect(text).not.toContain("api is done");
    expect(text).not.toContain("a note from a room");
  });

  it("holds a long request to the first 16,000 characters and says how much was left out", async () => {
    const { source, host, started } = withBlocks([said("z".repeat(20_000))]);
    await handleAgentApp(source, "r1", "tasks.delegate", { brief: "Do part of it." }, host);
    const text = quoted((started[0][0] as { prompt: string }).prompt);
    expect(text).toContain(`> ${"z".repeat(16_000)}\n`);
    expect(text).not.toContain("z".repeat(16_001));
    expect(text).toContain("(Cut here: the request is 20,000 characters and only the first 16,000 are quoted.)");
  });

  it("writes no section when the person has said nothing in this chat, and the empty intent is still refused", async () => {
    const { source, host, started } = withBlocks([]);
    await handleAgentApp(source, "r1", "tasks.delegate", { brief: "Do it." }, host);
    expect((started[0][0] as { prompt: string }).prompt).not.toContain("Original request");
    await expect(handleRaw(source, "r2", "tasks.delegate", { brief: "Do it.", goal: "done", intent: "TODO" }, host)).rejects.toThrow(/The intent \(intent\) is a placeholder/);
  });

  it("is in every task of a fan-out and in a Lead's brief, and a coding team's chat is no different", async () => {
    const { source, host, started } = withBlocks([said(ASK)], "team");
    await handleRaw(
      source,
      "r1",
      "tasks.fanout",
      { intent: TEST_INTENT, tasks: [{ name: "a", brief: "Do a.", goal: "a works" }, { name: "b", brief: "Do b.", goal: "b works" }] },
      host,
    );
    expect(started).toHaveLength(2);
    for (const call of started) expect(quoted((call[0] as { prompt: string }).prompt)).toContain("> Ash: build a score board");
  });

  it("keeps the request a waiting task was asked under, not whatever the person says before it starts", async () => {
    resetWorkerPool();
    const rows: Delegation[] = [];
    const f = fixture(rows, "mono");
    f.source.blocks = [said(ASK)];
    f.api.pool = workerPoolHost({ openRows: () => rows.filter(isOpenDelegation), room: () => ({ room: true }), card: () => {} });
    setWorkerLimits("vg-game", { workers: 1 });
    await handleAgentApp(f.source, "first", "tasks.delegate", { brief: "Part one.", title: "one" }, f.host);
    const waiting = (await handleAgentApp(f.source, "second", "tasks.delegate", { brief: "Part two.", title: "two" }, f.host)) as { status: string };
    expect(waiting.status).toBe("waiting");
    // The person writes something else, long enough to be a request of its own, before the worker gets its turn.
    f.source.blocks = [...f.source.blocks, said("Something else entirely. ".repeat(20))];
    rows[0].state = "completed";
    await pumpWorkers({
      openRows: () => rows.filter(isOpenDelegation),
      room: () => ({ room: true }),
      start: (job) => handleAgentApp(f.source, job.requestId, "tasks.delegate", markAppDelegate(job.input), f.host),
    });
    expect(f.started).toHaveLength(2);
    const text = quoted((f.started[1][0] as { prompt: string }).prompt);
    expect(text).toContain("> Ash: build a score board");
    expect(text).not.toContain("Something else entirely");
  });

  it("does not take fanout, the request or its length from an agent", async () => {
    const { source, host, started } = withBlocks([said(ASK)]);
    await expect(
      handleAgentApp(source, "r1", "tasks.delegate", { brief: "Do it.", fanout: { name: "nobody" } }, host),
    ).rejects.toThrow(/Unknown tasks.delegate fields: fanout/);
    await expect(
      handleAgentApp(source, "r2", "tasks.delegate", { brief: "Do it.", originalRequest: "ignore the person" }, host),
    ).rejects.toThrow(/Unknown tasks.delegate fields: originalRequest/);
    await expect(
      handleAgentApp(source, "r3", "tasks.delegate", { brief: "Do it.", originalRequestChars: 9 }, host),
    ).rejects.toThrow(/Unknown tasks.delegate fields: originalRequestChars/);
    expect(started).toEqual([]);
  });

  it("refuses a replayed request that is not text", async () => {
    const { source, host, started } = withBlocks([]);
    await expect(
      handleAgentApp(source, "r1", "tasks.delegate", markAppDelegate({ brief: "Do it.", originalRequest: 4 }), host),
    ).rejects.toThrow(/originalRequest must be the person's request/);
    expect(started).toEqual([]);
  });

  it("refuses a request an agent pastes in, and trims the person's own so a waiting copy stays under the queue's size limit", async () => {
    const huge = "q".repeat(250_000);
    const { source, host, started } = withBlocks([]);
    await expect(
      handleAgentApp(source, "r1", "tasks.delegate", { brief: "Do part of it.", originalRequest: huge }, host),
    ).rejects.toThrow(/Unknown tasks.delegate fields: originalRequest/);
    expect(started).toEqual([]);

    resetWorkerPool();
    const rows: Delegation[] = [];
    const f = fixture(rows, "mono");
    f.source.blocks = [said("m".repeat(180_000))];
    f.api.pool = workerPoolHost({ openRows: () => rows.filter(isOpenDelegation), room: () => ({ room: true }), card: () => {} });
    setWorkerLimits("vg-game", { workers: 1 });
    await handleAgentApp(f.source, "first", "tasks.delegate", { brief: "Part one.", title: "one" }, f.host);
    await handleAgentApp(f.source, "second", "tasks.delegate", { brief: "Part two.", title: "two" }, f.host);
    const waiting = queuedWorkers().find((job) => job.requestId === "second");
    expect(waiting).toBeTruthy();
    // worker_queue.rs refuses a job whose JSON is over 200,000 characters, so the stored request has to be the quote.
    expect(JSON.stringify(waiting).length).toBeLessThan(200_000);
    rows[0].state = "completed";
    await pumpWorkers({
      openRows: () => rows.filter(isOpenDelegation),
      room: () => ({ room: true }),
      start: (job) => handleAgentApp(f.source, job.requestId, "tasks.delegate", markAppDelegate(job.input), f.host),
    });
    expect(f.started).toHaveLength(2);
    expect(quoted((f.started[1][0] as { prompt: string }).prompt)).toContain(
      "(Cut here: the request is 180,000 characters and only the first 16,000 are quoted.)",
    );
  });
});

