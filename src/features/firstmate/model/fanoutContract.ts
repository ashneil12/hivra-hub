// Hivra WP-171: the contract between the parts of one fan-out.
//
// Workers never see each other, so two parts of one job can each be consistent and still disagree: one writes a
// symbol as a class and its sibling calls it as an object. A contract writes down, once and in plain terms, who owns
// which path, what each task must produce, what a task may rely on from the others, and which project checks a task
// has to pass. Every worker's brief carries it (`renderBrief`), and the app checks it when a provider finishes
// (fanoutChecks.ts).
//
// Translated to TypeScript from Atomic Agent (https://github.com/AtomicBot-ai/atomic-agent, MIT, Copyright (c) 2026
// Atomic Bot) at commit 1b4e641525c5b1427b48ff6b8d9932dc26bd8256: src/tools/fusion/contract.ts (the kinds of thing a
// task provides, describeProvide, the rule for where a provide is looked for, the contract block and the per-task
// lines) and src/tools/fusion/contract-waves.ts (the walk that names a requires cycle).
// Changed for Hivra:
// - The contract is read from `delegate_tasks` (each task lists its own owns, provides, requires and checks) instead of
//   one call-level object, so no model has to repeat a task's name three times.
// - A requirement nothing provides, and a provide with nowhere to be looked for, are refused before anything starts
//   (Atomic runs on with a warning). A cycle still only warns, and the tasks then run in one wave in the order given.
// - A declared check is the id of one of the project's own checks, run by the WP-40 checks gate in that task's copy,
//   so a check that did not run can never pass. Atomic's checks are verify specs run after the fan-out.
// - Paths are held inside the project, a name has one provider, and a path has one owner.
import { gateRequest, type GateRequest } from "./completionGates";
import { briefProblems } from "./brief";
import { isCodeBrief, leaveList, splitChecks, type CheckLine } from "./briefChecks"; // SC-4

/** The most tasks one fan-out holds: a first mate runs at most this many at once (src-tauri/src/firstmate/mod.rs MAX_FANOUT). */
export const FANOUT_MAX_TASKS = 8;

/** What a `provides` entry can name. A `file` uses `name` as its path. */
export const PROVIDE_KINDS = ["file", "symbol", "id", "endpoint", "env", "flag", "other"] as const;
export type ProvideKind = (typeof PROVIDE_KINDS)[number];

export type ContractProvide = {
  /** The task that must produce it. */
  task: string;
  kind: ProvideKind;
  /** The literal name: `HD.Ship.reset`, `btn-launch`, `/api/score`, `js/hud.js`. */
  name: string;
  /** Where it must appear. Absent: a file the task owns or declares. */
  in?: string;
  /** What the thing is, in one line: a signature or a return shape. The one part that carries meaning, not only identity. */
  shape?: string;
};

export type ContractRequire = {
  /** The task that relies on it. */
  task: string;
  /** Matches a provide's name exactly. */
  name: string;
};

export type ContractCheck = {
  task: string;
  /** The id of one of the project's own checks (the WP-40 checks gate). */
  id: string;
};

export type Contract = {
  /** Path to task name. Nobody else writes there. */
  owners: Record<string, string>;
  provides: ContractProvide[];
  requires: ContractRequire[];
  checks: ContractCheck[];
  /** The files each task declared it changes, beside the paths it owns. */
  files: Record<string, string[]>;
};

/** What `delegate_tasks` takes for one task. Untrusted: `parseFanout` checks every field. */
export type FanoutTaskInput = {
  name: string;
  brief: string;
  goal: string;
  title?: string;
  intent?: string;
  owns?: string[];
  provides?: { kind: string; name: string; in?: string; shape?: string }[];
  requires?: string[];
  /** Ids of the project's own checks, and (SC-4) lines {what, command, expect} of the task's own. */
  checks?: (string | CheckLine)[];
  /** SC-4: paths this task must not change. */
  leave?: string[];
  files?: string[];
  project?: string;
  model?: string;
  effort?: string;
  heavy?: boolean;
  hard?: boolean;
  scope?: string[];
  asks?: string[];
  gates?: string[];
  code?: boolean;
};

export type FanoutInput = {
  /** The person's ask, shared by every task that doesn't bring its own. */
  intent?: string;
  tasks: FanoutTaskInput[];
};

/** One task, checked and ready to be sent as a `tasks.delegate` call. */
export type ParsedTask = {
  name: string;
  title?: string;
  intent: string;
  brief: string;
  goal: string;
  /** What it changes: the files it declared and the paths it owns, for the worker pool's file rule. */
  files: string[];
  /** The gates this task needs, including the checks gate when it declared a check. */
  gates?: GateRequest;
  /** SC-4: the task's own check lines (its `checks` entries that are not the project's ids). */
  checkLines: CheckLine[];
  /** SC-4: the paths it must not change. */
  leave: string[];
  /** SC-4: whether the task is a code brief by the full-mode rule (`code`, named gates or in-scope paths). */
  codeBrief: boolean;
  /** Fields passed to `tasks.delegate` as they are (delegate checks them again). */
  passthrough: Record<string, unknown>;
};

export type ParsedFanout = {
  tasks: ParsedTask[];
  contract: Contract;
  /** What the contract declares that cannot be honoured; the tasks run anyway. */
  warnings: string[];
};

/** Bounds: a name, a one-line shape, and the shared block every worker pays for in its context. */
const NAME = /^[A-Za-z0-9_-]{1,40}$/;
export const MAX_SHAPE_CHARS = 200;
export const MAX_CONTRACT_PROVIDES = 64;
export const MAX_CONTRACT_RENDERED_CHARS = 8000;
const MAX_PATHS = 30;
const MAX_NAME_CHARS = 200;
const TASK_KEYS = new Set([
  "name", "brief", "goal", "title", "intent", "owns", "provides", "requires", "checks", "files",
  "project", "model", "effort", "heavy", "hard", "scope", "asks", "gates", "code", "role", "leave",
]);
const PROVIDE_KEYS = new Set(["kind", "name", "in", "shape"]);
/** WP-141 LOW 8: a task's role goes to tasks.delegate with the rest, so a role row applies to a wave too. */
const PASSTHROUGH = ["project", "model", "effort", "heavy", "hard", "scope", "asks", "role"] as const;

/** Globs are patterns, not paths: never somewhere a provide can be looked for. */
const GLOB_CHARS = /[*?[\]{}]/;

const fail = (message: string): never => {
  throw new Error(message);
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A path inside the project, written the same way everywhere: no `./`, no trailing slash. Exported so a stored link is checked again with the same rule. */
export function projectPath(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const bad = () => fail(`A path must be relative and inside the project: "${typeof value === "string" ? value : String(value)}" is not.`);
  if (!raw || raw.length > 400 || raw.includes("\\") || /[\0\r\n]/.test(raw)) return bad();
  if (raw.startsWith("/") || raw.startsWith("~") || /^[A-Za-z]:/.test(raw)) return bad();
  const clean = raw.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  if (!clean || clean === "." || clean.split("/").some((part) => part === ".." || part === "")) return bad();
  return clean;
}

/** The folder a glob owns (`src/api/**` owns `src/api`), or the path itself; undefined for any other pattern. */
function ownedRoot(path: string): string | undefined {
  const folder = /^(.*)\/\*\*$/.exec(path);
  if (folder && !GLOB_CHARS.test(folder[1])) return folder[1];
  return GLOB_CHARS.test(path) ? undefined : path;
}

/** One names the other, or a folder holding it. */
function overlaps(a: string, b: string): boolean {
  const [x, y] = [ownedRoot(a) ?? a, ownedRoot(b) ?? b];
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

function list(value: unknown, field: string, task: string, max: number): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max)
    return fail(`Task ${task}: ${field} must be a list of at most ${max}.`);
  return value;
}

function names(value: unknown, field: string, task: string, max: number): string[] {
  const out: string[] = [];
  for (const item of list(value, field, task, max)) {
    if (typeof item !== "string" || !item.trim() || item.trim().length > MAX_NAME_CHARS)
      fail(`Task ${task}: ${field} must list short names, each a non-empty string.`);
    const name = (item as string).replace(/\s+/g, " ").trim();
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** A list of paths inside the project, each written the same way, none twice. */
function pathList(value: unknown, field: string, task: string): string[] {
  const out: string[] = [];
  for (const item of list(value, field, task, MAX_PATHS)) {
    const path = projectPath(item);
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

/** `symbol HD.Ship in js/ship.js: a class`, the same phrase everywhere. */
export function describeProvide(provide: ContractProvide): string {
  const where = provide.in === undefined ? "" : ` in ${provide.in}`;
  const shape = provide.shape === undefined ? "" : `: ${provide.shape}`;
  return `${provide.kind} ${provide.name}${where}${shape}`;
}

/** Paths a task owns, in declaration order. */
export function ownedPaths(contract: Pick<Contract, "owners">, task: string): string[] {
  return Object.entries(contract.owners)
    .filter(([, owner]) => owner === task)
    .map(([path]) => path);
}

/** A path that names one file rather than a folder or a pattern: it has an extension in its last part. */
const looksLikeFile = (path: string) => !GLOB_CHARS.test(path) && /\.[A-Za-z0-9]{1,8}$/.test(path.split("/").pop() ?? "");

/**
 * Where a provide is looked for: its `in`, else the files its task owns, else the files it declared. A folder or a
 * pattern cannot be searched for a name. Empty means nobody could check it. A file is looked for at its own path.
 */
export function provideSearchPaths(provide: ContractProvide, contract: Pick<Contract, "owners" | "files">): string[] {
  if (provide.kind === "file") return [provide.name];
  if (provide.in !== undefined) return [provide.in];
  const own = ownedPaths(contract, provide.task).filter(looksLikeFile);
  if (own.length) return own;
  return (contract.files[provide.task] ?? []).filter(looksLikeFile);
}

/**
 * The tasks, in the order given, that a requires cycle runs through, written `a → b → a`; undefined when the requires
 * can be ordered. A task depends on every other task that provides a name it requires.
 */
export function requiresCycle(
  taskNames: readonly string[],
  contract: Pick<Contract, "provides" | "requires">,
): string | undefined {
  const dependencies = dependenciesOf(taskNames, contract);
  const done = new Set<string>();
  let remaining = [...taskNames];
  while (remaining.length) {
    const ready = remaining.filter((name) => (dependencies.get(name) ?? []).every((dep) => done.has(dep)));
    if (!ready.length) return describeCycle(remaining, dependencies);
    for (const name of ready) done.add(name);
    remaining = remaining.filter((name) => !done.has(name));
  }
  return undefined;
}

/** A task that requires X depends on every other task that provides X, in the order the requires were written. */
export function dependenciesOf(
  taskNames: readonly string[],
  contract: Pick<Contract, "provides" | "requires">,
): Map<string, string[]> {
  const known = new Set(taskNames);
  const dependencies = new Map<string, string[]>();
  for (const require of contract.requires) {
    if (!known.has(require.task)) continue;
    for (const provide of contract.provides) {
      if (provide.name !== require.name || provide.task === require.task || !known.has(provide.task)) continue;
      const own = dependencies.get(require.task) ?? [];
      if (!own.includes(provide.task)) own.push(provide.task);
      dependencies.set(require.task, own);
    }
  }
  return dependencies;
}

/**
 * Follow unmet dependencies from the first stuck task until one repeats: `a → b → a` reads "a requires b requires a".
 * Every stuck task has an unmet dependency among the stuck ones, so the walk closes within their number.
 */
function describeCycle(stuck: readonly string[], dependencies: ReadonlyMap<string, readonly string[]>): string {
  const among = new Set(stuck);
  const path: string[] = [];
  let node = stuck[0];
  while (!path.includes(node)) {
    path.push(node);
    node = (dependencies.get(node) ?? []).find((dep) => among.has(dep)) ?? node;
  }
  return [...path.slice(path.indexOf(node)), node].join(" → ");
}

export function describeCycleWarning(cycle: string): string {
  return `requires form a cycle (${cycle}), so the tasks run in one wave in the order given`;
}

/**
 * The shared block every worker of the fan-out reads: all owners, provides, requires and checks, then what could not be
 * honoured. Written once, so the names the parts must agree on are not paraphrased eight times.
 */
export function renderContractBlock(contract: Contract, warnings: readonly string[] = []): string {
  const lines = [
    "CONTRACT: the interface between the parts of this fan-out. Every worker sees this same block. Produce exactly what it says you provide, under exactly these names, and reach the other parts only through what they provide.",
  ];
  const owners = Object.entries(contract.owners);
  if (owners.length) {
    lines.push("OWNERS (path, then the task that writes there; write only in paths you own):", ...owners.map(([path, task]) => `- ${path} → ${task}`));
  }
  if (contract.provides.length) lines.push("PROVIDES:", ...contract.provides.map((provide) => `- [${provide.task}] ${describeProvide(provide)}`));
  if (contract.requires.length) {
    const byTask = new Map<string, string[]>();
    for (const require of contract.requires) byTask.set(require.task, [...(byTask.get(require.task) ?? []), require.name]);
    lines.push("REQUIRES:", ...[...byTask].map(([task, wanted]) => `- [${task}] ${wanted.join(", ")}`));
  }
  if (contract.checks.length) {
    lines.push("CHECKS (the app runs each one on its task's work before the task counts as done):", ...contract.checks.map((check) => `- [${check.task}] ${check.id}`));
  }
  lines.push(...warnings.map((warning) => `contract: ${warning}`));
  return lines.join("\n");
}

/**
 * The three lines that turn the shared block into this worker's own obligations. A requirement is resolved to the
 * provide it names, so the worker knows who makes it and where, and the shape travels to the one that has to agree on it.
 */
export function renderContractForTask(contract: Contract, task: string): string {
  const owned = ownedPaths(contract, task);
  const provides = contract.provides.filter((provide) => provide.task === task);
  const relies = contract.requires
    .filter((require) => require.task === task)
    .flatMap((require) => {
      const source = contract.provides.find((provide) => provide.name === require.name);
      return source
        ? [`${require.name} (${source.kind} from ${source.task}${source.in === undefined ? "" : ` in ${source.in}`})${source.shape === undefined ? "" : `: ${source.shape}`}`]
        : [];
    });
  return [
    `You own: ${owned.length ? owned.join(", ") : "no path in this contract; write only the files your task names"}`,
    `You provide: ${provides.length ? provides.map(describeProvide).join("; ") : "nothing listed"}`,
    `You may rely on: ${relies.length ? relies.join("; ") : "nothing from the other parts"}`,
  ].join("\n");
}

function parseProvides(value: unknown, task: string): ContractProvide[] {
  const out: ContractProvide[] = [];
  for (const item of list(value, "provides", task, MAX_CONTRACT_PROVIDES)) {
    if (!isRecord(item)) return fail(`Task ${task}: each provide must be an object with a kind and a name.`);
    for (const key of Object.keys(item)) if (!PROVIDE_KEYS.has(key)) fail(`Task ${task}: unknown field "${key}" in a provide. Allowed: kind, name, in, shape.`);
    if (typeof item.kind !== "string" || !(PROVIDE_KINDS as readonly string[]).includes(item.kind))
      fail(`Task ${task}: a provide's kind must be one of ${PROVIDE_KINDS.join(", ")}.`);
    const kind = item.kind as ProvideKind;
    if (typeof item.name !== "string" || !item.name.trim() || item.name.trim().length > MAX_NAME_CHARS)
      fail(`Task ${task}: a provide needs a name, the literal one other tasks will require.`);
    const name = kind === "file" ? projectPath(item.name) : (item.name as string).replace(/\s+/g, " ").trim();
    if (kind === "file" && GLOB_CHARS.test(name)) fail(`Task ${task}: a file provide names one file, not a pattern ("${name}").`);
    if (out.some((entry) => entry.name === name)) fail(`Task ${task} provides "${name}" twice.`);
    const found: ContractProvide = { task, kind, name };
    if (kind !== "file" && item.in !== undefined) {
      const where = projectPath(item.in);
      if (GLOB_CHARS.test(where)) fail(`Task ${task}: where "${name}" will be (in) names one file, not a pattern.`);
      found.in = where;
    }
    if (item.shape !== undefined) {
      if (typeof item.shape !== "string" || item.shape.length > MAX_SHAPE_CHARS)
        fail(`Task ${task}: a provide's shape is one line of at most ${MAX_SHAPE_CHARS} characters.`);
      const shape = (item.shape as string).replace(/\s+/g, " ").trim();
      if (shape) found.shape = shape;
    }
    out.push(found);
  }
  return out;
}

/**
 * The contract of a `delegate_tasks` call, checked in full before anything starts. A refusal says which task and which
 * name, so the first mate fixes that one thing and sends the call again.
 */
export function parseFanout(input: unknown): ParsedFanout {
  if (!isRecord(input)) return fail("delegate_tasks needs an object with a list of tasks.");
  for (const key of Object.keys(input)) if (key !== "intent" && key !== "tasks") fail(`Unknown field "${key}". Allowed: intent, tasks.`);
  if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > FANOUT_MAX_TASKS)
    fail(`tasks must list 1 to ${FANOUT_MAX_TASKS} tasks (the most one first mate runs at once). A bigger job goes in as a smaller plan, or as a task for another first mate.`);
  if (input.intent !== undefined && typeof input.intent !== "string") fail("intent must be the person's ask, as text.");
  const shared = typeof input.intent === "string" ? input.intent.trim() : "";

  const contract: Contract = { owners: {}, provides: [], requires: [], checks: [], files: {} };
  const tasks: ParsedTask[] = [];
  const wanted = new Map<string, string[]>();
  for (const raw of input.tasks as unknown[]) {
    if (!isRecord(raw)) return fail("Each task must be an object with a name, a brief and a goal.");
    const label = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "?";
    for (const key of Object.keys(raw)) if (!TASK_KEYS.has(key)) fail(`Unknown field "${key}" on task ${label}. Allowed: ${[...TASK_KEYS].join(", ")}.`);
    if (typeof raw.name !== "string" || !NAME.test(raw.name.trim()))
      fail(`A task's name must be letters, digits, - and _ (up to 40 characters), like "api": "${label}" is not.`);
    const name = (raw.name as string).trim();
    if (tasks.some((task) => task.name === name)) fail(`Two tasks are named "${name}". Each task needs its own name.`);

    const intent = typeof raw.intent === "string" && raw.intent.trim() ? raw.intent.trim() : shared;
    const problems = briefProblems({ intent, spec: raw.brief, done: raw.goal });
    if (problems.length) fail(`Task ${name}: ${problems.join("; ")}. Fill intent with the person's own ask (once, at the top, or on the task), brief with the build instructions, and goal with the condition that finishes it.`);

    const owns = pathList(raw.owns, "owns", name);
    for (const path of owns) {
      for (const [other, owner] of Object.entries(contract.owners)) {
        if (owner === name || !overlaps(path, other)) continue;
        const [outer, inner] = (ownedRoot(path) ?? path).length <= (ownedRoot(other) ?? other).length ? [path, other] : [other, path];
        const inside = outer === inner ? "" : ` (${inner} is inside it)`;
        fail(`"${outer}" is owned by both ${owner} and ${name}${inside}. Each path has one owner; give the shared part to one task and have the other require it.`);
      }
      contract.owners[path] = name;
    }
    const declared = pathList(raw.files, "files", name);
    contract.files[name] = declared;

    const provides = parseProvides(raw.provides, name);
    for (const provide of provides) {
      const other = contract.provides.find((entry) => entry.name === provide.name);
      if (other) fail(`"${provide.name}" is provided by both ${other.task} and ${name}. Each name has one provider.`);
    }
    contract.provides.push(...provides);
    wanted.set(name, names(raw.requires, "requires", name, MAX_CONTRACT_PROVIDES));

    // SC-4: `checks` holds the ids of the project's own checks (as ever) and, now, the task's own lines. A list of plain
    // names reads exactly as it did.
    const briefOwn = (read: () => void): void => {
      try {
        read();
      } catch (error) {
        fail(`Task ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    let checkIds: unknown = raw.checks;
    let checkLines: CheckLine[] = [];
    let leave: string[] = [];
    briefOwn(() => {
      if (Array.isArray(raw.checks) && raw.checks.some((item) => typeof item !== "string")) {
        const split = splitChecks(raw.checks);
        checkIds = split.ids;
        checkLines = split.lines;
      }
      leave = leaveList(raw.leave);
    });
    const checks = names(checkIds, "checks", name, 20);
    for (const id of checks) contract.checks.push({ task: name, id });
    const gateWords = [...new Set([...names(raw.gates, "gates", name, 5), ...(checks.length ? ["checks"] : [])])];
    let gates: GateRequest | undefined;
    try {
      gates = gateRequest({
        gates: gateWords.length ? gateWords : undefined,
        checks: checks.length ? checks : undefined,
        // SC-4: a task with lines of its own is a code task, like a delegate_task with them.
        code: (raw.code === undefined || raw.code === false) && checkLines.length ? true : raw.code,
      });
    } catch (error) {
      return fail(`Task ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const owned = owns.flatMap((path) => {
      const root = ownedRoot(path);
      return root ? [root] : [];
    });
    tasks.push({
      name,
      ...(typeof raw.title === "string" && raw.title.trim() ? { title: raw.title.trim() } : {}),
      intent,
      brief: (raw.brief as string).trim(),
      goal: (raw.goal as string).trim(),
      files: [...new Set([...declared, ...owned])],
      ...(gates ? { gates } : {}),
      checkLines,
      leave,
      // Read from what `delegate` will be handed (the derived gates and the scope), so the plan's one refusal and each
      // task's own agree.
      codeBrief: isCodeBrief({ code: gates?.code, gates: gates?.gates, scope: raw.scope }),
      passthrough: Object.fromEntries(PASSTHROUGH.filter((key) => raw[key] !== undefined).map((key) => [key, raw[key]])),
    });
  }
  if (contract.provides.length > MAX_CONTRACT_PROVIDES) fail(`A fan-out names at most ${MAX_CONTRACT_PROVIDES} provides.`);

  for (const provide of contract.provides) {
    if (provide.kind === "file") continue;
    if (provideSearchPaths(provide, contract).length === 0)
      fail(`Task ${provide.task} provides "${provide.name}" but it cannot be checked: no \`in\` file, no file it owns and no file it declares. Say where it will be (in), or give the task that file in owns or files.`);
  }
  for (const [task, required] of wanted) {
    for (const name of required) {
      const provider = contract.provides.find((provide) => provide.name === name);
      if (!provider) fail(`Task ${task} requires "${name}", but no task provides it. Name the task that makes it in that task's provides (the name must match exactly), or leave the requirement out.`);
      else if (provider.task === task) fail(`Task ${task} requires "${name}", which it provides itself. A task cannot wait on its own work: drop the requirement.`);
      contract.requires.push({ task, name });
    }
  }

  const warnings: string[] = [];
  const cycle = requiresCycle(tasks.map((task) => task.name), contract);
  if (cycle) warnings.push(describeCycleWarning(cycle));
  const size = renderContractBlock(contract, warnings).length;
  if (size > MAX_CONTRACT_RENDERED_CHARS)
    fail(`The contract is too long (${size.toLocaleString("en-US")} characters; the most is ${MAX_CONTRACT_RENDERED_CHARS.toLocaleString("en-US")}, because every worker carries it). Shorten the shapes or name fewer provides.`);
  return { tasks, contract, warnings };
}
