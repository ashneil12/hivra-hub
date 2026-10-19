/**
 * A workflow run: one coordinator task that fans work out to agents in
 * phases (Claude Code's `Workflow` tool). Its chat row and Being built read
 * this shape, never the provider's frames, so a run reads the same however it
 * was reported. Held on the tool block that launched the run.
 *
 * Merge rules come from T3 Code's claudeWorkflowProgress (MIT): frames are
 * snapshots keyed by index, a newer attempt replaces an older one, and a
 * finished agent never slides back to working because a late frame said so.
 */

export type WorkflowAgentState =
  | "queued"
  | "working"
  | "done"
  | "failed"
  | "skipped";

export type WorkflowAgent = {
  index: number;
  label: string;
  state: WorkflowAgentState;
  phaseIndex?: number;
  phaseTitle?: string;
  model?: string;
  attempt?: number;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  /** Epoch ms of the agent's newest activity, when the provider says. */
  lastProgressAt?: number;
  /** The start of what it handed back. */
  result?: string;
  /** Why it failed. */
  error?: string;
};

export type WorkflowPhase = { index: number; title: string };

export type WorkflowRunStatus = "running" | "completed" | "failed" | "stopped";

export type WorkflowRunMeta = {
  /** Provider task id; Stop stops this. */
  taskId: string;
  /** The script's own name, e.g. "review-changes". */
  name?: string;
  /** One line on what the run does. */
  description?: string;
  status: WorkflowRunStatus;
  phases: WorkflowPhase[];
  agents: WorkflowAgent[];
  /** Epoch ms the run started, as seen by the app. */
  startedAt?: number;
  /** Epoch ms of the run's newest frame. */
  updatedAt?: number;
  totalTokens?: number;
  toolCalls?: number;
  durationMs?: number;
  /** What the provider said when the run ended. */
  summary?: string;
};

/** Past this an agent's preview is a paragraph, not a line. */
const PREVIEW_CHARS = 280;

export function clipPreview(text: string | undefined): string | undefined {
  const flat = text?.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length <= PREVIEW_CHARS
    ? flat
    : `${flat.slice(0, PREVIEW_CHARS - 1).trimEnd()}…`;
}

function finished(state: WorkflowAgentState): boolean {
  return state === "done" || state === "failed" || state === "skipped";
}

/**
 * Fold one frame's phases and agents into what the run already knew. Agents
 * missing from the frame keep their last state.
 */
export function mergeWorkflowFrame(
  previous: WorkflowRunMeta,
  frame: { phases: WorkflowPhase[]; agents: WorkflowAgent[] },
): WorkflowRunMeta {
  const phases = new Map(previous.phases.map((phase) => [phase.index, phase]));
  for (const phase of frame.phases) phases.set(phase.index, phase);
  const agents = new Map(previous.agents.map((agent) => [agent.index, agent]));
  for (const agent of frame.agents) {
    const prior = agents.get(agent.index);
    const attempt = agent.attempt ?? prior?.attempt ?? 1;
    const priorAttempt = prior?.attempt ?? 1;
    // An older attempt reporting late says nothing about the current one.
    if (prior && attempt < priorAttempt) continue;
    const restarted = prior !== undefined && attempt > priorAttempt;
    const regressed =
      prior !== undefined &&
      !restarted &&
      ((finished(prior.state) && agent.state !== prior.state) ||
        (prior.state === "working" && agent.state === "queued"));
    agents.set(
      agent.index,
      regressed
        ? { ...agent, ...prior }
        : {
            ...(restarted
              ? {
                  ...(prior.phaseIndex !== undefined
                    ? { phaseIndex: prior.phaseIndex }
                    : {}),
                  ...(prior.phaseTitle ? { phaseTitle: prior.phaseTitle } : {}),
                }
              : prior),
            ...agent,
          },
    );
  }
  return {
    ...previous,
    phases: [...phases.values()].sort((a, b) => a.index - b.index),
    agents: [...agents.values()].sort((a, b) => a.index - b.index),
  };
}

export type WorkflowCounts = {
  total: number;
  done: number;
  working: number;
  queued: number;
  failed: number;
};

export function workflowCounts(run: WorkflowRunMeta): WorkflowCounts {
  const counts: WorkflowCounts = {
    total: run.agents.length,
    done: 0,
    working: 0,
    queued: 0,
    failed: 0,
  };
  for (const agent of run.agents) {
    if (agent.state === "done") counts.done += 1;
    else if (agent.state === "working") counts.working += 1;
    else if (agent.state === "queued") counts.queued += 1;
    else counts.failed += 1;
  }
  return counts;
}

/**
 * The phase the run is in: the newest phase with an agent still at work, else
 * the newest phase any agent has reached, else the first one the script named.
 */
export function currentPhase(run: WorkflowRunMeta): WorkflowPhase | undefined {
  const byIndex = new Map(run.phases.map((phase) => [phase.index, phase]));
  const phaseOf = (agent: WorkflowAgent): WorkflowPhase | undefined =>
    agent.phaseIndex !== undefined
      ? (byIndex.get(agent.phaseIndex) ??
        (agent.phaseTitle
          ? { index: agent.phaseIndex, title: agent.phaseTitle }
          : undefined))
      : undefined;
  const active = run.agents.filter(
    (agent) => agent.state === "working" || agent.state === "queued",
  );
  const pick = (agents: WorkflowAgent[]) => {
    let best: WorkflowPhase | undefined;
    for (const agent of agents) {
      const phase = phaseOf(agent);
      if (phase && (!best || phase.index > best.index)) best = phase;
    }
    return best;
  };
  return pick(active) ?? pick(run.agents) ?? run.phases[0];
}

/** Newest activity anywhere in the run, epoch ms. */
export function workflowLastActivity(run: WorkflowRunMeta): number | undefined {
  let latest = run.updatedAt;
  for (const agent of run.agents) {
    if (
      agent.lastProgressAt !== undefined &&
      (latest === undefined || agent.lastProgressAt > latest)
    ) {
      latest = agent.lastProgressAt;
    }
  }
  return latest;
}

/** "Verify · 2 of 3 agents done · 1 failed" for the run's chat row. */
export function workflowStatusLine(run: WorkflowRunMeta): string {
  const counts = workflowCounts(run);
  const parts: string[] = [];
  if (run.status === "running") {
    const phase = currentPhase(run);
    if (phase) parts.push(phase.title);
  } else {
    parts.push(
      run.status === "completed"
        ? "Finished"
        : run.status === "stopped"
          ? "Stopped"
          : "Failed",
    );
  }
  if (counts.total > 0) {
    parts.push(
      `${counts.done} of ${counts.total} agent${counts.total === 1 ? "" : "s"} done`,
    );
  } else if (run.status === "running") {
    parts.push("starting");
  }
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  return parts.join(" · ");
}

/**
 * The one line Being built shows for a Lead in a workflow, e.g.
 * "running workflow: Verify (3/5 agents)": done out of every agent the run has
 * started so far.
 */
export function workflowActivityLine(run: WorkflowRunMeta): string {
  const counts = workflowCounts(run);
  const phase = currentPhase(run)?.title ?? run.name ?? "starting";
  return counts.total > 0
    ? `running workflow: ${phase} (${counts.done}/${counts.total} agents)`
    : `running workflow: ${phase}`;
}

export const WORKFLOW_AGENT_STATE_LABEL: Record<WorkflowAgentState, string> = {
  queued: "queued",
  working: "working",
  done: "done",
  failed: "failed",
  skipped: "skipped",
};
