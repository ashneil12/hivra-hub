/**
 * WP-91: the seam to the goal graph's rules. Every rule lives once, in Rust
 * (`src-tauri/src/goal_graph/`): the graph's topology, the write scopes two tasks may not share at once, the repair
 * caps, the run verdict and the app's own run of the finish line. This module only shapes the call and holds what
 * the webview stores on the run.
 *
 * The record itself stays where it already is — `orchestration.ts`'s run — so there is no second scheduler and no
 * second idea of "done".
 */
import { invoke } from "@tauri-apps/api/core";

/** One line the person reads: the goal a run is for. */
export const GOAL_MAX = 240;
/** Repair cycles per failed task, and which of them is the re-plan. The rules themselves live in Rust
 * (`goal_graph::record`); these mirror them only so the lead can be told what is left before it asks. */
export const MAX_REPAIR_CYCLES = 2;
export const REPLAN_CYCLE = 2;
/** Extend rounds per run, for a re-plan that adds nodes rather than replacing one. */
export const MAX_EXTEND_ROUNDS = 2;
/** The finish line: a command that fails until the goal holds. */
export const CHECK_COMMAND_MAX = 1_000;
export const CHECK_TEXT_MAX = 200;

/** The finish line stored on a run and shown on its card. */
export type GoalCheck = {
  command: string;
  /** The exit code that counts as met; the project's own checks use 0. */
  expectExit: number;
  /** Text the output must hold, when the exit code alone is not the whole finish line. */
  expectText?: string;
  timeoutSeconds?: number;
};

/** How one run of the finish-line check ended. `notRun` is a timeout or a command that could not start: never a pass
 * and never a final failure. */
export type GoalCheckRun = {
  outcome: "passed" | "failed" | "notRun";
  exitCode?: number;
  /** The end of what it printed, capped, with one plain line saying why the outcome is what it is. */
  output: string;
  /** Which layer ran it: the app, a worker, or the delivery gate (WP-81). Recorded once per command. */
  layer: string;
  at: number;
};

/** A worker's handoff file, recorded on the task it belongs to. */
export type TaskHandoff = {
  /** The canonical path, proved to be inside the worker's checkout. */
  path: string;
  sha256: string;
  bytes: number;
  /** The lead opened it before accepting. */
  read: boolean;
  at: number;
};

/** A handoff read back from disk. */
export type HandoffFile = {
  path: string;
  sha256: string;
  bytes: number;
  text: string;
  headings: string[];
  missing: string[];
};

/** A rule refused: the reason code and one plain sentence. */
export type GoalRefusal = { reason: string; say: string };

export type GoalNodeReport = {
  goal: string;
  verdict: "verified" | "failed" | "unverified";
  reasons: string[];
  layers: string[][];
  criticalPath: string[];
  bottlenecks: { node: string; blocks: number }[];
  lint: string[];
  ready: string[];
  cyclesLeft: Record<string, number>;
  replan: string[];
  extendsLeft: number;
  verify?: string;
};

export type GoalAnswer = { refusal?: GoalRefusal; report: GoalNodeReport };

/** What a plan's graph check answers when it holds. */
export type GoalPlanAnswer = {
  verify: string;
  layers: string[][];
  criticalPath: string[];
  bottlenecks: { node: string; blocks: number }[];
  lint: string[];
};

/** One task of a proposal, as the graph rules read it. */
export type GoalPlanNode = {
  id: string;
  title: string;
  role: "build" | "verify";
  dependsOn: string[];
  /** The proposal's `files`, already project-relative (see `validateProposedTasks`). */
  writeScope: string[];
};

/** A repair task offered to the run, as the rules read it: a node with the task it repairs. */
export type GoalRepairNode = {
  id: string;
  title: string;
  role: "build" | "verify";
  dependsOn: string[];
  writeScope: string[];
  repairs: string;
};

/** One node of the run, as the rules read it. */
export type GoalRunNode = {
  id: string;
  title: string;
  role: "build" | "verify";
  dependsOn: string[];
  writeScope: string[];
  accepted: boolean;
  /** WP-40's word on the task's own gates: `passed`, `failed`, `notRun` or `held`. Absent means no gate ran, which
   * is not a pass. The rules read the word itself, never a boolean. */
  gateOutcome?: string;
  failed: boolean;
  cancelled: boolean;
  handoff?: TaskHandoff;
  repairs?: string;
  irreversible?: { reason: string; key: string; answered: boolean };
};

/** The run, as the rules read it. */
export type GoalRunView = {
  goal: string;
  nodes: GoalRunNode[];
  baseline?: GoalCheckRun;
  latest?: GoalCheckRun;
  repairs: Record<string, string[][]>;
  extends: number;
};

/** The Rust side of the goal graph, so a test can stand in for it. */
export type GoalGraphBackend = {
  checkPlan(nodes: GoalPlanNode[]): Promise<GoalPlanAnswer>;
  checkRepair(run: GoalRunView, node: GoalRepairNode): Promise<void>;
  report(run: GoalRunView): Promise<GoalAnswer>;
  runCheck(cwd: string, spec: GoalCheck): Promise<GoalCheckRun>;
  readHandoff(checkout: string, taskId: string): Promise<HandoffFile>;
};

/** Everything the Rust side sends back is untrusted until it is checked here: it crosses a process boundary and is
 * read from a database a second window may have written. */
const word = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;
const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const rows = (value: unknown): string[][] =>
  Array.isArray(value) ? value.map((row) => list(row)) : [];

function checkOutcome(value: unknown): GoalCheckRun["outcome"] {
  return value === "passed" || value === "failed" ? value : "notRun";
}

export function normalizeCheckRun(value: unknown): GoalCheckRun | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  return {
    outcome: checkOutcome(input.outcome),
    ...(typeof input.exitCode === "number" ? { exitCode: input.exitCode } : {}),
    output: word(input.output, ""),
    layer: word(input.layer, "app"),
    at: typeof input.at === "number" ? input.at : 0,
  };
}

/** A saved finish-line check, from a run read back out of the database: a partial or older value becomes `undefined`
 * rather than a check the card draws wrongly. */
export function normalizeGoalCheck(value: unknown): GoalCheck | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.command !== "string" || !input.command.trim()) return undefined;
  return {
    command: input.command,
    expectExit: typeof input.expectExit === "number" ? input.expectExit : 0,
    ...(typeof input.expectText === "string" ? { expectText: input.expectText } : {}),
    ...(typeof input.timeoutSeconds === "number" ? { timeoutSeconds: input.timeoutSeconds } : {}),
  };
}

/** A saved goal report, read back out of the database, in the shape the card needs. Anything malformed becomes an
 * empty report, so a truncated row draws the run without the goal instead of crashing the card. */
export function normalizeGoalReport(value: unknown): GoalNodeReport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return normalizeReport(value);
}

function normalizeReport(value: unknown): GoalNodeReport {
  const report =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const verdict =
    report.verdict === "verified" || report.verdict === "failed"
      ? report.verdict
      : "unverified";
  const cycles =
    report.cyclesLeft && typeof report.cyclesLeft === "object" && !Array.isArray(report.cyclesLeft)
      ? Object.fromEntries(
          Object.entries(report.cyclesLeft as Record<string, unknown>).filter(
            (entry): entry is [string, number] => typeof entry[1] === "number",
          ),
        )
      : {};
  return {
    goal: word(report.goal, ""),
    verdict,
    reasons: list(report.reasons),
    layers: rows(report.layers),
    criticalPath: list(report.criticalPath),
    bottlenecks: (Array.isArray(report.bottlenecks) ? report.bottlenecks : []).flatMap(
      (entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const item = entry as Record<string, unknown>;
        return typeof item.node === "string"
          ? [{ node: item.node, blocks: typeof item.blocks === "number" ? item.blocks : 0 }]
          : [];
      },
    ),
    lint: list(report.lint),
    ready: list(report.ready),
    cyclesLeft: cycles,
    replan: list(report.replan),
    extendsLeft: typeof report.extendsLeft === "number" ? report.extendsLeft : 0,
    ...(typeof report.verify === "string" ? { verify: report.verify } : {}),
  };
}

export function normalizeGoalAnswer(value: unknown): GoalAnswer {
  const input =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const raw = input.refusal;
  const refusal =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? {
          reason: word((raw as Record<string, unknown>).reason, "refused"),
          say: word((raw as Record<string, unknown>).say, "The graph was refused."),
        }
      : undefined;
  return {
    ...(refusal ? { refusal } : {}),
    report: normalizeReport(input.report),
  };
}

export function normalizePlanAnswer(value: unknown): GoalPlanAnswer {
  const input =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    verify: word(input.verify, ""),
    layers: rows(input.layers),
    criticalPath: list(input.criticalPath),
    bottlenecks: (Array.isArray(input.bottlenecks) ? input.bottlenecks : []).flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const item = entry as Record<string, unknown>;
      return typeof item.node === "string"
        ? [{ node: item.node, blocks: typeof item.blocks === "number" ? item.blocks : 0 }]
        : [];
    }),
    lint: list(input.lint),
  };
}

/** A refusal that crossed the boundary, as a plain Error, so callers keep one shape. */
export function refusalMessage(error: unknown): string {
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const say = (error as Record<string, unknown>).say;
    if (typeof say === "string" && say.trim()) return say;
  }
  return error instanceof Error ? error.message : String(error);
}

/** A refusal that crossed the boundary, kept as its reason code and its one plain sentence. */
export function refusalOf(
  error: unknown,
): { code: string; message: string } | undefined {
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const input = error as Record<string, unknown>;
  const say = typeof input.say === "string" ? input.say.trim() : "";
  if (!say) return undefined;
  return {
    code: typeof input.reason === "string" ? input.reason : "refused",
    message: say,
  };
}

export const goalGraphBackend: GoalGraphBackend = {
  checkPlan: async (nodes) => normalizePlanAnswer(await invoke("goal_graph_check_plan", { nodes })),
  checkRepair: async (run, node) => {
    await invoke("goal_graph_check_repair", { run, node });
  },
  report: async (run) =>
    normalizeGoalAnswer(await invoke("goal_graph_report", { run })),
  runCheck: async (cwd, spec) =>
    normalizeCheckRun(await invoke("goal_graph_run_check", { cwd, spec })) ?? {
      outcome: "notRun",
      output: "The finish-line check answered nothing.",
      layer: "app",
      at: Date.now(),
    },
  readHandoff: async (checkout, taskId) =>
    await invoke<HandoffFile>("goal_graph_read_handoff", { checkout, taskId }),
};

/** What the run's card and the graph show about the check. */
export function goalCheckLine(check: GoalCheck | undefined): string {
  if (!check) return "No finish-line check was recorded for this run.";
  const suffix = check.expectText ? `, printing ${JSON.stringify(check.expectText)}` : "";
  return `${check.command} (exit ${check.expectExit}${suffix})`;
}
