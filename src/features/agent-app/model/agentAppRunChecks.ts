// SC-7: the `run_checks` tool (src-tauri/src/mcp_server.rs sends `run_checks.run`). A worker, or a first mate, runs "this
// project's tests for what changed" in its own checkout and gets back only the runner's summary line, each failing test
// with its message, the counts, the path of the full log and one word: red, green or inconclusive. The app runs it
// (src-tauri/src/run_checks.rs): the command is the project's own, never one the caller types, and every run is also kept
// as a record the gates read (a worker cannot write it). This replaces the worker rule "never paste test output" with a
// tool that does the trimming.
import { invoke } from "@tauri-apps/api/core";
import type { Session } from "../../sessions/model/session";
import type { AgentAppHost } from "./agentApp";

/** The FIELDS entry of the action (agentApp.ts). `project` names one of a first mate's projects; a worker has none to name. */
export const RUN_CHECKS_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["run_checks.run", ["command", "paths", "project"]],
];

const MAX_COMMAND = 400;
const MAX_PATHS = 200;
const MAX_PATH = 1024;
const MAX_FAILURES = 20;

export type RunChecksOutcome = "red" | "green" | "inconclusive";

/** What comes back, and all that does. Mirrors `run_checks::Report`. */
export type RunChecksReport = {
  outcome: RunChecksOutcome;
  /** The runner's own summary line (a one-line count for a runner that prints none). */
  summary: string;
  total: number;
  failed: number;
  failures: { name: string; message: string }[];
  /** Failing tests past the cap that are not listed; the log has them. */
  moreFailures?: number;
  /** The path of the full log. */
  log: string;
  /** The ids of what ran. */
  command: string;
  /** Why the run decides nothing, or what to do next. */
  note?: string;
};

export type RunChecksInput = { cwd: string; owner: string; command?: string; paths?: string[] };

/** The app's command; tests pass their own. */
export type RunChecksBackend = { run(input: RunChecksInput): Promise<unknown> };

export const tauriRunChecks: RunChecksBackend = {
  run: (input) => invoke("run_checks_run", { input }),
};

function words(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : String(error);
}

function optionalCommand(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("command must be one of the project's check ids");
  const text = value.trim();
  if (text.length > MAX_COMMAND) throw new Error(`command must be at most ${MAX_COMMAND} characters`);
  return text || undefined;
}

function optionalPaths(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error("paths must be a list of file paths");
  if (value.length > MAX_PATHS) throw new Error(`paths may name at most ${MAX_PATHS} files`);
  const paths = (value as string[]).map((item) => item.trim()).filter(Boolean);
  if (paths.some((path) => path.length > MAX_PATH)) throw new Error(`a path may be at most ${MAX_PATH} characters`);
  return paths.length ? paths : undefined;
}

/** The app's answer, kept to the fields the tool promises. Anything else (an output, an exit code) is dropped. */
function readReport(raw: unknown): RunChecksReport {
  const value = raw as Record<string, unknown> | null;
  const outcome = value?.outcome;
  if (
    !value ||
    typeof value !== "object" ||
    (outcome !== "red" && outcome !== "green" && outcome !== "inconclusive") ||
    typeof value.summary !== "string" ||
    typeof value.total !== "number" ||
    typeof value.failed !== "number" ||
    typeof value.log !== "string" ||
    typeof value.command !== "string" ||
    !Array.isArray(value.failures)
  ) {
    throw new Error("The run_checks answer couldn't be read, so nothing is reported as run.");
  }
  const failures = (value.failures as unknown[])
    .flatMap((item) => {
      const entry = item as { name?: unknown; message?: unknown } | null;
      return entry && typeof entry.name === "string" && typeof entry.message === "string"
        ? [{ name: entry.name, message: entry.message }]
        : [];
    })
    .slice(0, MAX_FAILURES);
  return {
    outcome,
    summary: value.summary,
    total: value.total,
    failed: value.failed,
    failures,
    ...(typeof value.moreFailures === "number" && value.moreFailures > 0 ? { moreFailures: value.moreFailures } : {}),
    log: value.log,
    command: value.command,
    ...(typeof value.note === "string" && value.note ? { note: value.note } : {}),
  };
}

/**
 * The `run_checks.run` action (agentApp.ts dispatches it here after checking its fields). `projectOf` is the project choice
 * every other action makes: a worker's own copy, a coding team's project, or the one a Mono names. The records of the run
 * are kept under the worker's task, else under the chat.
 */
export async function handleRunChecks(
  source: Session,
  action: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
  projectOf: (source: Session, input: Record<string, unknown>) => string,
): Promise<RunChecksReport> {
  if (action !== "run_checks.run") throw new Error(`Unknown app action: ${action}`);
  if (host.isHabitRun?.(source.id))
    throw new Error("A habit run doesn't run the project's tests. The first mate does, from its own chat.");
  const command = optionalCommand(input.command);
  const paths = optionalPaths(input.paths);
  const cwd = projectOf(source, input);
  // The task this chat is working on, when it is a worker's chat: the gates read the records by that id.
  const task = await Promise.resolve(host.tasks?.selfTask?.(source.id)).catch(() => undefined);
  const backend = host.runChecks ?? tauriRunChecks;
  let raw: unknown;
  try {
    raw = await backend.run({
      cwd,
      owner: task?.id ?? source.id,
      ...(command ? { command } : {}),
      ...(paths ? { paths } : {}),
    });
  } catch (error) {
    throw new Error(words(error));
  }
  return readReport(raw);
}
