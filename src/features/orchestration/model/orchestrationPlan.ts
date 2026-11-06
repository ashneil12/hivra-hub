import { HARNESSES, type Block, type HarnessId, type Session } from "../../sessions/model/session";
import { isEqualOrInside, pathKey } from "../../../shared/lib/paths";
import {
  CHECK_COMMAND_MAX,
  CHECK_TEXT_MAX,
  GOAL_MAX,
  refusalMessage,
  type GoalCheck,
  type GoalPlanAnswer,
} from "./orchestrationGoal";

export type OrchestrationChoice = {
  harness: HarnessId;
  model: string;
  name: string;
};
export type OrchestrationSettings = {
  choices: OrchestrationChoice[];
  maxWorkers: number;
};
export type ProposedTask = {
  id: string;
  title: string;
  prompt: string;
  harness: HarnessId;
  model: string;
  modelSettings?: Record<string, string>;
  files: string[];
  dependsOn: string[];
  /** WP-91: the plain `build` role, or the one `verify` task that checks the goal. */
  role?: "build" | "verify";
  /** WP-91: a step that cannot be undone, so the person approves it before it starts. */
  irreversible?: boolean;
  /** The one line saying why it cannot be undone. */
  irreversibleReason?: string;
};
export type OrchestrationProposal = {
  version: 1;
  leadId: string;
  /** Project identity retained for history and proposal ownership. */
  cwd: string;
  /** Concrete checkout inspected while preparing this proposal. */
  checkoutCwd?: string;
  request: string;
  author: OrchestrationChoice;
  settings: OrchestrationSettings;
  status: "planning" | "ready" | "invalid" | "starting" | "approved";
  title: string;
  summary: string;
  /** WP-91: the one line the run is for. */
  goal: string;
  /** WP-91: the finish line — a command that fails until the goal holds. */
  check: GoalCheck;
  /** WP-91: what the graph rules answered about this plan, once they were asked. */
  graph?: GoalPlanAnswer;
  tasks: ProposedTask[];
  error?: string;
  /** Kept only for invalid cards so a retry can repair the response directly. */
  response?: string;
};

function required(value: unknown, label: string, max = 30_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`Provide ${label}`);
  return value.trim();
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an assignment object");
  return value as Record<string, unknown>;
}
function stringList(value: unknown, label: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error(`Invalid ${label}`);
  return [
    ...new Set(
      value
        .filter((item) => item !== "")
        .map((item) => required(item, label, 512)),
    ),
  ];
}

/** The one line a run is for. A value from a model is untrusted: length, type and control characters are checked. */
export function validateGoal(value: unknown): string {
  const goal = required(value, "the goal this run is for", GOAL_MAX);
  if (goal.includes("\n") || /\p{Cc}/u.test(goal))
    throw new Error("Keep the goal to one line");
  return goal;
}

/**
 * The finish line: a command that fails until the goal holds, the exit code it must give, and optionally text it
 * must print. An empty or over-long command, an exit code that is not a whole number in range, and text that is too
 * long or spans lines are all refused with plain words.
 */
export function validateGoalCheck(value: unknown): GoalCheck {
  const input = record(value);
  const command = required(input.command, "the command that proves the goal", CHECK_COMMAND_MAX);
  if (command.includes("\n") || command.includes("\r") || /\p{Cc}/u.test(command))
    throw new Error("Keep the finish-line check's command to one line");
  const expectExit = input.expectExit ?? 0;
  if (
    typeof expectExit !== "number" ||
    !Number.isInteger(expectExit) ||
    expectExit < -255 ||
    expectExit > 255
  )
    throw new Error(
      "The exit code the check expects must be a whole number between -255 and 255",
    );
  const expectText =
    input.expectText == null || input.expectText === ""
      ? undefined
      : required(input.expectText, "the text the check must print", CHECK_TEXT_MAX);
  if (expectText && (expectText.includes("\n") || /\p{Cc}/u.test(expectText)))
    throw new Error("Keep the text the check must print to one line");
  const timeoutSeconds =
    input.timeoutSeconds == null
      ? undefined
      : typeof input.timeoutSeconds === "number" &&
          Number.isInteger(input.timeoutSeconds) &&
          input.timeoutSeconds > 0
        ? input.timeoutSeconds
        : (() => {
            throw new Error("The check's timeout is a whole number of seconds");
          })();
  return {
    command,
    expectExit,
    ...(expectText ? { expectText } : {}),
    ...(timeoutSeconds ? { timeoutSeconds } : {}),
  };
}

function scopePath(value: string): string {
  // A scope written into a file or copied from a model can carry CRLF and stray spaces; strip them before comparing,
  // so "src/a.ts\r" is the same path as "src/a.ts" (as Rust's `topology::scope_path` does).
  const slashed = value.replace(/\r/g, "").trim().replace(/\\/g, "/");
  const prefix = slashed.startsWith("//")
    ? "//"
    : /^[A-Za-z]:\//.test(slashed)
      ? slashed.slice(0, 3)
      : slashed.startsWith("/")
        ? "/"
        : "";
  const rest = slashed.slice(prefix.length);
  const parts = rest.split("/").filter((part) => part && part !== ".");
  return `${prefix}${parts.join("/")}` || ".";
}

function projectRelativeScope(
  value: string,
  cwd: string | undefined,
  assignmentId: string,
): string {
  const slashed = value.replace(/\\/g, "/");
  if (slashed.split("/").includes(".."))
    throw new Error(
      `Assignment "${assignmentId}" has invalid file scope "${value}". Use project-relative paths without '..', or '.' for the whole project`,
    );
  const normalized = scopePath(value);
  if (/^[A-Za-z]:/.test(normalized) && !/^[A-Za-z]:\//.test(normalized))
    throw new Error(
      `Assignment "${assignmentId}" has invalid file scope "${value}". Use project-relative paths, or '.' for the whole project`,
    );
  const absolute =
    normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
  if (!absolute) return normalized;
  if (!cwd || !isEqualOrInside(normalized, scopePath(cwd)))
    throw new Error(
      `Assignment "${assignmentId}" uses file scope "${value}" outside the selected checkout${cwd ? ` "${cwd}"` : ""}. Orchestration currently supports one checkout per run`,
    );
  const root = scopePath(cwd);
  if (pathKey(normalized) === pathKey(root)) return ".";
  return normalized.slice(root.length).replace(/^\/+/, "");
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  const input = record(value);
  const entries = Object.entries(input);
  if (entries.length > 32) throw new Error(`Invalid ${label}`);
  return Object.fromEntries(
    entries.map(([key, entry]) => [
      required(key, label, 128),
      required(entry, label, 256),
    ]),
  );
}

export function validateOrchestrationSettings(
  value: unknown,
): OrchestrationSettings {
  const input = record(value);
  if (
    !Number.isInteger(input.maxWorkers) ||
    Number(input.maxWorkers) < 1 ||
    Number(input.maxWorkers) > 4
  )
    throw new Error("Choose 1 to 4 parallel workers");
  if (
    !Array.isArray(input.choices) ||
    !input.choices.length ||
    input.choices.length > 4096
  )
    throw new Error(
      "No worker models are available, or the model catalog is too large. Check your connected harnesses.",
    );
  const choices = input.choices.map((value) => {
    const item = record(value);
    const harness = required(item.harness, "a harness", 32) as HarnessId;
    if (!HARNESSES.includes(harness)) throw new Error("Unknown worker harness");
    return {
      harness,
      model: required(item.model, "a model", 256),
      name: required(item.name, "a model name", 256),
    };
  });
  return {
    maxWorkers: Number(input.maxWorkers),
    choices: choices.filter(
      (choice, index) =>
        choices.findIndex(
          (entry) =>
            entry.harness === choice.harness && entry.model === choice.model,
        ) === index,
    ),
  };
}

/** Validate the entire graph before enabling any process or acquiring scopes. */
export function validateProposedTasks(
  value: unknown,
  settings: OrchestrationSettings,
  cwd?: string,
): ProposedTask[] {
  if (!Array.isArray(value) || !value.length || value.length > 40)
    throw new Error("Provide 1 to 40 assignments");
  const tasks = value.map((value, index) => {
    const task = record(value);
    const label = `assignment ${index + 1}${typeof task.id === "string" ? ` (${task.id})` : ""}`;
    const model = required(task.model, `a model for ${label}`, 256);
    // Models already identify their harness in our catalog. Recover an omitted
    // redundant field without another model call, but never override a choice.
    const matches = settings.choices.filter((choice) => choice.model === model);
    const harnesses = [...new Set(matches.map((choice) => choice.harness))];
    const missingHarness = task.harness == null || task.harness === "";
    const harness = required(
      missingHarness && harnesses.length === 1 ? harnesses[0] : task.harness,
      `a harness for ${label}; use an exact harness/model pair from the available catalog`,
      32,
    ) as HarnessId;
    if (
      !settings.choices.some(
        (choice) => choice.harness === harness && choice.model === model,
      )
    )
      throw new Error(
        `The harness/model pair for ${label} is outside the available catalog: ${harness} / ${model}`,
      );
    const id = required(task.id, "an assignment ID", 64);
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw new Error(
        "Assignment IDs must contain letters, numbers, underscores or hyphens",
      );
    const role = task.role ?? "build";
    if (role !== "build" && role !== "verify")
      throw new Error(`Assignment "${id}" has role "${String(task.role)}"; use build or verify`);
    const irreversible = task.irreversible === true;
    const irreversibleReason = irreversible
      ? required(
          task.irreversibleReason,
          `a one-line reason ${id} cannot be undone`,
          200,
        )
      : undefined;
    if (irreversibleReason && irreversibleReason.includes("\n"))
      throw new Error(`Assignment "${id}": keep the reason it cannot be undone to one line`);
    const files = [
      ...new Set(
        stringList(task.files, "file scopes", 64).map((path) =>
          projectRelativeScope(path, cwd, id),
        ),
      ),
    ];
    if (!files.length && role !== "verify")
      throw new Error(
        `Assignment "${id}" has no file scopes. Use project-relative paths, or '.' for the whole project`,
      );
    if (role === "verify" && files.includes("."))
      throw new Error(
        `Assignment "${id}" is the verify task and claims the whole project. A verify task checks the goal; give it the files it writes, or none`,
      );
    return {
      id,
      title: required(task.title, "a task title", 160),
      prompt: required(task.prompt, "task instructions"),
      harness,
      model,
      ...(task.modelSettings === undefined
        ? {}
        : {
            modelSettings: stringRecord(task.modelSettings, "model settings"),
          }),
      files,
      dependsOn: stringList(task.dependsOn ?? [], "dependencies", 40),
      ...(role === "verify" ? { role: "verify" as const } : {}),
      ...(irreversible
        ? { irreversible: true, irreversibleReason: irreversibleReason! }
        : {}),
    };
  });
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length)
    throw new Error("Assignment IDs must be unique");
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string) => {
    if (!ids.has(id))
      throw new Error("A dependency references an unknown assignment");
    if (visiting.has(id))
      throw new Error("Assignments have a dependency cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    tasks.find((task) => task.id === id)!.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  tasks.forEach((task) => visit(task.id));
  return tasks;
}

export function orchestrationPlanningPrompt(
  request: string,
  settings: OrchestrationSettings,
  cwd: string,
): string {
  return [
    "Prepare an orchestration proposal for the user to review in MonoCode. Investigate and plan only: do not edit files, start workers, or invoke the MonoCode control CLI. No execution is authorized until the user confirms the assignment card.",
    "You are the orchestrator: the user selected you in the composer model picker. Decide the task breakdown and choose each worker's harness and model from the available catalog below. Do not ask the user to assemble a team. They can change your choices in the card before confirming.",
    "Keep planning efficient: inspect only what is needed to understand the request and relevant project conventions. Use the fewest useful tasks, with clear deliverables and acceptance checks. Do not create agents for trivial steps or duplicate investigation. Prefer a fast, economical model for straightforward work and a more capable model when complexity warrants it; do not invent model capabilities or prices. Reuse a suitable harness/model across tasks when that is sufficient. Explain your overall division of work briefly in the summary.",
    'Use only exact harness/model pairs from the catalog. Give each task self-contained instructions and project-relative write scopes; directories own their descendants. Parallelize independent work with disjoint files. Serialize shared-file edits with dependencies and avoid concurrent repository-wide commands. Assign project-wide generation or final combined validation to a task with files ["."]. Workers must not commit, push, switch branches, or write outside the selected checkout. If the user requested Git or cross-checkout finalization, do not create a worker for it: the lead performs only those explicitly authorized final operations after every worker is reviewed, integrated, and the orchestration run is finished. All workers use app-managed isolated checkouts; do not ask them to create or switch worktrees.',
    "State the goal in one line and the finish line as a command the app runs itself: it must be red on the untouched checkout before any work starts, and green when the goal holds. Give expectExit when a command reports success some other way, and expectText when the exit code alone is not the whole finish line.",
    'Exactly one task must have "role":"verify". It must depend on every task that writes, change nothing itself (give it "files":[]), and be able to see the whole result. No other task may carry a role.',
    'Two tasks that can run at the same time may not share a write scope, even indirectly: make one depend on the other, or split the files. A task that cannot be undone — a migration against a shared database, a call that spends money — gets "irreversible":true and a one-line "irreversibleReason"; the person approves it before it starts, and nothing downstream of it begins until they do.',
    `The exact checkout root is ${JSON.stringify(cwd)}. Every files entry must be "." or a path relative to this root. For example, a discovered absolute path beneath this root must be returned without the root prefix. Never use an absolute path or '..'.`,
    "Return your final proposal as one JSON object inside <monocode_proposal>...</monocode_proposal>. The app renders it as an editable card, so do not ask for approval in prose. No Markdown inside the JSON fields. Tasks may reference any task ID; the graph must be acyclic.",
    'Schema: {"title":"Short project title","summary":"What you will do and how the work fits together","goal":"One line: what this run is for","check":{"command":"the command that proves it","expectExit":0,"expectText":"optional text the output must hold"},"tasks":[{"id":"task-1","title":"Short task title","prompt":"Self-contained instructions, constraints and checks","harness":"exact harness ID","model":"exact model ID","files":["src/feature"],"dependsOn":[]},{"id":"verify","title":"Check the goal","prompt":"Verify the goal end to end","harness":"exact harness ID","model":"exact model ID","role":"verify","files":[],"dependsOn":["task-1"]}]}',
    `Parallel worker limit: ${settings.maxWorkers}`,
    `<available_models>\n${JSON.stringify(settings.choices)}\n</available_models>`,
    `<user_request>\n${request}\n</user_request>`,
  ].join("\n\n");
}

export function completeOrchestrationProposal(
  draft: OrchestrationProposal,
  response: string,
  error?: string,
): OrchestrationProposal {
  try {
    if (error) throw new Error(error);
    const tagged = response.match(
      /<monocode_proposal>\s*([\s\S]*?)\s*<\/monocode_proposal>/,
    );
    const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = (tagged?.[1] ?? fenced?.[1] ?? response).trim();
    const input = record(JSON.parse(raw));
    return {
      ...draft,
      title: required(input.title, "a proposal title", 160),
      summary: required(input.summary, "a proposal summary", 2000),
      goal: validateGoal(input.goal),
      check: validateGoalCheck(input.check),
      tasks: validateProposedTasks(
        input.tasks,
        draft.settings,
        draft.checkoutCwd ?? draft.cwd,
      ),
      status: "ready",
      error: undefined,
      response: undefined,
    };
  } catch (reason) {
    return {
      ...draft,
      status: "invalid",
      response: response.slice(-200_000),
      error:
        error ??
        `Could not prepare the assignment card: ${reason instanceof Error ? reason.message : String(reason)}`,
    };
  }
}

export function orchestrationRepairPrompt(
  proposal: OrchestrationProposal,
): string {
  return [
    orchestrationPlanningPrompt(
      proposal.request,
      proposal.settings,
      proposal.checkoutCwd ?? proposal.cwd,
    ),
    "Correct the previous proposal using the validation error below. Reuse your investigation and task breakdown; do not inspect the project again or run tools. Return only the corrected <monocode_proposal> JSON. Include an exact harness and model on every task. Do not execute any assignments.",
    `Validation error: ${proposal.error ?? "The previous proposal was invalid"}`,
    `<previous_response>\n${proposal.response?.slice(-60_000) ?? ""}\n</previous_response>`,
  ].join("\n\n");
}

/**
 * WP-91: the graph is checked as soon as the plan is read, so a plan two tasks could run at once on the same file,
 * or one without its single verify task, is refused with the fix named — and the one repair turn can correct it.
 */
export async function checkProposalGraph(
  proposal: OrchestrationProposal,
  check: (nodes: ReturnType<typeof goalPlanNodes>) => Promise<GoalPlanAnswer>,
): Promise<OrchestrationProposal> {
  try {
    // The answer's layers are kept on the card, so the plan draws the same graph the run will.
    return { ...proposal, graph: await check(goalPlanNodes(proposal.tasks)) };
  } catch (reason) {
    return {
      ...proposal,
      status: "invalid",
      response: JSON.stringify({
        title: proposal.title,
        summary: proposal.summary,
        goal: proposal.goal,
        check: proposal.check,
        tasks: proposal.tasks,
      }).slice(-200_000),
      error: `Could not accept the assignment card: ${refusalMessage(reason)}`,
    };
  }
}

/** At most one corrective turn; provider failures and cancellation never loop. */
export async function completeOrRepairOrchestrationProposal(
  draft: OrchestrationProposal,
  response: string,
  repair: (prompt: string) => Promise<string>,
  canRepair: () => boolean,
  checkGraph?: (nodes: ReturnType<typeof goalPlanNodes>) => Promise<GoalPlanAnswer>,
): Promise<OrchestrationProposal> {
  const read = (text: string) => completeOrchestrationProposal(draft, text);
  let first = read(response);
  if (first.status === "ready" && checkGraph)
    first = await checkProposalGraph(first, checkGraph);
  if (first.status !== "invalid" || !canRepair()) return first;
  const corrected = await repair(orchestrationRepairPrompt(first));
  const fixed = read(corrected);
  return fixed.status === "ready" && checkGraph
    ? await checkProposalGraph(fixed, checkGraph)
    : fixed;
}

export function proposalMarkdown(proposal: OrchestrationProposal): string {
  return [
    `# ${proposal.title}`,
    proposal.summary,
    ...(proposal.goal ? [`Goal: ${proposal.goal}`] : []),
    ...(proposal.check ? [`Finish line: ${goalCheckText(proposal.check)}`] : []),
    ...proposal.tasks.map(
      (task) =>
        `## ${task.title}${task.role === "verify" ? " (verify)" : ""}\n${task.harness} · ${proposal.settings.choices.find((choice) => choice.harness === task.harness && choice.model === task.model)?.name ?? task.model}\n${task.prompt}\nFiles: ${task.files.join(", ") || "none"}\nDepends on: ${task.dependsOn.join(", ") || "None"}${task.irreversible ? `\nCannot be undone: ${task.irreversibleReason ?? "no reason given"}` : ""}`,
    ),
  ].join("\n\n");
}

/** The finish line in one line, for the card and the lead's prompt. */
export function goalCheckText(check: GoalCheck): string {
  const suffix = check.expectText ? `, printing ${JSON.stringify(check.expectText)}` : "";
  return `${check.command} (exit ${check.expectExit}${suffix})`;
}

/** A proposal's tasks as the graph rules read them (WP-91's Rust side). */
export function goalPlanNodes(tasks: ProposedTask[]): {
  id: string;
  title: string;
  role: "build" | "verify";
  dependsOn: string[];
  writeScope: string[];
}[] {
  return tasks.map((task) => ({
    id: task.id,
    title: task.title,
    role: task.role ?? "build",
    dependsOn: task.dependsOn,
    writeScope: task.files,
  }));
}

export function withOrchestrationProposal(
  session: Session,
  blockId: string,
  proposal: OrchestrationProposal,
): Session {
  return {
    ...session,
    blocks: session.blocks.map((block) =>
      block.id === blockId
        ? {
            ...block,
            text: proposalMarkdown(proposal),
            orchestration: proposal,
            streaming: proposal.status === "planning",
          }
        : block,
    ),
  };
}

export function proposalBlock(
  id: string,
  proposal: OrchestrationProposal,
): Block {
  return {
    id,
    role: "plan",
    text: proposalMarkdown(proposal),
    orchestration: proposal,
    streaming: true,
  };
}

/** A reload must never turn a half-generated card into an executable plan. */
export function restoreOrchestrationProposal(
  value: OrchestrationProposal,
): OrchestrationProposal {
  if (value.status === "planning")
    return {
      ...value,
      status: "invalid",
      error: "Planning was interrupted. Generate the assignments again.",
    };
  if (value.status === "starting") return { ...value, status: "ready" };
  return value;
}
