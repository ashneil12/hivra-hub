import { useState } from "react";
import { ChevronRight, Square, Ungroup } from "../../../shared/ui/icons";
import { Shimmer } from "../../../shared/ui/Shimmer";
import { ProjectMascot } from "../../projects/ui/ProjectMascot";
import { formatTokens } from "../model/contextUsage";
import { AgentMarkdown } from "./AgentMarkdown";
import type { Block } from "../model/session";
import {
  WORKFLOW_AGENT_STATE_LABEL,
  workflowStatusLine,
  type WorkflowAgent,
  type WorkflowPhase,
  type WorkflowRunMeta,
} from "../model/workflowRun";

/** Stop one workflow run: whether the harness took the stop, or nothing to say. */
export type StopWorkflow = (taskId: string) => Promise<boolean> | void;

/**
 * One row for a whole workflow run, pinned like a subagent while it works:
 * its name, the phase it is in and how many agents are done, with one Stop
 * for the run. Opened, it lists each phase and every agent's state, so a
 * busy run reads as busy and a stalled one as stalled. An agent's row opens
 * like a subagent's onto what the provider says of it: what it was asked, how
 * far it has got, and what it handed back or why it failed.
 */
export function WorkflowRunPanel({
  block,
  live = false,
  onStop,
  cwd,
  onOpenFile,
}: {
  block: Block;
  live?: boolean;
  /**
   * Stops the whole run, every agent in it. Its promise says whether the
   * harness took the stop; a caller with nothing to say returns nothing.
   */
  onStop?: StopWorkflow;
  cwd?: string;
  onOpenFile?: (path: string) => void;
}) {
  const run = block.workflowRun;
  const running = live && (run ? run.status === "running" : true);
  const [override, setOverride] = useState<boolean | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopFailed, setStopFailed] = useState<string | null>(null);
  // A run that went wrong anywhere opens on its own, so the failure shows.
  const attention =
    !!run &&
    (run.status === "failed" ||
      run.status === "stopped" ||
      run.agents.some((agent) => agent.state === "failed"));
  const open = override ?? (running || attention);
  const name =
    run?.name ?? run?.description ?? block.tool?.title ?? block.text ?? "Workflow";
  const status = run ? workflowStatusLine(run) : "starting";
  const failed = run?.status === "failed";
  const canStop = running && !!run && !!onStop && !stopping;

  return (
    <div className="flex min-w-0 flex-col" data-workflow-run={run?.taskId}>
      <div
        className={`group -mx-1.5 flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 transition-colors duration-200 hover:bg-content/8 ${
          open ? "bg-content/8" : ""
        }`}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? `Hide ${name}'s agents` : `Show ${name}'s agents`}
          title={run?.description ?? name}
          onClick={() => setOverride(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Ungroup
            className={`size-3.5 shrink-0 ${failed ? "text-red-400" : running ? "text-content/70" : "text-content/45"}`}
            strokeWidth={1.75}
          />
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            {running ? (
              <Shimmer className="min-w-0 truncate font-sans text-sm" duration={1.6}>
                {name}
              </Shimmer>
            ) : (
              <span
                className={`min-w-0 truncate font-sans text-sm ${failed ? "text-red-400" : "text-content/75 group-hover:text-content"}`}
              >
                {name}
              </span>
            )}
            <span
              className="shrink-0 truncate font-sans text-[12px] text-content/40"
              data-workflow-status
            >
              {status}
            </span>
          </span>
          <ChevronRight
            className={`size-3.5 shrink-0 text-content/35 transition-transform duration-200 group-hover:text-content/60 ${open ? "rotate-90" : ""}`}
            strokeWidth={1.75}
          />
        </button>
        {canStop ? (
          <button
            type="button"
            title="Stop this workflow and every agent in it"
            aria-label={`Stop ${name}`}
            data-workflow-stop
            onClick={() => {
              setStopping(true);
              setStopFailed(null);
              const outcome = onStop?.(run.taskId);
              if (!outcome) return;
              const failed = (why: string) => {
                setStopping(false);
                setStopFailed(why);
              };
              outcome.then(
                (stopped) => {
                  if (stopped === false)
                    failed("Couldn't stop it: Claude Code isn't running this workflow any more.");
                },
                (error: unknown) =>
                  failed(`Couldn't stop it: ${error instanceof Error ? error.message : String(error)}`),
              );
            }}
            className="flex shrink-0 items-center gap-1 rounded-md bg-content/8 px-2 py-0.5 text-[11px] text-content/75 hover:bg-content/14 hover:text-content"
          >
            <Square className="size-2 fill-current" strokeWidth={0} />
            Stop
          </button>
        ) : stopping && running ? (
          <span className="shrink-0 text-[11px] text-content/45">Stopping…</span>
        ) : null}
      </div>
      {stopFailed && running ? (
        <div
          role="status"
          data-workflow-stop-failed
          className="pl-6 font-sans text-[12px] text-red-400"
        >
          {stopFailed}
        </div>
      ) : null}
      <div className="zen-phase-body" data-open={open}>
        {open && run ? (
          <WorkflowPhases run={run} live={running} cwd={cwd} onOpenFile={onOpenFile} />
        ) : null}
      </div>
    </div>
  );
}

function WorkflowPhases({
  run,
  live,
  cwd,
  onOpenFile,
}: {
  run: WorkflowRunMeta;
  live: boolean;
  cwd?: string;
  onOpenFile?: (path: string) => void;
}) {
  const groups = phaseGroups(run);
  if (groups.length === 0) {
    return (
      <div className="py-1 pl-6 font-sans text-[12px] text-content/45">
        {run.summary ?? "No agents yet"}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1 py-1 pl-6">
      {groups.map(({ phase, agents }) => (
        <div key={phase.index} className="flex min-w-0 flex-col" data-workflow-phase={phase.title}>
          <div className="font-sans text-[11px] uppercase tracking-wide text-content/40">
            {phase.title}
            {agents.length > 0 ? (
              <span className="normal-case tracking-normal">
                {" "}
                · {agents.filter((agent) => agent.state === "done").length}/{agents.length}
              </span>
            ) : null}
          </div>
          {agents.map((agent) => (
            <WorkflowAgentRow
              key={agent.index}
              agent={agent}
              live={live}
              cwd={cwd}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      ))}
      {!live && run.summary ? (
        <div className="font-sans text-[12px] text-content/45">{run.summary}</div>
      ) : null}
    </div>
  );
}

/**
 * One agent of the run, opening like a subagent's row. An agent that failed
 * opens itself, so its reason shows; a click takes the row over from there.
 */
function WorkflowAgentRow({
  agent,
  live,
  cwd,
  onOpenFile,
}: {
  agent: WorkflowAgent;
  live: boolean;
  cwd?: string;
  onOpenFile?: (path: string) => void;
}) {
  const [override, setOverride] = useState<boolean | null>(null);
  const working = live && agent.state === "working";
  const failed = agent.state === "failed";
  const open = override ?? (failed && !!agent.error);
  const opens = !!(agent.prompt || agent.result || agent.error);
  const meta = [
    agent.tokens ? `${formatTokens(agent.tokens)} tokens` : undefined,
    agent.durationMs ? `${Math.max(1, Math.round(agent.durationMs / 1000))}s` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const row = (
    <>
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <ProjectMascot
          project={agent.label}
          active={working}
          className={`size-3 shrink-0 ${failed ? "text-red-400" : working ? "text-content/70" : "text-content/40"}`}
        />
      </span>
      <span
        className={`min-w-0 flex-1 truncate font-sans text-[13px] ${failed ? "text-red-400" : agent.state === "done" ? "text-content/60" : "text-content/80"}`}
      >
        {agent.label}
        {agent.attempt && agent.attempt > 1 ? (
          <span className="text-content/40"> (try {agent.attempt})</span>
        ) : null}
      </span>
      {meta ? (
        <span className="shrink-0 font-sans text-[11px] text-content/35">{meta}</span>
      ) : null}
      <span
        className={`w-14 shrink-0 text-right font-sans text-[11px] ${failed ? "text-red-400" : working ? "text-content/70" : "text-content/40"}`}
      >
        {WORKFLOW_AGENT_STATE_LABEL[agent.state]}
      </span>
    </>
  );
  if (!opens) {
    return (
      <div
        className="flex min-w-0 items-center gap-2 py-0.5"
        title={agent.label}
        data-workflow-agent={agent.label}
        data-workflow-agent-state={agent.state}
      >
        {row}
        <span className="size-3.5 shrink-0" />
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? `Hide ${agent.label}'s work` : `Show ${agent.label}'s work`}
        title={agent.label}
        onClick={() => setOverride(!open)}
        data-workflow-agent={agent.label}
        data-workflow-agent-state={agent.state}
        className={`group -mx-1.5 flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-0.5 text-left transition-colors duration-200 hover:bg-content/8 ${
          open ? "bg-content/8" : ""
        }`}
      >
        {row}
        <ChevronRight
          className={`size-3.5 shrink-0 text-content/35 transition-transform duration-200 group-hover:text-content/60 ${open ? "rotate-90" : ""}`}
          strokeWidth={1.75}
        />
      </button>
      <div className="zen-phase-body" data-open={open}>
        {open ? (
          <WorkflowAgentWork agent={agent} live={live} cwd={cwd} onOpenFile={onOpenFile} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * What the provider says of one agent, all it says: Claude Code streams an
 * agent's brief, its counts and its report, not the steps between them.
 */
function WorkflowAgentWork({
  agent,
  live,
  cwd,
  onOpenFile,
}: {
  agent: WorkflowAgent;
  live: boolean;
  cwd?: string;
  onOpenFile?: (path: string) => void;
}) {
  const progress = live ? agentProgress(agent, Date.now()) : undefined;
  return (
    <div className="flex min-w-0 flex-col pb-1" data-workflow-agent-work={agent.label}>
      {agent.prompt ? (
        <div
          className="zen-phase-step whitespace-pre-wrap break-words py-1 font-sans text-[12px] leading-5 text-content/50"
          data-workflow-agent-prompt
        >
          {agent.prompt}
        </div>
      ) : null}
      {progress ? (
        <div
          className="zen-phase-step py-1 font-sans text-[12px] text-content/45"
          data-workflow-agent-progress
        >
          {progress}
        </div>
      ) : null}
      {agent.state === "failed" && agent.error ? (
        <div className="zen-phase-step py-1" data-workflow-agent-report>
          <pre className="min-w-0 whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-red-400/80">
            {agent.error}
          </pre>
        </div>
      ) : agent.result ? (
        <div className="zen-phase-step py-1" data-workflow-agent-report>
          <AgentMarkdown text={agent.result} cwd={cwd} onOpenFile={onOpenFile} />
        </div>
      ) : null}
    </div>
  );
}

/** How far a running agent has got, by the counts it reports: "3 tool calls · active 12s ago". */
function agentProgress(agent: WorkflowAgent, now: number): string | undefined {
  if (agent.state === "queued") return "Waiting to start";
  if (agent.state !== "working") return undefined;
  const parts: string[] = [];
  if (agent.toolCalls) parts.push(`${agent.toolCalls} tool call${agent.toolCalls === 1 ? "" : "s"}`);
  if (agent.lastProgressAt !== undefined) {
    const seconds = Math.max(0, Math.round((now - agent.lastProgressAt) / 1000));
    const minutes = Math.floor(seconds / 60);
    parts.push(
      seconds < 5
        ? "active just now"
        : seconds < 120
          ? `active ${seconds}s ago`
          : minutes < 120
            ? `active ${minutes}m ago`
            : `active ${Math.floor(minutes / 60)}h ago`,
    );
  }
  return parts.length ? parts.join(" · ") : "Working";
}

/** Phases in order with their agents; agents with no phase go last. */
function phaseGroups(
  run: WorkflowRunMeta,
): Array<{ phase: WorkflowPhase; agents: WorkflowAgent[] }> {
  const groups = new Map<number, { phase: WorkflowPhase; agents: WorkflowAgent[] }>();
  for (const phase of run.phases) groups.set(phase.index, { phase, agents: [] });
  const loose: WorkflowAgent[] = [];
  for (const agent of run.agents) {
    if (agent.phaseIndex === undefined) {
      loose.push(agent);
      continue;
    }
    const group = groups.get(agent.phaseIndex) ?? {
      phase: { index: agent.phaseIndex, title: agent.phaseTitle ?? `Phase ${agent.phaseIndex}` },
      agents: [],
    };
    group.agents.push(agent);
    groups.set(agent.phaseIndex, group);
  }
  const ordered = [...groups.values()].sort((a, b) => a.phase.index - b.phase.index);
  if (loose.length > 0) {
    ordered.push({ phase: { index: Number.MAX_SAFE_INTEGER, title: "Agents" }, agents: loose });
  }
  return ordered;
}
