/**
 * WP-91: the goal and its finish line are values from a model, so they are untrusted until they are checked here, and
 * everything the Rust side sends back is checked again before it reaches the record or the screen.
 */
import { describe, expect, it, vi } from "vitest";
import {
  decisionAskInput,
  describeGoalReport,
  goalRunView,
  Orchestrator,
  irreversibleDecisionKey,
  withCheckRun,
  type ControlOutcome,
  type OrchestrationHost,
  type StoredDecision,
} from "./orchestration";
import { validateGoal, validateGoalCheck } from "./orchestrationPlan";
import { watchDecisions } from "./decisionWatch";
import {
  goalCheckLine,
  normalizeCheckRun,
  normalizeGoalAnswer,
  normalizePlanAnswer,
  refusalMessage,
  refusalOf,
  type GoalGraphBackend,
  type GoalRunView,
} from "./orchestrationGoal";
import { newSession } from "../../sessions/model/session";
import { normalizeOrchestrationRun } from "./orchestrationState";
import type { OrchestrationRun, OrchestrationTask } from "./orchestrationState";

/**
 * The goal graph's rules live in Rust and are tested there. These tests stand in for that boundary, so what they
 * exercise is the wiring — which rules the app asks for, and what it does with the answer.
 */
function stubGoalsBackend(
  overrides: Partial<GoalGraphBackend> = {},
): GoalGraphBackend {
  return {
    checkPlan: vi.fn(async () => ({
      verify: "verify",
      layers: [],
      criticalPath: [],
      bottlenecks: [],
      lint: [],
    })),
    checkRepair: vi.fn(async () => {}),
    report: vi.fn(async (run: GoalRunView) => ({
      report: {
        goal: run.goal,
        verdict: "unverified" as const,
        reasons: ["tasks_open"],
        layers: [],
        criticalPath: [],
        bottlenecks: [],
        lint: [],
        ready: [],
        cyclesLeft: {},
        replan: [],
        extendsLeft: 2,
      },
    })),
    runCheck: vi.fn(async () => ({
      outcome: "failed" as const,
      exitCode: 1,
      output: "1 failing",
      layer: "app",
      at: 1,
    })),
    readHandoff: vi.fn(async (checkout: string, taskId: string) => ({
      path: `${checkout}/.hivra/handoff/${taskId}.md`,
      sha256: "0".repeat(64),
      bytes: 12,
      text: "## Changed\nok",
      headings: ["Changed"],
      missing: ["Files", "Checked", "Left"],
    })),
    ...overrides,
  };
}

describe("the goal", () => {
  it("is one plain line, and a value that is not one is refused", () => {
    expect(validateGoal("  The settings screen saves and reloads  ")).toBe(
      "The settings screen saves and reloads",
    );
    for (const bad of ["", "   ", 7, null, undefined, "a\nb", "a\u0000b"]) {
      expect(() => validateGoal(bad)).toThrow();
    }
    expect(() => validateGoal("x".repeat(241))).toThrow("the goal this run is for");
  });
});

describe("the finish-line check", () => {
  it("takes a command, an exit code and optionally text it must print", () => {
    expect(validateGoalCheck({ command: "npm test" })).toEqual({
      command: "npm test",
      expectExit: 0,
    });
    expect(
      validateGoalCheck({
        command: "npm test",
        expectExit: 1,
        expectText: "0 failing",
        timeoutSeconds: 900,
      }),
    ).toEqual({
      command: "npm test",
      expectExit: 1,
      expectText: "0 failing",
      timeoutSeconds: 900,
    });
    // A named project check has no baseline of its own here (it is not run and not stored), so the field is not
    // carried: the run records one finish-line command, which is the run's baseline.
    expect(
      validateGoalCheck({ command: "x", checks: Array.from({ length: 21 }, (_, i) => `c${i}`) }),
    ).toEqual({ command: "x", expectExit: 0 });
  });

  it("refuses a missing command, a command that spans lines, and an impossible exit code", () => {
    expect(() => validateGoalCheck({})).toThrow("the command that proves the goal");
    expect(() => validateGoalCheck({ command: "" })).toThrow();
    expect(() => validateGoalCheck({ command: "npm test\nrm -rf /" })).toThrow(
      "one line",
    );
    for (const expectExit of ["0", 1.5, 900, -900, null]) {
      if (expectExit === null) continue;
      expect(() => validateGoalCheck({ command: "x", expectExit })).toThrow(
        "between -255 and 255",
      );
    }
    expect(() => validateGoalCheck({ command: "x", expectText: "a\nb" })).toThrow(
      "one line",
    );
    expect(() =>
      validateGoalCheck({ command: "x", timeoutSeconds: -1 }),
    ).toThrow("whole number of seconds");
  });

  it("reads in one plain line for the card", () => {
    expect(goalCheckLine({ command: "npm test", expectExit: 0 })).toBe(
      "npm test (exit 0)",
    );
    expect(
      goalCheckLine({ command: "npm test", expectExit: 1, expectText: "0 failing" }),
    ).toContain('printing "0 failing"');
    expect(goalCheckLine(undefined)).toContain("No finish-line check");
  });
});

describe("what Rust sends back", () => {
  it("turns a refusal into one plain sentence", () => {
    expect(
      refusalMessage({
        reason: "write_scope_overlap",
        say: "These tasks can run at the same time and write the same paths.",
      }),
    ).toBe("These tasks can run at the same time and write the same paths.");
    expect(refusalMessage(new Error("network"))).toBe("network");
    expect(
      refusalOf({ reason: "handoff_missing", say: "  No handoff file.  " }),
    ).toEqual({ code: "handoff_missing", message: "No handoff file." });
    expect(refusalOf(new Error("plain"))).toBeUndefined();
  });

  it("never trusts a shape it did not get", () => {
    expect(normalizeCheckRun({ outcome: "passed", at: 4 })).toEqual({
      outcome: "passed",
      output: "",
      layer: "app",
      at: 4,
    });
    // A timeout or a missing field is "not run", never a pass.
    expect(normalizeCheckRun({ outcome: "weird" })?.outcome).toBe("notRun");
    expect(normalizeCheckRun(null)).toBeUndefined();

    const answer = normalizeGoalAnswer({ report: { verdict: "done", reasons: 7 } });
    expect(answer.report.verdict).toBe("unverified");
    expect(answer.report.reasons).toEqual([]);
    expect(answer.report.layers).toEqual([]);
    expect(answer.report.extendsLeft).toBe(0);
    expect(answer.refusal).toBeUndefined();

    const plan = normalizePlanAnswer({ verify: 5, layers: "no" });
    expect(plan.verify).toBe("");
    expect(plan.layers).toEqual([]);
  });
});

describe("the run as the rules read it", () => {
  const task = (
    id: string,
    patch: Partial<OrchestrationTask> = {},
  ): OrchestrationTask => ({
    id,
    sessionId: `${id}-session`,
    title: id,
    harness: "codex",
    model: "codex:test",
    prompt: "do it",
    files: ["src"],
    scopes: ["/repo/src"],
    dependsOn: [],
    status: "queued",
    accepted: false,
    result: "",
    delivered: true,
    ...patch,
  });

  const run = (patch: Partial<OrchestrationRun> = {}): OrchestrationRun => ({
    version: 2,
    leadId: "lead",
    cwd: "/repo",
    status: "active",
    allowedHarnesses: ["codex"],
    maxWorkers: 2,
    cli: "/app/monocode",
    tasks: [],
    continuations: 0,
    requests: {},
    ...patch,
  });

  it("reads every fact from the record, never from a report", () => {
    const view = goalRunView(
      run({
        goal: "the screen saves",
        baseline: { outcome: "failed", exitCode: 1, output: "", layer: "app", at: 1 },
        checkRuns: [
          { outcome: "failed", exitCode: 1, output: "", layer: "app", at: 2 },
          { outcome: "passed", exitCode: 0, output: "", layer: "delivery", at: 3 },
        ],
        repairCycles: { a: [["r1"]] },
        extends: 1,
        tasks: [
          task("a", { accepted: true, status: "completed", gateOutcome: "passed" }),
          task("b", { status: "failed" }),
          task("c", { status: "cancelled" }),
          task("v", {
            role: "verify",
            files: [],
            gateOutcome: "notRun",
            irreversible: true,
            irreversibleReason: "it deploys",
            irreversibleAnswered: true,
          }),
        ],
      }),
    );
    expect(view.goal).toBe("the screen saves");
    expect(view.nodes.map((node) => node.accepted)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(view.nodes[3].role).toBe("verify");
    // The gate's own word crosses the boundary, never a boolean: passed, failed, notRun and held stay distinct,
    // and a task no gate saw sends nothing.
    expect(view.nodes[0].gateOutcome).toBe("passed");
    expect(view.nodes[3].gateOutcome).toBe("notRun");
    expect(view.nodes[1].gateOutcome).toBeUndefined();
    expect(view.nodes[1].failed).toBe(true);
    expect(view.nodes[2].cancelled).toBe(true);
    expect(view.nodes[3].irreversible).toEqual({
      reason: "it deploys",
      key: irreversibleDecisionKey("lead", "v"),
      answered: true,
    });
    expect(view.latest?.layer).toBe("delivery");
    expect(view.repairs).toEqual({ a: [["r1"]] });
    expect(view.extends).toBe(1);
  });

  it("keeps one run of the check per layer, so the record says which layer ran it", () => {
    const first = withCheckRun(run(), {
      outcome: "failed",
      output: "1 failing",
      layer: "app",
      at: 1,
    });
    const again = withCheckRun(first, {
      outcome: "passed",
      output: "green",
      layer: "app",
      at: 2,
    });
    expect(again.checkRuns).toHaveLength(1);
    expect(again.checkRuns?.[0].outcome).toBe("passed");
    const withDelivery = withCheckRun(again, {
      outcome: "passed",
      output: "green",
      layer: "delivery",
      at: 3,
    });
    expect(withDelivery.checkRuns?.map((entry) => entry.layer)).toEqual([
      "app",
      "delivery",
    ]);
  });
});

describe("a run read back from the database", () => {
  it("draws from a truncated row without the parts it cannot read", () => {
    const run = normalizeOrchestrationRun({
      version: 2,
      leadId: "lead",
      cwd: "/repo",
      status: "active",
      allowedHarnesses: ["codex"],
      maxWorkers: 2,
      cli: "/app/monocode",
      continuations: 0,
      requests: {},
      goal: 7,
      check: { command: 7 },
      checkRuns: "nope",
      repairCycles: { a: [["r"], "bad"] },
      goalReport: {
        verdict: "done",
        reasons: 7,
        layers: [["a"], "bad", [7, "b"]],
        extendsLeft: "two",
      },
      tasks: [
        {
          id: "a",
          sessionId: "s-a",
          title: "A",
          harness: "codex",
          model: "codex:test",
          prompt: "do it",
          files: "src",
          scopes: null,
          dependsOn: 5,
          status: "queued",
          accepted: false,
          result: "",
          delivered: true,
          role: "wizard",
          gateOutcome: "maybe",
          handoff: { path: 7 },
          repairs: 7,
          cycle: 1.5,
          extendFrom: "   ",
        },
      ],
    } as unknown as OrchestrationRun);
    expect(run.goal).toBeUndefined();
    expect(run.check).toBeUndefined();
    expect(run.baseline).toBeUndefined();
    expect(run.checkRuns).toBeUndefined();
    expect(run.repairCycles).toEqual({ a: [["r"]] });
    expect(run.goalReport).toMatchObject({
      verdict: "unverified",
      reasons: [],
      layers: [["a"], [], ["b"]],
      extendsLeft: 0,
    });
    expect(run.tasks[0]).toMatchObject({
      files: [],
      scopes: [],
      dependsOn: [],
      handoff: undefined,
      repairs: undefined,
      cycle: undefined,
      extendFrom: undefined,
    });
    expect(run.tasks[0].role).toBeUndefined();
    expect(run.tasks[0].gateOutcome).toBeUndefined();
  });
});

describe("the reasons a run is not done, in the person's words", () => {
  const report = (reasons: string[]) => ({
    goal: "g",
    verdict: "unverified" as const,
    reasons,
    layers: [],
    criticalPath: [],
    bottlenecks: [],
    lint: [],
    ready: [],
    cyclesLeft: {},
    replan: [],
    extendsLeft: 0,
  });

  it("says each one plainly", () => {
    expect(describeGoalReport(report(["check_failed"]))).toBe(
      "the finish-line check failed",
    );
    expect(describeGoalReport(report(["check_not_run"]))).toBe(
      "the finish-line check has not run, or could not",
    );
    expect(describeGoalReport(report(["gate_failed:a"]))).toContain("(a)");
    expect(describeGoalReport(report(["verification_open:v"]))).toContain(
      "the verify task has not been accepted",
    );
    expect(describeGoalReport(report(["handoff_not_checked:m:v"]))).toContain(
      "a handoff was never opened or is missing",
    );
    expect(describeGoalReport(report(["something_new:z"]))).toContain(
      "something_new:z",
    );
    expect(describeGoalReport(report([]))).toContain("named no reason");
  });
});

/** A worker's own test double for the orchestrator's two seams. */
function fixture(decisions: StoredDecision[] = []) {
  type Saved = OrchestrationRun;
  const saved = new Map<string, Saved>();
  const parked: StoredDecision[] = [...decisions];
  const store = {
    save: vi.fn(async (entry: Saved) => {
      saved.set(entry.leadId, structuredClone(entry));
    }),
    load: vi.fn(async (id: string) => saved.get(id) ?? null),
    enable: vi.fn(async () => "/app/monocode"),
    disable: vi.fn(async () => {}),
    scopes: vi.fn(async (cwd: string, files: string[]) =>
      files.map((file) => (file === "." ? cwd : `${cwd}/${file}`)),
    ),
    resolvePath: vi.fn(async (path: string) => path),
    askDecision: vi.fn(async (input: { leadId: string; taskId: string }) => {
      const entry: StoredDecision = {
        key: irreversibleDecisionKey(input.leadId, input.taskId),
        answered: false,
      };
      parked.push(entry);
      return entry;
    }),
    decisions: vi.fn(async () => parked),
  };
  const goals = stubGoalsBackend();
  const manager = new Orchestrator(store, goals);
  const lead = { ...newSession("claude", "/repo"), id: "lead", busy: true };
  const sessions = [lead];
  const completions = new Map<string, (outcome: ControlOutcome) => void>();
  const host = {
    session: (id: string) => sessions.find((entry) => entry.id === id),
    sessions: () => sessions,
    choices: () => [{ harness: "codex" as const, models: [{ id: "codex:test", name: "Test" }] }],
    createWorker: vi.fn(async (run: OrchestrationRun, task: OrchestrationTask) => {
      sessions.push({ ...newSession(task.harness, run.cwd), id: task.sessionId });
      return {
        workspace: {
          id: `checkout:/w/${task.id}`,
          projectCwd: run.cwd,
          checkoutCwd: `/w/${task.id}`,
          kind: "worktree" as const,
        },
      };
    }),
    integrateWorker: vi.fn(async () => ({ files: [], alreadyApplied: 0 })),
    cleanupWorker: vi.fn(async () => true),
    submit: vi.fn((id: string, _text: string, done: (o: ControlOutcome) => void) => {
      const session = sessions.find((entry) => entry.id === id)!;
      session.busy = true;
      completions.set(id, (outcome) => {
        session.busy = false;
        done(outcome);
      });
    }),
    stop: vi.fn(async (id: string) => {
      const session = sessions.find((entry) => entry.id === id);
      if (session) session.busy = false;
    }),
    steer: vi.fn(async () => {}),
    respondApproval: vi.fn(),
    answerQuestion: vi.fn(),
  } as unknown as OrchestrationHost;
  manager.bind(host);
  const call = (action: string, input: Record<string, unknown> = {}) =>
    manager.handle("lead", `r-${action}-${JSON.stringify(input)}`, action, input);
  const start = async () => {
    (sessions[0] as { busy: boolean }).busy = false;
    await manager.start("lead", ["codex"], 2);
    (sessions[0] as { busy: boolean }).busy = true;
  };
  const parkedAnswers = parked;
  const delegate = async (extra: Record<string, unknown> = {}) => {
    const result = (await call("delegate", {
      title: "Task",
      prompt: "Implement the bounded change",
      harness: "codex",
      files: ["src"],
      ...extra,
    })) as { taskId: string };
    return result.taskId;
  };
  const complete = async (taskId: string, text = "Done") => {
    const task = manager.run("lead")!.tasks.find((entry) => entry.id === taskId)!;
    await vi.waitFor(() => expect(completions.has(task.sessionId)).toBe(true));
    completions.get(task.sessionId)!({ status: "completed", text });
    await vi.waitFor(() =>
      expect(
        manager.run("lead")!.tasks.find((entry) => entry.id === taskId)!.status,
      ).toBe("completed"),
    );
  };
  return {
    manager,
    store,
    goals,
    saved,
    host,
    parked: parkedAnswers,
    completions,
    call,
    start,
    delegate,
    complete,
  };
}

describe("an irreversible step", () => {
  it("waits for the person before any checkout or process is made", async () => {
    const f = fixture();
    await f.start();
    await f.delegate({
      irreversible: true,
      reason: "it migrates the shared database",
    });
    await vi.waitFor(() => expect(f.store.askDecision).toHaveBeenCalledTimes(1));
    expect(f.host.createWorker).not.toHaveBeenCalled();
    const task = f.manager.run("lead")!.tasks[0];
    expect(task.status).toBe("queued");
    expect(task.irreversible).toBe(true);
    expect(task.irreversibleKey).toBe(
      irreversibleDecisionKey("lead", task.id),
    );
    expect(f.manager.waitingFor(f.manager.run("lead")!, task)).toContain(
      "Waiting for your decision",
    );
    // The lead cannot answer it either: approve only reports where it stands.
    const parked = (await f.call("approve", { taskId: task.id })) as {
      parked: boolean;
      say: string;
    };
    expect(parked.parked).toBe(true);
    expect(parked.say).toContain("Only the person answers this one");
  });

  it("starts once the person approves, and is sent back as a failed task with their words", async () => {
    const f = fixture();
    await f.start();
    const approved = await f.delegate({
      irreversible: true,
      reason: "it spends money",
    });
    await vi.waitFor(() => expect(f.store.askDecision).toHaveBeenCalledTimes(1));
    f.parked[0] = { ...f.parked[0], answered: true, answer: "Approve" };
    f.manager.decisionsChanged();
    await vi.waitFor(() => expect(f.host.createWorker).toHaveBeenCalledTimes(1));
    expect(
      f.manager.run("lead")!.tasks.find((entry) => entry.id === approved)!
        .irreversibleAnswered,
    ).toBe(true);

    const sentBack = await f.delegate({
      irreversible: true,
      reason: "it deletes the old table",
    });
    await vi.waitFor(() => expect(f.store.askDecision).toHaveBeenCalledTimes(2));
    f.parked[1] = {
      ...f.parked[1],
      answered: true,
      answer: "Send back: use a copy first",
    };
    f.manager.decisionsChanged();
    await vi.waitFor(() =>
      expect(
        f.manager.run("lead")!.tasks.find((entry) => entry.id === sentBack)!.status,
      ).toBe("failed"),
    );
    const task = f.manager.run("lead")!.tasks.find((entry) => entry.id === sentBack)!;
    expect(task.error).toContain("use a copy first");
    expect(f.host.createWorker).toHaveBeenCalledTimes(1);
  });

  it("is raised under the run's project, so the person sees it where the run's other questions are", async () => {
    const f = fixture();
    // The host names the hub project a folder belongs to, the way a delegation's project is named.
    f.manager.bind({
      ...f.host,
      decisionProject: (folder: string) => (folder === "/repo" ? "hivra" : folder),
    } as OrchestrationHost);
    await f.start();
    await f.delegate({ irreversible: true, reason: "it migrates the shared database" });
    await vi.waitFor(() => expect(f.store.askDecision).toHaveBeenCalledTimes(1));
    expect(f.store.askDecision).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: "lead", project: "hivra" }),
    );
  });

  it("falls back to the project's folder when the host names no hub project, or cannot say", async () => {
    for (const decisionProject of [
      undefined,
      () => "",
      () => {
        throw new Error("the hub is not loaded");
      },
    ]) {
      const f = fixture();
      f.manager.bind({ ...f.host, decisionProject } as unknown as OrchestrationHost);
      await f.start();
      await f.delegate({ irreversible: true, reason: "it spends money" });
      await vi.waitFor(() => expect(f.store.askDecision).toHaveBeenCalledTimes(1));
      expect(f.store.askDecision).toHaveBeenCalledWith(
        expect.objectContaining({ project: "/repo" }),
      );
    }
  });

  it("starts the step when the app says a decision was answered, without the lead or a reload", async () => {
    const f = fixture();
    const listeners = new Map<string, () => void>();
    const off = vi.fn();
    const stop = watchDecisions(
      async (event, handler) => {
        listeners.set(event, handler);
        return off;
      },
      () => f.manager.decisionsChanged(),
    );
    await vi.waitFor(() => expect(listeners.has("hivra:decisions-changed")).toBe(true));
    await f.start();
    const id = await f.delegate({ irreversible: true, reason: "it spends money" });
    await vi.waitFor(() => expect(f.store.askDecision).toHaveBeenCalledTimes(1));
    expect(f.host.createWorker).not.toHaveBeenCalled();
    // The person approves in the Inbox: the store holds the answer, and the app emits its event.
    f.parked[0] = { ...f.parked[0], answered: true, answer: "Approve" };
    listeners.get("hivra:decisions-changed")!();
    await vi.waitFor(() => expect(f.host.createWorker).toHaveBeenCalledTimes(1));
    expect(
      f.manager.run("lead")!.tasks.find((entry) => entry.id === id)!.irreversibleAnswered,
    ).toBe(true);
    stop();
    expect(off).toHaveBeenCalledOnce();
    await f.manager.stopRun("lead");
  });

  it("leaves an ordinary task alone", async () => {
    const f = fixture();
    await f.start();
    const id = await f.delegate();
    await vi.waitFor(() => expect(f.host.createWorker).toHaveBeenCalledTimes(1));
    expect(f.store.askDecision).not.toHaveBeenCalled();
    expect(f.manager.run("lead")!.tasks.find((e) => e.id === id)!.irreversible).toBeUndefined();
    await expect(f.call("approve", { taskId: id })).rejects.toThrow(
      "it starts on its own",
    );
  });
});

describe("a repair", () => {
  it("is a new task that names the failed one, and only its downstream waits", async () => {
    const f = fixture();
    await f.start();
    const broken = await f.delegate({ title: "Broken" });
    const downstream = await f.delegate({
      title: "Downstream",
      dependsOn: [broken],
      files: ["docs"],
    });
    await vi.waitFor(() => expect(f.host.createWorker).toHaveBeenCalledTimes(1));
    const task = f.manager.run("lead")!.tasks.find((e) => e.id === broken)!;
    f.completions.get(task.sessionId)!({ status: "failed", text: "", error: "boom" });
    await vi.waitFor(() =>
      expect(
        f.manager.run("lead")!.tasks.find((e) => e.id === broken)!.status,
      ).toBe("failed"),
    );
    const repaired = (await f.call("repair", {
      taskId: broken,
      title: "Fix it",
      prompt: "Fix what broke",
    })) as { taskId: string; cycle: number; replan: boolean };
    expect(repaired.cycle).toBe(1);
    expect(repaired.replan).toBe(false);
    const created = f.manager.run("lead")!.tasks.find((e) => e.id === repaired.taskId)!;
    expect(created.repairs).toBe(broken);
    expect(created.dependsOn).toEqual(task.dependsOn);
    expect(
      f.manager.run("lead")!.tasks.find((e) => e.id === downstream)!.status,
    ).toBe("queued");
    expect(f.manager.run("lead")!.repairCycles?.[broken]).toEqual([
      [repaired.taskId],
    ]);
  });

  it("allows two cycles, and the second is a re-plan that says what failed before", async () => {
    const f = fixture();
    await f.start();
    const broken = await f.delegate();
    await vi.waitFor(() => expect(f.host.createWorker).toHaveBeenCalledTimes(1));
    const task = f.manager.run("lead")!.tasks.find((e) => e.id === broken)!;
    f.completions.get(task.sessionId)!({ status: "failed", text: "", error: "boom" });
    await vi.waitFor(() =>
      expect(
        f.manager.run("lead")!.tasks.find((e) => e.id === broken)!.status,
      ).toBe("failed"),
    );
    const first = (await f.call("repair", {
      taskId: broken,
      title: "Fix one",
      prompt: "Try again",
    })) as { taskId: string; replan: boolean };
    expect(first.replan).toBe(false);
    // The first repair fails too, and the second cycle is a re-plan.
    await vi.waitFor(() => expect(f.host.submit).toHaveBeenCalledTimes(2));
    const second = f.manager.run("lead")!.tasks.find((e) => e.id === first.taskId)!;
    f.completions.get(second.sessionId)!({ status: "failed", text: "", error: "still broken" });
    await vi.waitFor(() =>
      expect(
        f.manager.run("lead")!.tasks.find((e) => e.id === first.taskId)!.status,
      ).toBe("failed"),
    );
    const replan = (await f.call("repair", {
      taskId: first.taskId,
      title: "Re-plan",
      prompt: "Try a different approach",
    })) as { replan: boolean; cycle: number };
    expect(replan.replan).toBe(true);
    expect(replan.cycle).toBe(2);
    const created = f.manager.run("lead")!.tasks.find((e) => e.id === replan.taskId)!;
    expect(created.prompt).toContain("re-plan");
    expect(created.prompt).toContain("still broken");

    // A third cycle is refused, with the root named.
    const again = f.manager.run("lead")!.tasks.find((e) => e.id === replan.taskId)!;
    await vi.waitFor(() => expect(f.completions.has(again.sessionId)).toBe(true));
    f.completions.get(again.sessionId)!({ status: "failed", text: "", error: "no" });
    await vi.waitFor(() =>
      expect(
        f.manager.run("lead")!.tasks.find((e) => e.id === replan.taskId)!.status,
      ).toBe("failed"),
    );
    await expect(
      f.call("repair", { taskId: replan.taskId, title: "Third", prompt: "again" }),
    ).rejects.toThrow("2 repair cycles");
  });

  it("refuses a task that has not failed", async () => {
    const f = fixture();
    await f.start();
    const id = await f.delegate();
    await expect(
      f.call("repair", { taskId: id, title: "Fix", prompt: "x" }),
    ).rejects.toThrow("Only a failed or blocked task is repaired");
  });

  it("is decided by the rules before it joins the record, and a failed check is repaired by a build task", async () => {
    const f = fixture();
    await f.start();
    const verify = await f.delegate({ title: "Check", role: "verify", files: [] });
    await vi.waitFor(() => expect(f.host.createWorker).toHaveBeenCalledTimes(1));
    const session = f.manager.run("lead")!.tasks.find((e) => e.id === verify)!.sessionId;
    f.completions.get(session)!({ status: "failed", text: "", error: "the check could not run" });
    await vi.waitFor(() =>
      expect(f.manager.run("lead")!.tasks.find((e) => e.id === verify)!.status).toBe(
        "failed",
      ),
    );

    const repaired = (await f.call("repair", {
      taskId: verify,
      title: "Fix what the check found",
      prompt: "Fix the build so the check passes",
      files: ["src/a.rs"],
    })) as { taskId: string };

    // The rules were asked first, with the repair as a node of the run. A repair of a check is a build
    // task: the check goes back in the queue when the repair is accepted, so it is never replaced.
    expect(f.goals.checkRepair).toHaveBeenCalledTimes(1);
    expect(f.goals.checkRepair).toHaveBeenCalledWith(
      expect.objectContaining({ nodes: expect.any(Array) }),
      expect.objectContaining({
        role: "build",
        repairs: verify,
        dependsOn: [],
      }),
    );
    const created = f.manager.run("lead")!.tasks.find((e) => e.id === repaired.taskId)!;
    expect(created.role).toBe("build");
    expect(created.repairs).toBe(verify);
    expect(created.dependsOn).toEqual([]);
  });

  it("writes nothing when the rules refuse it", async () => {
    const f = fixture();
    await f.start();
    const broken = await f.delegate({ title: "Broken" });
    await vi.waitFor(() => expect(f.host.createWorker).toHaveBeenCalledTimes(1));
    const task = f.manager.run("lead")!.tasks.find((e) => e.id === broken)!;
    f.completions.get(task.sessionId)!({ status: "failed", text: "", error: "boom" });
    await vi.waitFor(() =>
      expect(f.manager.run("lead")!.tasks.find((e) => e.id === broken)!.status).toBe(
        "failed",
      ),
    );
    f.goals.checkRepair = vi.fn(async () => {
      throw {
        reason: "write_scope_overlap",
        say: "These tasks can run at the same time and write the same paths.",
      };
    });
    await expect(
      f.call("repair", { taskId: broken, title: "Fix", prompt: "Fix it" }),
    ).rejects.toThrow("These tasks can run at the same time and write the same paths.");
    expect(f.manager.run("lead")!.tasks).toHaveLength(1);
    expect(f.manager.run("lead")!.repairCycles).toEqual({});
  });

  it("changes nothing when the task was cancelled", async () => {
    const f = fixture();
    await f.start();
    const first = await f.delegate({ title: "First" });
    await vi.waitFor(() => expect(f.host.createWorker).toHaveBeenCalledTimes(1));
    const second = await f.delegate({
      title: "Second",
      dependsOn: [first],
      files: ["docs"],
    });
    await f.call("cancel", { taskId: second });
    expect(
      f.manager.run("lead")!.tasks.find((e) => e.id === second)!.status,
    ).toBe("cancelled");
    await expect(
      f.call("repair", { taskId: second, title: "Fix", prompt: "Fix it" }),
    ).rejects.toThrow("A cancelled task is not repaired");
    expect(f.goals.checkRepair).not.toHaveBeenCalled();
    expect(f.manager.run("lead")!.tasks).toHaveLength(2);
    expect(f.manager.run("lead")!.repairCycles).toEqual({});
  });
});

describe("the pump and a repair", () => {
  it("starts a repair without waiting on the failed task, and its dependents run once it is accepted", async () => {
    const f = fixture();
    await f.start();
    const broken = await f.delegate({ title: "Broken" });
    const downstream = await f.delegate({
      title: "Downstream",
      dependsOn: [broken],
      files: ["docs"],
    });
    await vi.waitFor(() => expect(f.host.createWorker).toHaveBeenCalledTimes(1));
    const session = f.manager.run("lead")!.tasks.find((e) => e.id === broken)!.sessionId;
    f.completions.get(session)!({ status: "failed", text: "", error: "boom" });
    await vi.waitFor(() =>
      expect(f.manager.run("lead")!.tasks.find((e) => e.id === broken)!.status).toBe(
        "failed",
      ),
    );

    const repaired = (await f.call("repair", {
      taskId: broken,
      title: "Fix it",
      prompt: "Fix what broke",
    })) as { taskId: string };
    const created = f.manager.run("lead")!.tasks.find((e) => e.id === repaired.taskId)!;
    // The failed task is not a dependency of its repair: the pump would wait on it forever.
    expect(created.dependsOn).toEqual([]);
    await vi.waitFor(() => expect(f.host.createWorker).toHaveBeenCalledTimes(2));

    // The downstream still waits: neither the root nor a repair of it is accepted yet.
    expect(
      f.manager.run("lead")!.tasks.find((e) => e.id === downstream)!.status,
    ).toBe("queued");

    await f.complete(repaired.taskId);
    await f.call("review", { taskId: repaired.taskId });
    await vi.waitFor(() =>
      expect(
        f.manager.run("lead")!.tasks.find((e) => e.id === downstream)!.status,
      ).not.toBe("queued"),
    );
  });

  it("never starts a task the person cancelled while its decision was being read", async () => {
    const f = fixture();
    await f.start();
    let release!: (value: StoredDecision[]) => void;
    f.store.decisions = vi.fn(
      () =>
        new Promise<StoredDecision[]>((resolve) => {
          release = resolve;
        }),
    ) as unknown as typeof f.store.decisions;
    const id = await f.delegate({
      irreversible: true,
      reason: "it deletes the old table",
    });
    await vi.waitFor(() => expect(f.store.decisions).toHaveBeenCalled());

    await f.call("cancel", { taskId: id });
    release([
      {
        key: irreversibleDecisionKey("lead", id),
        answered: true,
        answer: "Approve",
      },
    ]);
    await vi.waitFor(() =>
      expect(
        f.manager.run("lead")!.tasks.find((e) => e.id === id)!.irreversibleAnswered,
      ).toBe(true),
    );
    expect(
      f.manager.run("lead")!.tasks.find((e) => e.id === id)!.status,
    ).toBe("cancelled");
    expect(f.host.createWorker).not.toHaveBeenCalled();
  });
});

describe("a repaired verification", () => {
  /**
   * The original's `reruns_root` (`tests/test_dag_run_rules.py`, `test_a_repaired_verification_runs_again_before_the_run_is_done`):
   * a repair of the run's verify task fixes what it found, and only the verify task running again says the goal holds.
   * Accepting the repair must not settle the verification, and the verification must not stand in for itself.
   */
  it("runs again once its repair is accepted, and the run is not done until it passes", async () => {
    const f = fixture();
    await f.start();
    const verify = await f.delegate({ title: "Check", role: "verify", files: [] });
    await vi.waitFor(() => expect(f.host.createWorker).toHaveBeenCalledTimes(1));
    const session = f.manager.run("lead")!.tasks.find((e) => e.id === verify)!.sessionId;
    f.completions.get(session)!({ status: "failed", text: "", error: "2 tests red" });
    await vi.waitFor(() =>
      expect(f.manager.run("lead")!.tasks.find((e) => e.id === verify)!.status).toBe(
        "failed",
      ),
    );

    const repaired = (await f.call("repair", {
      taskId: verify,
      title: "Fix what the check found",
      prompt: "Fix it",
      files: ["src"],
    })) as { taskId: string };
    const created = f.manager.run("lead")!.tasks.find((e) => e.id === repaired.taskId)!;
    // A repair of a verification is a build task that fixes the work: the verification it repairs re-runs, so the
    // repair must not be a second verifier.
    expect(created.role).toBe("build");
    await vi.waitFor(() => expect(f.host.createWorker).toHaveBeenCalledTimes(2));

    await f.complete(repaired.taskId);
    await f.call("review", { taskId: repaired.taskId });
    // The verification is queued again, with a fresh turn, rather than the repair standing in for it. The pump may
    // pick it up before the assertion runs, so what is proved is the new turn's words, not a moment in the queue.
    await vi.waitFor(() => expect(f.host.submit).toHaveBeenCalledTimes(3));
    const secondTurn = f.host.submit.mock.calls[2][1] as string;
    expect(secondTurn).toContain("Check the goal again");
    expect(secondTurn).toContain("2 tests red");
    expect(
      f.manager.run("lead")!.tasks.find((e) => e.id === verify)!.accepted,
    ).toBe(false);

    // The re-run passes: now the verification is the run's one verify task, accepted.
    await f.complete(verify);
    const verdict = await f.call("review", { taskId: verify });
    expect(f.manager.run("lead")!.tasks.find((e) => e.id === verify)!.accepted).toBe(true);
    expect(verdict).toBeTruthy();
  });

  it("takes the second cycle of repairs, then the run stops asking for another", async () => {
    // The original's `test_a_failed_reverification_takes_the_second_cycle_then_the_run_stops`.
    const f = fixture();
    await f.start();
    const verify = await f.delegate({ title: "Check", role: "verify", files: [] });
    await vi.waitFor(() => expect(f.host.createWorker).toHaveBeenCalledTimes(1));
    const fail = async (id: string) => {
      const task = f.manager.run("lead")!.tasks.find((e) => e.id === id)!;
      await vi.waitFor(() => expect(f.completions.has(task.sessionId)).toBe(true));
      f.completions.get(task.sessionId)!({ status: "failed", text: "", error: "still red" });
      await vi.waitFor(() =>
        expect(f.manager.run("lead")!.tasks.find((e) => e.id === id)!.status).toBe(
          "failed",
        ),
      );
    };
    await fail(verify);
    const first = (await f.call("repair", {
      taskId: verify,
      title: "First fix",
      prompt: "Fix one",
      files: ["src"],
    })) as { taskId: string };
    await vi.waitFor(() => expect(f.completions.has(f.manager.run("lead")!.tasks.find((e) => e.id === first.taskId)!.sessionId)).toBe(true));
    await f.complete(first.taskId);
    await f.call("review", { taskId: first.taskId });
    const turns = f.host.submit.mock.calls.length;
    await vi.waitFor(() => expect(f.host.submit).toHaveBeenCalledTimes(turns + 1));

    // The re-run fails: that is the second cycle's repair.
    await fail(verify);
    const second = (await f.call("repair", {
      taskId: verify,
      title: "Second fix",
      prompt: "Fix two",
      files: ["src"],
    })) as { taskId: string; cycle: number };
    expect(second.cycle).toBe(2);
    await vi.waitFor(() => expect(f.completions.has(f.manager.run("lead")!.tasks.find((e) => e.id === second.taskId)!.sessionId)).toBe(true));
    await f.complete(second.taskId);
    await f.call("review", { taskId: second.taskId });
    const afterSecond = f.host.submit.mock.calls.length;
    await vi.waitFor(() => expect(f.host.submit).toHaveBeenCalledTimes(afterSecond + 1));

    // A third failure is the end: the run stops asking for another repair.
    await fail(verify);
    await expect(
      f.call("repair", {
        taskId: verify,
        title: "Third fix",
        prompt: "again",
        files: ["src"],
      }),
    ).rejects.toThrow("2 repair cycles");
  });
});

describe("the next worker's prompt", () => {
  it("names the handoff paths of the accepted tasks it waits on, never their text", async () => {
    const f = fixture();
    await f.start();
    const first = await f.delegate({ title: "First" });
    await f.delegate({ title: "Second", dependsOn: [first], files: ["docs"] });
    await vi.waitFor(() => expect(f.host.createWorker).toHaveBeenCalledTimes(1));
    await f.complete(first);
    await f.call("review", { taskId: first });
    const path = f.manager.run("lead")!.tasks.find((e) => e.id === first)!.handoff!.path;

    await vi.waitFor(() => expect(f.host.submit).toHaveBeenCalledTimes(2));
    const prompt = f.host.submit.mock.calls[1][1] as string;
    expect(prompt).toContain(path);
    expect(prompt).toContain("their claims are not proof");
    // The path only: the predecessor's own words are the lead's to read and weigh.
    expect(prompt).not.toContain("## Changed");
  });
});

describe("an extend round", () => {
  it("records the verify task that found the missing work, so the graph can draw the edge", async () => {
    const f = fixture();
    await f.start();
    const verify = await f.delegate({ title: "Check", role: "verify", files: [] });
    const added = (await f.call("delegate", {
      title: "One more",
      prompt: "Add the missing piece",
      harness: "codex",
      files: ["extra"],
      extend: true,
    })) as { taskId: string };
    const task = f.manager.run("lead")!.tasks.find((e) => e.id === added.taskId)!;
    expect(task.extendFrom).toBe(verify);
    expect(f.manager.run("lead")!.extends).toBe(1);
  });
});

describe("accepting a task", () => {
  it("refuses one whose handoff is missing, and records the one it read", async () => {
    const f = fixture();
    await f.start();
    const id = await f.delegate();
    await f.complete(id);

    f.goals.readHandoff = vi.fn(async () => {
      throw { reason: "handoff_missing", say: "No handoff file at .hivra/handoff/x.md." };
    });
    await expect(f.call("review", { taskId: id })).rejects.toThrow(
      "No handoff file at .hivra/handoff/x.md.",
    );

    f.goals.readHandoff = vi.fn(async (checkout: string, taskId: string) => ({
      path: `${checkout}/.hivra/handoff/${taskId}.md`,
      sha256: "a".repeat(64),
      bytes: 40,
      text: "## Changed\nok",
      headings: ["Changed"],
      missing: ["Files", "Checked", "Left"],
    }));
    const accepted = (await f.call("review", { taskId: id })) as {
      accepted: boolean;
      goal: { verdict: string };
    };
    expect(accepted.accepted).toBe(true);
    const task = f.manager.run("lead")!.tasks.find((e) => e.id === id)!;
    expect(task.handoff?.sha256).toBe("a".repeat(64));
    expect(task.handoff?.read).toBe(true);
    expect(accepted.goal.verdict).toBe("unverified");
  });

  it("records the handoff when the lead opens the result with get", async () => {
    const f = fixture();
    await f.start();
    const id = await f.delegate();
    await f.complete(id);
    const read = (await f.call("get", { taskId: id })) as {
      handoffText?: string;
      handoffProblem?: string;
    };
    expect(read.handoffText).toContain("## Changed");
    expect(read.handoffProblem).toBeUndefined();
    expect(f.manager.run("lead")!.tasks.find((e) => e.id === id)!.handoff?.read).toBe(
      true,
    );
  });
});

describe("a task's own check", () => {
  /** The real path: the worker's turn ends through `host.submit`'s callback, and the host's check runs on it. */
  const finishTurn = async (
    f: ReturnType<typeof fixture>,
    taskId: string,
    options: { text?: string } = {},
  ) => {
    const task = f.manager.run("lead")!.tasks.find((entry) => entry.id === taskId)!;
    await vi.waitFor(() => expect(f.completions.has(task.sessionId)).toBe(true));
    const done = f.completions.get(task.sessionId)!;
    // This turn's callback is spent: a later wait must see the next turn's submit, not this one.
    f.completions.delete(task.sessionId);
    done({ status: "completed", text: options.text ?? "Done" });
    await vi.waitFor(() =>
      expect(
        f.manager.run("lead")!.tasks.find((entry) => entry.id === taskId)!.status,
      ).toBe("completed"),
    );
  };

  it("carries WP-40's word onto the task, and a failed one keeps the card from saying Verified", async () => {
    const f = fixture();
    f.host.gateWorker = vi.fn(async () => "failed" as const);
    await f.start();
    const id = await f.delegate();
    await finishTurn(f, id);

    // The word is WP-40's own, read from the check on this worker's copy, and it is on the record.
    expect(f.host.gateWorker).toHaveBeenCalledTimes(1);
    expect(
      f.manager.run("lead")!.tasks.find((entry) => entry.id === id)!.gateOutcome,
    ).toBe("failed");

    // A gate that failed is the run's own failure. The rules are asked again after the acceptance, and the word they
    // read is the one the check left: the report cannot say Verified, and names the task whose gate failed.
    const asked = f.goals.report.mock.calls.map(([run]) => run as GoalRunView);
    expect(asked.length).toBeGreaterThan(0);
    expect(
      asked[asked.length - 1].nodes.find((node) => node.id === id)!.gateOutcome,
    ).toBe("failed");
    const view = goalRunView(f.manager.run("lead")!);
    expect(view.nodes.find((node) => node.id === id)!.gateOutcome).toBe("failed");
    expect(f.manager.run("lead")!.goalReport?.verdict).not.toBe("verified");
  });

  it("reads a check that could not run as notRun, never as a pass or as no gate", async () => {
    const f = fixture();
    // The runner threw: the check exists but could not run.
    f.host.gateWorker = vi.fn(async () => {
      throw new Error("the checkout is gone");
    });
    await f.start();
    const id = await f.delegate();
    await finishTurn(f, id);
    expect(
      f.manager.run("lead")!.tasks.find((entry) => entry.id === id)!.gateOutcome,
    ).toBe("notRun");

    // A retry clears it: the word was about the turn that ran, and the fresh turn is checked again when it ends. A
    // project with no check then records no word at all, rather than inheriting the old one.
    await f.call("retry", { taskId: id, text: "Do it again", files: ["src/a"] });
    expect(
      f.manager.run("lead")!.tasks.find((entry) => entry.id === id)!.gateOutcome,
    ).toBeUndefined();
    f.host.gateWorker = vi.fn(async () => null);
    await finishTurn(f, id);
    expect(
      f.manager.run("lead")!.tasks.find((entry) => entry.id === id)!.gateOutcome,
    ).toBeUndefined();
  });

  it("leaves a failed turn's word alone rather than checking a turn that did not finish", async () => {
    const f = fixture();
    f.host.gateWorker = vi.fn(async () => "passed" as const);
    await f.start();
    const id = await f.delegate();
    const task = f.manager.run("lead")!.tasks.find((entry) => entry.id === id)!;
    await vi.waitFor(() => expect(f.completions.has(task.sessionId)).toBe(true));
    f.completions.get(task.sessionId)!({
      status: "failed",
      text: "",
      error: "boom",
    });
    await vi.waitFor(() =>
      expect(
        f.manager.run("lead")!.tasks.find((entry) => entry.id === id)!.status,
      ).toBe("failed"),
    );
    expect(f.host.gateWorker).not.toHaveBeenCalled();
    expect(
      f.manager.run("lead")!.tasks.find((entry) => entry.id === id)!.gateOutcome,
    ).toBeUndefined();
  });
});

describe("finishing a run", () => {
  const proposal = () => ({
    version: 1 as const,
    leadId: "lead",
    cwd: "/repo",
    request: "Build it",
    author: { harness: "claude" as const, model: "claude:test", name: "Lead" },
    settings: {
      choices: [{ harness: "codex" as const, model: "codex:test", name: "Test" }],
      maxWorkers: 2,
    },
    status: "ready" as const,
    title: "Settings",
    summary: "Split the work",
    goal: "The settings screen saves",
    check: { command: "npm test", expectExit: 0 },
    tasks: [
      {
        id: "build",
        title: "Build",
        prompt: "Build it",
        harness: "codex" as const,
        model: "codex:test",
        files: ["src"],
        dependsOn: [],
      },
      {
        id: "verify",
        title: "Check",
        prompt: "Check it",
        harness: "codex" as const,
        model: "codex:test",
        role: "verify" as const,
        files: [],
        dependsOn: ["build"],
      },
    ],
  });

  it("refuses to start on a finish line that could not run, in plain words", async () => {
    const f = fixture();
    f.goals.runCheck = vi.fn(async () => ({
      outcome: "notRun" as const,
      output: "the command could not start",
      layer: "app",
      at: 1,
    }));
    (f.host.session("lead") as { busy: boolean }).busy = false;
    await expect(
      f.manager.startApproved("lead", "card", proposal()),
    ).rejects.toThrow(
      "The finish-line check could not run, so the run has no finish line: the command could not start",
    );
    // Nothing was queued or started without a proven red baseline.
    expect(f.host.submit).not.toHaveBeenCalled();
    expect(f.manager.run("lead")).toBeUndefined();
  });

  it("runs the check itself and refuses while the goal is not proved", async () => {
    const f = fixture();
    (f.host.session("lead") as { busy: boolean }).busy = false;
    const started = proposal();
    await f.manager.startApproved("lead", "card", started);
    // The finish line failed on the untouched base, and that is the baseline.
    expect(f.manager.run("lead")?.baseline?.outcome).toBe("failed");
    const [build, check] = f.manager.run("lead")!.tasks;
    await vi.waitFor(() => expect(f.host.submit).toHaveBeenCalledTimes(2));

    await f.complete(build.id);
    await f.call("review", { taskId: build.id });
    await f.complete(check.id);
    await f.call("review", { taskId: check.id });

    // The rules still say unverified, so finish refuses and names why.
    f.goals.report = vi.fn(async () => ({
      report: {
        goal: "The settings screen saves",
        verdict: "unverified" as const,
        reasons: ["check_not_run"],
        layers: [],
        criticalPath: [],
        bottlenecks: [],
        lint: [],
        ready: [],
        cyclesLeft: {},
        replan: [],
        extendsLeft: 2,
      },
    }));
    await expect(f.call("finish")).rejects.toThrow("The goal is not proved yet");
    await expect(f.call("finish")).rejects.toThrow(
      "the finish-line check has not run, or could not",
    );

    f.goals.report = vi.fn(async () => ({
      report: {
        goal: "The settings screen saves",
        verdict: "verified" as const,
        reasons: [],
        layers: [],
        criticalPath: [],
        bottlenecks: [],
        lint: [],
        ready: [],
        cyclesLeft: {},
        replan: [],
        extendsLeft: 2,
      },
    }));
    expect(await f.call("finish")).toMatchObject({ finished: true });
    // The app ran the check itself, in the lead's checkout, and the record says which layer did.
    expect(f.goals.runCheck).toHaveBeenCalled();
    expect(
      f.manager.run("lead")?.checkRuns?.some((entry) => entry.layer === "app"),
    ).toBe(true);
  });
});

describe("the decision an irreversible step raises", () => {
  it("names its project when it has one, and keeps its stable key and its two answers", () => {
    const input = decisionAskInput({
      leadId: "lead",
      taskId: "t1",
      title: "Migrate",
      reason: "it migrates the shared database",
      project: "hivra",
    });
    expect(input).toMatchObject({
      askedBy: "lead",
      project: "hivra",
      key: irreversibleDecisionKey("lead", "t1"),
      options: ["Approve", "Send back"],
      recommended: "Send back",
    });
    expect(input.question).toContain("Migrate cannot be undone");
    expect(input.question).toContain("it migrates the shared database");
  });

  it("leaves the project out rather than send an empty one", () => {
    for (const project of ["", "   ", undefined]) {
      const input = decisionAskInput({
        leadId: "lead",
        taskId: "t1",
        title: "Migrate",
        reason: "it spends money",
        project,
      });
      expect("project" in input).toBe(false);
    }
  });
});

describe("watching for answered decisions", () => {
  it("calls back for every event, and stops for good once it is stopped", async () => {
    let handler: (() => void) | undefined;
    const off = vi.fn();
    const seen = vi.fn();
    const stop = watchDecisions(async (_event, next) => {
      handler = next;
      return off;
    }, seen);
    await vi.waitFor(() => expect(handler).toBeDefined());
    handler!();
    handler!();
    expect(seen).toHaveBeenCalledTimes(2);
    stop();
    expect(off).toHaveBeenCalledOnce();
    handler!();
    expect(seen).toHaveBeenCalledTimes(2);
    stop();
    expect(off).toHaveBeenCalledOnce();
  });

  it("is stopped even before the listener is ready, and survives a listener that cannot start", async () => {
    let ready!: (off: () => void) => void;
    const off = vi.fn();
    const stop = watchDecisions(
      () => new Promise<() => void>((resolve) => (ready = resolve)),
      vi.fn(),
    );
    stop();
    ready(off);
    await vi.waitFor(() => expect(off).toHaveBeenCalledOnce());
    // Outside the app there is no event bus: nothing to watch, nothing to throw.
    const none = watchDecisions(async () => {
      throw new Error("no tauri");
    }, vi.fn());
    await Promise.resolve();
    expect(() => none()).not.toThrow();
  });

  it("does not let one failing callback end the watch", async () => {
    let handler!: () => void;
    const seen = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockImplementation(() => {});
    watchDecisions(async (_event, next) => {
      handler = next;
      return () => {};
    }, seen);
    await vi.waitFor(() => expect(handler).toBeDefined());
    expect(() => handler()).not.toThrow();
    handler();
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
