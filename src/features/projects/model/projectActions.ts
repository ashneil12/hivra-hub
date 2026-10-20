import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * A project's checked-in actions (`.monocode/project.json`, src-tauri/src/project_file.rs) and their runs
 * (src-tauri/src/project_actions.rs). The file is read from the main checkout only, and nothing in it runs until Ash
 * imports it in Settings > Worktrees.
 */
export type ProjectAction = {
  id: string;
  name: string;
  command: string;
  description?: string;
  icon?: string;
  runOnWorktreeCreate?: boolean;
  hold?: boolean;
  longRunning?: boolean;
  timeoutSeconds?: number;
  confirm?: string;
};

export type ProjectFile = {
  version: number;
  name?: string;
  /** The mainline the worktree janitor checks "merged" against; else the main checkout's branch. */
  mainBranch?: string;
  actions: ProjectAction[];
  worktrees?: { buildOutput?: string[]; regenerable?: string[] };
};

export type ProjectFileState = "none" | "new" | "trusted" | "changed" | "invalid";

export type ProjectFileStatus = {
  projectRoot: string;
  path: string;
  state: ProjectFileState;
  error: string | null;
  fileHash: string | null;
  file: ProjectFile | null;
  trustedHash: string | null;
  trusted: ProjectFile | null;
  importedAt: number | null;
};

export type ActionRunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "stopped"
  | "timedOut";

export type ActionRun = {
  id: string;
  projectRoot: string;
  cwd: string;
  actionId: string;
  actionName: string;
  command: string;
  trigger: "worktree-create" | "app" | "agent";
  status: ActionRunStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  logPath: string;
  tail: string[];
  longRunning: boolean;
  error: string | null;
};

export type ActionsListing = {
  status: ProjectFileStatus;
  actions: ProjectAction[];
  runs: ActionRun[];
};

/** What worktree creation reports about the setup it started. */
export type WorktreeSetup = {
  actionId: string | null;
  name: string | null;
  command: string | null;
  hold: boolean;
  run: ActionRun | null;
  skipped: string | null;
};

export const PROJECT_ACTION_EVENT = "project-action";

export type ProjectActionEvent = {
  runId: string;
  line?: string;
  run?: ActionRun;
};

export const listProjectActions = (cwd: string) =>
  invoke<ActionsListing>("project_actions_list", { cwd });

export const runProjectAction = (
  cwd: string,
  actionId: string,
  trigger: "app" | "agent" = "app",
) => invoke<ActionRun>("project_action_run", { cwd, actionId, trigger });

export const stopProjectAction = (runId: string) =>
  invoke<ActionRun>("project_action_stop", { runId });

/** Waits at most `timeoutMs` (capped at a minute) and returns the run either way. */
export const waitProjectAction = (runId: string, timeoutMs: number) =>
  invoke<ActionRun>("project_action_wait", { runId, timeoutMs });

export const projectFileStatus = (cwd: string) =>
  invoke<ProjectFileStatus>("project_file_status", { cwd });

/** Ash's explicit import of the file he reviewed (`hash`). Only the Settings page calls this. */
export const importProjectFile = (cwd: string, hash: string) =>
  invoke<ProjectFileStatus>("project_file_import", { cwd, hash });

export const forgetProjectFile = (cwd: string) =>
  invoke<ProjectFileStatus>("project_file_forget", { cwd });

export function onProjectActionEvent(
  handler: (event: ProjectActionEvent) => void,
): () => void {
  // Outside the app (a browser preview, tests) there is no event bridge: no live updates, and no error.
  const listening = listen<ProjectActionEvent>(PROJECT_ACTION_EVENT, ({ payload }) =>
    handler(payload),
  ).catch(() => undefined);
  return () => {
    void listening.then((unlisten) => unlisten?.());
  };
}

export const runFinished = (run: Pick<ActionRun, "status">) =>
  run.status !== "running";

export function runStatusLabel(run: Pick<ActionRun, "status" | "exitCode">) {
  switch (run.status) {
    case "running":
      return "Running";
    case "succeeded":
      return "Finished";
    case "failed":
      return run.exitCode == null ? "Failed" : `Failed (exit ${run.exitCode})`;
    case "stopped":
      return "Stopped";
    case "timedOut":
      return "Stopped after its timeout";
  }
}

/**
 * Wait for a run to finish, in steps short enough to notice a cancel. Resolves with the last record seen, finished
 * or not (when `cancelled()` turned true or `limitMs` passed).
 */
export async function waitForRun(
  run: ActionRun,
  {
    cancelled = () => false,
    limitMs = 60 * 60_000,
    wait = waitProjectAction,
  }: {
    cancelled?: () => boolean;
    limitMs?: number;
    wait?: typeof waitProjectAction;
  } = {},
): Promise<ActionRun> {
  let latest = run;
  const deadline = Date.now() + limitMs;
  while (!runFinished(latest) && !cancelled() && Date.now() < deadline) {
    latest = await wait(run.id, Math.min(2_000, Math.max(0, deadline - Date.now())));
  }
  return latest;
}
