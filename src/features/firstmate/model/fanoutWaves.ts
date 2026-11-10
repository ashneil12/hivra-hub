// Hivra WP-171: the order a contract puts on a fan-out.
//
// A task that requires X depends on the task that provides X. A worker started at the same time as its provider waits
// for a file that does not exist yet, so a fan-out runs in waves: the tasks nothing is needed for start together, and
// each later task waits until what it needs has been delivered and checked. Tasks are never started in bulk past the
// first mate's cap (parseFanout allows eight in all, and every start still goes through `check_fanout`).
//
// The wave planner and the cycle fallback are translated from Atomic Agent's src/tools/fusion/contract-waves.ts (MIT,
// Copyright (c) 2026 Atomic Bot, commit 1b4e641525c5b1427b48ff6b8d9932dc26bd8256): wave one is every task with no
// unmet dependency, each later wave the tasks whose dependencies are all done, and a cycle is one wave in the order
// given, with a warning. Changed for Hivra:
// - A task does not wait for its whole wave, only for the tasks that provide what it requires.
// - A provider that failed or was stopped HOLDS what waits for it (Atomic runs the dependent anyway and warns); the first
//   mate hears what landed and what did not, and decides. A hold is worked out from the rows each time it is asked,
//   never remembered, so a task that is redone or a row that arrives late settles it.
// - Delivered means the provider's row is done (its gates passed), its declared checks passed, and what it was to
//   provide is on disk (fanoutChecks.ts). Anything missing, or not run, is not delivered.
import type { Delegation } from "../../monos/model/delegations";
import {
  FANOUT_MAX_TASKS,
  PROVIDE_KINDS,
  dependenciesOf,
  describeCycleWarning,
  projectPath,
  renderContractBlock,
  renderContractForTask,
  requiresCycle,
  type Contract,
  type ParsedFanout,
} from "./fanoutContract";

export type WavePlan = {
  /** Task names, wave by wave; each wave in the order the tasks were given. */
  waves: string[][];
  /** Task name to the providers it waits for. Empty when the requires cannot be ordered. */
  after: Record<string, string[]>;
  /** The warning when the requires form a cycle: the plan is then one wave and orders nothing. */
  cycle?: string;
};

export function planWaves(taskNames: readonly string[], contract: Pick<Contract, "provides" | "requires">): WavePlan {
  const cycle = requiresCycle(taskNames, contract);
  if (cycle) return { waves: [[...taskNames]], after: {}, cycle: describeCycleWarning(cycle) };
  const dependencies = dependenciesOf(taskNames, contract);
  const waves: string[][] = [];
  const placed = new Set<string>();
  let remaining = [...taskNames];
  while (remaining.length) {
    const wave = remaining.filter((name) => (dependencies.get(name) ?? []).every((dep) => placed.has(dep)));
    waves.push(wave);
    for (const name of wave) placed.add(name);
    remaining = remaining.filter((name) => !placed.has(name));
  }
  return { waves, after: Object.fromEntries(dependencies) };
}

/** What each task of a fan-out carries in its own `tasks.delegate` input, so it can wait, start and be briefed alone. */
export type FanoutLink = {
  /** The delegate_tasks call's request id. */
  plan: string;
  name: string;
  /** 1 for what starts at once, 2 for what needs wave 1, and so on. */
  wave: number;
  /** The tasks whose delivery it waits for. */
  after: string[];
  /** Every task of the plan: its worker chat's id, and its title. */
  tasks: Record<string, { session: string; title: string }>;
  contract: Contract;
  warnings: string[];
  /** When the plan was sent (epoch ms): a provider this app cannot find yet is only late to show for a moment after. */
  at: number;
};

/** How long after a plan was sent a provider that cannot be found is read as late to appear, not as gone. */
export const NEW_PLAN_GRACE_MS = 60_000;

/** A task's own request id inside a fan-out: the call's, then the task's name, within the 100 characters a request id may have. */
export function taskRequestId(requestId: string, name: string): string {
  return `${requestId.slice(0, 100 - name.length - 1)}-${name}`;
}

export type PlannedFanout = {
  /** One link per task, in the order the tasks were given. */
  links: FanoutLink[];
  waves: string[][];
  warnings: string[];
};

/** The waves and every task's link for a checked fan-out sent by `owner` as `requestId`. */
export function planFanout(parsed: ParsedFanout, owner: string, requestId: string, now: number = Date.now()): PlannedFanout {
  const names = parsed.tasks.map((task) => task.name);
  const plan = planWaves(names, parsed.contract);
  const warnings = [...parsed.warnings];
  const tasks = Object.fromEntries(
    parsed.tasks.map((task) => [
      task.name,
      { session: `app-${owner}-${taskRequestId(requestId, task.name)}`, title: task.title ?? task.name },
    ]),
  );
  const links = parsed.tasks.map((task): FanoutLink => ({
    plan: requestId,
    name: task.name,
    wave: plan.waves.findIndex((wave) => wave.includes(task.name)) + 1,
    after: plan.after[task.name] ?? [],
    tasks,
    contract: parsed.contract,
    warnings,
    at: now,
  }));
  return { links, waves: plan.waves, warnings };
}

/** The brief's contract section for one task: who it is in the plan, the shared block, and its own three lines. */
export function fanoutSection(link: FanoutLink): string {
  const count = Object.keys(link.tasks).length;
  return [
    `You are task "${link.name}" of a fan-out of ${count} ${count === 1 ? "task" : "tasks"}, in wave ${link.wave}.${link.after.length ? ` What you waited for has been delivered and checked: ${link.after.join(", ")}.` : ""}`,
    renderContractBlock(link.contract, link.warnings),
    `For task ${link.name}:`,
    renderContractForTask(link.contract, link.name),
  ].join("\n");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): string => {
  if (typeof value !== "string" || !value || value.length > max) throw new Error("a text is missing or too long");
  return value;
};

/** A stored link, checked again: it came back from a queue and a control request, and nothing there is trusted. */
export function parseFanoutLink(value: unknown): FanoutLink {
  try {
    if (!isRecord(value)) throw new Error("it is not an object");
    const tasksIn = isRecord(value.tasks) ? value.tasks : undefined;
    if (!tasksIn || !Object.keys(tasksIn).length || Object.keys(tasksIn).length > FANOUT_MAX_TASKS) throw new Error("tasks");
    const tasks: FanoutLink["tasks"] = {};
    for (const [name, ref] of Object.entries(tasksIn)) {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(name) || !isRecord(ref)) throw new Error("a task");
      tasks[name] = { session: text(ref.session, 300), title: text(ref.title, 200) };
    }
    const known = (name: unknown): string => {
      if (typeof name !== "string" || !(name in tasks)) throw new Error("a name outside the plan");
      return name;
    };
    const wave = value.wave;
    if (typeof wave !== "number" || !Number.isInteger(wave) || wave < 1 || wave > FANOUT_MAX_TASKS) throw new Error("wave");
    if (!Array.isArray(value.after) || value.after.length > FANOUT_MAX_TASKS) throw new Error("after");
    if (!Array.isArray(value.warnings) || value.warnings.length > 8) throw new Error("warnings");
    return {
      plan: text(value.plan, 100),
      name: known(value.name),
      wave,
      after: [...new Set((value.after as unknown[]).map(known))],
      tasks,
      contract: readContract(value.contract, known),
      warnings: (value.warnings as unknown[]).map((warning) => text(warning, 400)),
      at: typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0,
    };
  } catch (error) {
    throw new Error(`This fan-out link is not valid (${error instanceof Error ? error.message : String(error)}).`);
  }
}

function readContract(value: unknown, known: (name: unknown) => string): Contract {
  if (!isRecord(value)) throw new Error("contract");
  const list = (entry: unknown, max: number): Record<string, unknown>[] => {
    if (!Array.isArray(entry) || entry.length > max || !entry.every(isRecord)) throw new Error("contract list");
    return entry as Record<string, unknown>[];
  };
  const owners = isRecord(value.owners) ? value.owners : undefined;
  const files = isRecord(value.files) ? value.files : undefined;
  if (!owners || !files) throw new Error("contract owners");
  // A stored link is untrusted: owners, file names and `in` go through the same path rule as a new plan. A provide
  // name is a path only when it names a file. An endpoint like /api/score is a name, not a path.
  const owned: Record<string, string> = {};
  for (const [path, owner] of Object.entries(owners)) {
    const clean = projectPath(path);
    if (Object.hasOwn(owned, clean)) throw new Error("a path twice");
    owned[clean] = known(owner);
  }
  return {
    owners: owned,
    provides: list(value.provides, 64).map((entry) => {
      const kind = entry.kind;
      if (typeof kind !== "string" || !(PROVIDE_KINDS as readonly string[]).includes(kind)) throw new Error("provide kind");
      return {
        task: known(entry.task),
        kind: kind as (typeof PROVIDE_KINDS)[number],
        name: kind === "file" ? projectPath(entry.name) : text(entry.name, 400),
        ...(entry.in === undefined ? {} : { in: projectPath(entry.in) }),
        ...(entry.shape === undefined ? {} : { shape: text(entry.shape, 400) }),
      };
    }),
    requires: list(value.requires, 64 * FANOUT_MAX_TASKS).map((entry) => ({ task: known(entry.task), name: text(entry.name, 400) })),
    checks: list(value.checks, 20 * FANOUT_MAX_TASKS).map((entry) => ({ task: known(entry.task), id: text(entry.id, 60) })),
    files: Object.fromEntries(
      Object.entries(files).map(([task, paths]) => {
        if (!Array.isArray(paths) || paths.length > 30) throw new Error("contract files");
        const clean: string[] = [];
        for (const path of paths) {
          const next = projectPath(path);
          if (!clean.includes(next)) clean.push(next);
        }
        return [known(task), clean];
      }),
    ),
  };
}

/** The part of a delegation row the hold reads. */
export type RowView = Pick<Delegation, "state"> &
  Partial<Pick<Delegation, "error" | "status" | "gateVerdict" | "version" | "updatedAt">>;

/** What the check of a finished provider found on disk (fanoutChecks.ts). */
export type Verification = { ok: boolean; problems: string[] };

/** What the app knows about the tasks of a fan-out right now. Synchronous: the app refreshes what it reads before it asks. */
export type DependencyLookup = {
  /** The row of a task's worker chat, once it started. */
  row(session: string): RowView | undefined;
  /** A task that has not started: it waits in the worker queue. */
  queued(session: string): boolean;
  /** The check of what a finished provider made, once it ran for this version of its row. */
  verified(session: string, row: RowView): Verification | undefined;
};

/** Why a task waits for what it needs: still on its way, or held for the first mate to decide. */
export type DependencyWait = { reason: "requires" | "held"; line: string };

type Outcome =
  | { state: "delivered" }
  | { state: "waiting"; detail: string }
  /** `say` is the sentence, led by the task: "a failed: the build broke". */
  | { state: "failed"; say: string };

function listed(names: readonly string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function oneLine(value: string, max = 160): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * What a provider's row says on its own, before anything on disk is looked at: still on its way, failed, or finished
 * and passed. Undefined means the row is done and its declared checks passed, so only what it made is left to check.
 */
function rowOutcome(link: FanoutLink, name: string, row: RowView): Outcome | undefined {
  if (row.state === "running" || row.state === "question") return { state: "waiting", detail: `${name} is still working` };
  if (row.state === "cancelled") return { state: "failed", say: `${name} was stopped` };
  if (row.state === "failed") return { state: "failed", say: `${name} failed: ${oneLine(row.error || "it did not finish")}` };
  // Finished. Its gates decide whether it is done; a row from before statuses existed is read from its gate verdict.
  if (row.status === "failed" || (!row.status && row.gateVerdict === "failed"))
    return { state: "failed", say: `${name} finished but its checks failed` };
  if (row.status && row.status !== "done")
    return { state: "waiting", detail: `${name}'s checks are still being decided${row.status === "needs-you" ? " (task_accept)" : ""}` };
  if (!row.status && row.gateVerdict && row.gateVerdict !== "passed") return { state: "waiting", detail: `${name}'s checks are still being decided` };
  const declared = link.contract.checks.filter((check) => check.task === name).map((check) => check.id);
  if (declared.length && row.gateVerdict !== "passed") {
    return {
      state: "failed",
      say: `${name} finished, but its declared ${declared.length === 1 ? "check" : "checks"} (${declared.join(", ")}) did not run or have not passed, and a check that did not run is not a pass`,
    };
  }
  return undefined;
}

/** Whether a provider's row is done and passed, so what it made on disk is the next thing to check (fanoutChecks.ts). */
export function awaitsVerification(link: FanoutLink, name: string, row: RowView | undefined): boolean {
  return row !== undefined && rowOutcome(link, name, row) === undefined;
}

function outcomeOf(link: FanoutLink, name: string, lookup: DependencyLookup, now: number): Outcome {
  const session = link.tasks[name].session;
  const row = lookup.row(session);
  if (!row) {
    if (lookup.queued(session)) return { state: "waiting", detail: `${name} has not started yet` };
    // Just after the plan went out, a provider the app has started may not show in its rows yet.
    if (now - link.at < NEW_PLAN_GRACE_MS) return { state: "waiting", detail: `looking for ${name}'s task` };
    return { state: "failed", say: `can't find ${name}, so nothing is known about it (it may have been stopped)` };
  }
  const early = rowOutcome(link, name, row);
  if (early) return early;
  // A provider in `after` always provides something (a requirement names a provide), so there is always something to look for.
  const verified = lookup.verified(session, row);
  if (!verified) return { state: "waiting", detail: `checking what ${name} provided` };
  if (!verified.ok) return { state: "failed", say: `${name} is done but ${listed(verified.problems.map((problem) => oneLine(problem, 120)))}` };
  return { state: "delivered" };
}

/**
 * Whether this task can start now, from the rows. Ready (undefined) only when every provider is delivered. A provider
 * that failed, was stopped, cannot be found or did not deliver HOLDS it, and the line says what landed, what did not
 * start and what to do. Otherwise it waits.
 */
export function dependencyVerdict(link: FanoutLink, lookup: DependencyLookup, now: number = Date.now()): DependencyWait | undefined {
  if (!link.after.length) return undefined;
  const outcomes = link.after.map((name) => ({ name, outcome: outcomeOf(link, name, lookup, now) }));
  const failed = outcomes.find((entry) => entry.outcome.state === "failed");
  if (failed && failed.outcome.state === "failed") {
    const others = Object.keys(link.tasks).map((name) => ({ name, outcome: outcomeOf(link, name, lookup, now) }));
    const landed = others.filter((entry) => entry.outcome.state === "delivered").map((entry) => entry.name);
    const notStarted = Object.keys(link.tasks).filter((name) => !lookup.row(link.tasks[name].session));
    return {
      reason: "held",
      line: `Held: ${failed.outcome.say}. Done and checked: ${landed.length ? listed(landed) : "nothing yet"}. Not started: ${notStarted.length ? listed(notStarted) : "none"}. Cancel each held task with task_cancel (its childSessionId), then send them again once ${failed.name} is redone.`,
    };
  }
  const waiting = outcomes.flatMap((entry) => (entry.outcome.state === "waiting" ? [{ name: entry.name, detail: entry.outcome.detail }] : []));
  if (!waiting.length) return undefined;
  const why = waiting.length === 1 ? ` (${waiting[0].detail})` : "";
  return {
    reason: "requires",
    line: `Waiting for ${listed(waiting.map((entry) => entry.name))} to finish and be checked${why}. It starts by itself then.`,
  };
}
