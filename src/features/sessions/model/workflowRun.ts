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
  /**
   * What it was asked to do, as far as the provider shows it. Claude Code
   * streams this, the agent's counts and what it handed back, never its steps.
   */
  prompt?: string;
  /** What it handed back, as far as the provider shows it. */
  result?: string;
  /** Why it failed. */
  error?: string;
};

export type WorkflowPhase = { index: number; title: string };

export type WorkflowRunStatus = "running" | "completed" | "failed" | "stopped";

/**
 * Agents a run left out to stay bounded (MAX_WORKFLOW_AGENTS): how many in
 * each state, and the index every one of them is below, so a snapshot that
 * repeats them neither brings them back nor counts them twice.
 */
export type WorkflowDroppedAgents = Partial<Record<WorkflowAgentState, number>> & {
  below: number;
};

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
  /** Agents left out of `agents` to keep the run bounded; still counted. */
  dropped?: WorkflowDroppedAgents;
};

/**
 * How many agents a run keeps, the way a subagent keeps MAX_AGENT_STEPS
 * (core/apply.ts): a run can fan out to thousands, and the run is saved with
 * its block. Those at work and the newest finished stay; the rest are counted.
 */
export const MAX_WORKFLOW_AGENTS = 300;

/** What an agent was asked or handed back, kept to read in full when its row is opened. */
export const AGENT_TEXT_CHARS = 4000;

/** An agent's prompt or report as written (its lines kept), up to what a row opens onto. */
export function agentText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= AGENT_TEXT_CHARS
    ? trimmed
    : `${trimmed.slice(0, AGENT_TEXT_CHARS - 1).trimEnd()}…`;
}

function finished(state: WorkflowAgentState): boolean {
  return state === "done" || state === "failed" || state === "skipped";
}

/**
 * Keep at most MAX_WORKFLOW_AGENTS, leaving out the oldest first: done and
 * skipped agents, then failed ones, then (only past that) ones still at work.
 * `agents` is in index order, and so is what comes back.
 */
function boundAgents(
  agents: WorkflowAgent[],
  dropped: WorkflowDroppedAgents | undefined,
): { agents: WorkflowAgent[]; dropped?: WorkflowDroppedAgents } {
  const over = agents.length - MAX_WORKFLOW_AGENTS;
  if (over <= 0) return { agents, ...(dropped ? { dropped } : {}) };
  const rank = (agent: WorkflowAgent) =>
    agent.state === "done" || agent.state === "skipped" ? 0 : agent.state === "failed" ? 1 : 2;
  const leaving = new Set(
    [...agents].sort((a, b) => rank(a) - rank(b) || a.index - b.index).slice(0, over),
  );
  const next: WorkflowDroppedAgents = { ...(dropped ?? { below: 0 }) };
  for (const agent of leaving) {
    next[agent.state] = (next[agent.state] ?? 0) + 1;
    next.below = Math.max(next.below, agent.index + 1);
  }
  return { agents: agents.filter((agent) => !leaving.has(agent)), dropped: next };
}

/** Left-out agents still at work, settled the way the kept ones are. */
export function settleDroppedAgents(
  dropped: WorkflowDroppedAgents | undefined,
  state: WorkflowAgentState,
): WorkflowDroppedAgents | undefined {
  if (!dropped || !(dropped.working || dropped.queued)) return dropped;
  const { working = 0, queued = 0, ...rest } = dropped;
  const next: WorkflowDroppedAgents = { ...rest };
  next[state] = (next[state] ?? 0) + working + queued;
  return next;
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
  const below = previous.dropped?.below ?? 0;
  for (const agent of frame.agents) {
    const prior = agents.get(agent.index);
    // Left out already: a snapshot repeating it changes nothing.
    if (!prior && agent.index < below) continue;
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
  const { dropped: _dropped, ...rest } = previous;
  return {
    ...rest,
    phases: [...phases.values()].sort((a, b) => a.index - b.index),
    ...boundAgents(
      [...agents.values()].sort((a, b) => a.index - b.index),
      previous.dropped,
    ),
  };
}

export type WorkflowCounts = {
  total: number;
  done: number;
  working: number;
  queued: number;
  failed: number;
  /** Skipped by the user, or left unrun when the run was stopped. */
  skipped: number;
};

export function workflowCounts(run: WorkflowRunMeta): WorkflowCounts {
  const counts: WorkflowCounts = {
    total: run.agents.length,
    done: 0,
    working: 0,
    queued: 0,
    failed: 0,
    skipped: 0,
  };
  for (const agent of run.agents) {
    if (agent.state === "done") counts.done += 1;
    else if (agent.state === "working") counts.working += 1;
    else if (agent.state === "queued") counts.queued += 1;
    else if (agent.state === "skipped") counts.skipped += 1;
    else counts.failed += 1;
  }
  for (const state of AGENT_STATE_LIST) {
    const left = run.dropped?.[state] ?? 0;
    counts[state] += left;
    counts.total += left;
  }
  return counts;
}

/** Agents a run counts but no longer lists. */
export function droppedAgentCount(run: WorkflowRunMeta): number {
  return AGENT_STATE_LIST.reduce((sum, state) => sum + (run.dropped?.[state] ?? 0), 0);
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
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
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

const AGENT_STATE_LIST: WorkflowAgentState[] = ["queued", "working", "done", "failed", "skipped"];
const AGENT_STATES = new Set<WorkflowAgentState>(AGENT_STATE_LIST);
const RUN_STATUSES = new Set<WorkflowRunStatus>(["running", "completed", "failed", "stopped"]);

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const str = (value: unknown, max = 400): string | undefined =>
  typeof value === "string" && value.trim() ? value.slice(0, max) : undefined;

/**
 * A run as saved with its block, checked field by field. On `hydrate` (a
 * transcript loaded after a restart) a run still marked running is stopped:
 * the Claude Code process that ran it is gone.
 */
export function parseWorkflowRun(
  value: unknown,
  options?: { hydrate?: boolean },
): WorkflowRunMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const taskId = str(record.taskId, 200);
  const status = record.status as WorkflowRunStatus;
  if (!taskId || !RUN_STATUSES.has(status)) return null;
  const phases = (Array.isArray(record.phases) ? record.phases : []).flatMap((entry) => {
    const row = entry as Record<string, unknown> | null;
    const index = num(row?.index);
    const title = str(row?.title, 200);
    return index !== undefined && title ? [{ index, title }] : [];
  });
  const agents = (Array.isArray(record.agents) ? record.agents : []).flatMap((entry): WorkflowAgent[] => {
    const row = entry as Record<string, unknown> | null;
    const index = num(row?.index);
    const label = str(row?.label, 200);
    const state = row?.state as WorkflowAgentState;
    if (index === undefined || !label || !AGENT_STATES.has(state)) return [];
    const agent: WorkflowAgent = { index, label, state };
    const phaseIndex = num(row?.phaseIndex);
    if (phaseIndex !== undefined) agent.phaseIndex = phaseIndex;
    for (const key of ["phaseTitle", "model"] as const) {
      const text = str(row?.[key]);
      if (text) agent[key] = text;
    }
    for (const key of ["prompt", "result", "error"] as const) {
      const text = agentText(str(row?.[key], AGENT_TEXT_CHARS + 1));
      if (text) agent[key] = text;
    }
    for (const key of ["attempt", "tokens", "toolCalls", "durationMs", "lastProgressAt"] as const) {
      const n = num(row?.[key]);
      if (n !== undefined) agent[key] = n;
    }
    return [agent];
  });
  const droppedRecord =
    record.dropped && typeof record.dropped === "object" && !Array.isArray(record.dropped)
      ? (record.dropped as Record<string, unknown>)
      : undefined;
  let saved: WorkflowDroppedAgents | undefined;
  const below = num(droppedRecord?.below);
  if (below !== undefined) {
    saved = { below };
    for (const state of AGENT_STATE_LIST) {
      const n = num(droppedRecord?.[state]);
      if (n) saved[state] = Math.floor(n);
    }
  }
  const run: WorkflowRunMeta = {
    taskId,
    status,
    phases,
    ...boundAgents(
      agents.sort((a, b) => a.index - b.index),
      saved,
    ),
  };
  for (const key of ["name", "description", "summary"] as const) {
    const text = str(record[key]);
    if (text) run[key] = text;
  }
  for (const key of ["startedAt", "updatedAt", "totalTokens", "toolCalls", "durationMs"] as const) {
    const n = num(record[key]);
    if (n !== undefined) run[key] = n;
  }
  if (options?.hydrate && run.status === "running") {
    const dropped = settleDroppedAgents(run.dropped, "skipped");
    return {
      ...run,
      status: "stopped",
      agents: run.agents.map((agent) =>
        agent.state === "working" || agent.state === "queued" ? { ...agent, state: "skipped" } : agent,
      ),
      ...(dropped ? { dropped } : {}),
    };
  }
  return run;
}
