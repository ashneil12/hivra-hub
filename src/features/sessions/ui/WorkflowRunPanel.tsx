import { useState } from "react";
import { ChevronRight, Square, Ungroup } from "../../../shared/ui/icons";
import { Shimmer } from "../../../shared/ui/Shimmer";
import { ProjectMascot } from "../../projects/ui/ProjectMascot";
import { formatTokens } from "../model/contextUsage";
import type { Block } from "../model/session";
import {
  WORKFLOW_AGENT_STATE_LABEL,
  workflowStatusLine,
  type WorkflowAgent,
  type WorkflowPhase,
  type WorkflowRunMeta,
} from "../model/workflowRun";

/**
 * One row for a whole workflow run, pinned like a subagent while it works:
 * its name, the phase it is in and how many agents are done, with one Stop
 * for the run. Opened, it lists each phase and every agent's state, so a
 * busy run reads as busy and a stalled one as stalled.
 */
export function WorkflowRunPanel({
  block,
  live = false,
  onStop,
}: {
  block: Block;
  live?: boolean;
  /** Stops the whole run, every agent in it. */
  onStop?: (taskId: string) => void;
}) {
  const run = block.workflowRun;
  const running = live && (run ? run.status === "running" : true);
  const [override, setOverride] = useState<boolean | null>(null);
  const [stopping, setStopping] = useState(false);
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
              onStop?.(run.taskId);
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
      <div className="zen-phase-body" data-open={open}>
        {open && run ? <WorkflowPhases run={run} live={running} /> : null}
      </div>
    </div>
  );
}

function WorkflowPhases({ run, live }: { run: WorkflowRunMeta; live: boolean }) {
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
            <WorkflowAgentRow key={agent.index} agent={agent} live={live} />
          ))}
        </div>
      ))}
      {!live && run.summary ? (
        <div className="font-sans text-[12px] text-content/45">{run.summary}</div>
      ) : null}
    </div>
  );
}

function WorkflowAgentRow({ agent, live }: { agent: WorkflowAgent; live: boolean }) {
  const working = live && agent.state === "working";
  const failed = agent.state === "failed";
  const meta = [
    agent.tokens ? `${formatTokens(agent.tokens)} tokens` : undefined,
    agent.durationMs ? `${Math.max(1, Math.round(agent.durationMs / 1000))}s` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className="flex min-w-0 items-center gap-2 py-0.5"
      title={agent.error ?? agent.result ?? agent.label}
      data-workflow-agent={agent.label}
      data-workflow-agent-state={agent.state}
    >
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
    </div>
  );
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
