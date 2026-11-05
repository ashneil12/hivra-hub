/**
 * WP-91: the goal and its finish line are values from a model, so they are untrusted until they are checked here, and
 * everything the Rust side sends back is checked again before it reaches the record or the screen.
 */
import { describe, expect, it, vi } from "vitest";
import {
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
        checks: ["web"],
        timeoutSeconds: 900,
      }),
    ).toEqual({
      command: "npm test",
      expectExit: 1,
      expectText: "0 failing",
      checks: ["web"],
      timeoutSeconds: 900,
    });
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
      validateGoalCheck({
        command: "x",
        checks: Array.from({ length: 21 }, (_, index) => `c${index}`),
      }),
    ).toThrow();
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
    // A gate that failed, or could not run, is not a pass.
    expect(view.nodes[3].gatesPassed).toBe(false);
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

describe("finishing a run", () => {
  it("runs the check itself and refuses while the goal is not proved", async () => {
    const f = fixture();
    const proposal = {
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
    };
    (f.host.session("lead") as { busy: boolean }).busy = false;
    await f.manager.startApproved("lead", "card", proposal);
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
