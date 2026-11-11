import { useState, useSyncExternalStore, type ReactNode } from "react";
import { findModel } from "../../sessions/model/models";
import {
  describeGoalReport,
  lastCheckRun,
  orchestrator,
  type OrchestrationRun,
  type OrchestrationTask,
} from "../model/orchestration";
import { closingUsageLine } from "../model/closingUsage";
import {
  goalCheckLine,
  type GoalCheckRun,
  type GoalNodeReport,
} from "../model/orchestrationGoal";
import type { OrchestrationProposal } from "../model/orchestrationPlan";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleDashed,
  CircleHelp,
} from "../../../shared/ui/icons";

/** A run this size or smaller opens every layer and node; a bigger one folds what is quiet. */
const SMALL_GRAPH = 12;

type NodeState =
  | "queued"
  | "running"
  | "stopping"
  | "completed"
  | "accepted"
  | "failed"
  | "blocked"
  | "interrupted"
  | "cancelled";

/** One task as the graph draws it, whether it comes from a run or from a plan not started yet. */
type GraphNode = {
  id: string;
  title: string;
  model: string;
  role: "build" | "verify";
  dependsOn: string[];
  state: NodeState;
  handoff: "none" | "read" | "unread";
  repairs?: string;
  cycle?: number;
  /** The node whose check found the work this extend-round node does. */
  extendFrom?: string;
  /** An irreversible step's reason, while the person has not answered it. */
  waiting?: string;
};

const STATE_LABEL: Record<NodeState, string> = {
  queued: "Queued",
  running: "Running",
  stopping: "Stopping",
  completed: "Done",
  accepted: "Accepted",
  failed: "Failed",
  blocked: "Blocked",
  interrupted: "Stopped",
  cancelled: "Cancelled",
};

const STATE_TONE: Record<NodeState, string> = {
  queued: "text-content/45",
  running: "text-accent",
  stopping: "text-accent",
  completed: "text-emerald-400",
  accepted: "text-emerald-400",
  failed: "text-amber-400",
  blocked: "text-amber-400",
  interrupted: "text-amber-400",
  cancelled: "text-content/45",
};

function stateOf(task: OrchestrationTask): NodeState {
  if (task.accepted) return "accepted";
  switch (task.status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "cancelling":
      return "stopping";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    case "interrupted":
      return "interrupted";
    case "cancelled":
      return "cancelled";
  }
}

const modelName = (model: string) => findModel(model)?.name ?? model;

function runNodes(run: OrchestrationRun): GraphNode[] {
  return run.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    model: modelName(task.model),
    role: task.role ?? "build",
    dependsOn: task.dependsOn,
    state: stateOf(task),
    handoff: task.handoff ? (task.handoff.read ? "read" : "unread") : "none",
    ...(task.repairs ? { repairs: task.repairs } : {}),
    ...(task.cycle ? { cycle: task.cycle } : {}),
    ...(task.extendFrom ? { extendFrom: task.extendFrom } : {}),
    ...(task.irreversible && !task.irreversibleAnswered
      ? { waiting: task.irreversibleReason ?? "This step cannot be undone." }
      : {}),
  }));
}

function planNodes(proposal: OrchestrationProposal): GraphNode[] {
  return proposal.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    model: modelName(task.model),
    role: task.role ?? "build",
    dependsOn: task.dependsOn,
    state: "queued",
    handoff: "none",
    ...(task.irreversible
      ? { waiting: task.irreversibleReason ?? "This step cannot be undone." }
      : {}),
  }));
}

/** The rules' layers, kept to tasks this run has, with anything they missed in a last row. */
function placeLayers(reported: string[][], nodes: GraphNode[]): string[][] {
  const known = new Set(nodes.map((node) => node.id));
  const placed = new Set<string>();
  const rows: string[][] = [];
  for (const layer of reported) {
    const row = layer.filter((id) => known.has(id) && !placed.has(id));
    for (const id of row) placed.add(id);
    if (row.length) rows.push(row);
  }
  const rest = nodes.map((node) => node.id).filter((id) => !placed.has(id));
  if (rest.length) rows.push(rest);
  return rows;
}

function checkWords(result: GoalCheckRun | undefined, before: boolean): string {
  if (!result) return "not run yet";
  if (result.outcome === "notRun")
    return "not run: it timed out or could not start";
  const by = result.layer ? ` (${result.layer})` : "";
  if (result.outcome === "passed")
    return `${before ? "passed before any work" : "passed"}${by}`;
  return `${before ? "failed before any work, as it should" : "failed"}${by}`;
}

function verdictLine(report: GoalNodeReport): { text: string; tone: string } {
  // A task no gate ever looked at is not a pass: the card says so beside the verdict rather than hiding it.
  const ungated = report.lint
    .filter((entry) => entry.startsWith("no_gates:"))
    .flatMap((entry) => entry.slice("no_gates:".length).split(","))
    .join(", ");
  const gate = ungated
    ? ` No gate ran on ${ungated}, so those were accepted without one.`
    : "";
  if (report.verdict === "verified")
    return {
      text: `Verified: the finish line passes and every task is accepted.${gate}`,
      tone: "text-emerald-400",
    };
  const reasons = report.reasons.length ? `: ${describeGoalReport(report)}.` : ".";
  return report.verdict === "failed"
    ? { text: `Not done${reasons}${gate}`, tone: "text-amber-400" }
    : { text: `Not verified yet${reasons}${gate}`, tone: "text-content/60" };
}

function glyph(node: GraphNode): ReactNode {
  if (node.waiting)
    return <CircleHelp className="size-3.5 text-amber-400" strokeWidth={1.75} />;
  switch (node.state) {
    case "accepted":
    case "completed":
      return <Check className="size-3.5 text-emerald-400" strokeWidth={2.25} />;
    case "running":
      return <CircleDashed className="size-3.5 animate-spin text-accent" strokeWidth={1.75} />;
    case "failed":
    case "blocked":
    case "interrupted":
      return <CircleAlert className="size-3.5 text-amber-400" strokeWidth={1.75} />;
    default:
      return <CircleDashed className="size-3.5 text-content/45" strokeWidth={1.75} />;
  }
}

const HANDOFF_WORDS = {
  none: "No handoff yet",
  read: "Handoff read",
  unread: "Handoff not read",
} as const;

/**
 * WP-91: the run's goal, finish line and live graph. A pure reader of the orchestrator store (the same hook the
 * neighbours use); the rules and the record live in `orchestration.ts` and Rust. Without a run it shows the plan's
 * own dependencies, so the card keeps what the "After" line used to say.
 */
export function GoalGraph({
  leadId,
  proposalId,
  run,
  proposal,
}: {
  leadId: string;
  proposalId?: string;
  run?: OrchestrationRun;
  proposal?: OrchestrationProposal;
}) {
  const runs = useSyncExternalStore(
    orchestrator.subscribe,
    orchestrator.snapshot,
    orchestrator.snapshot,
  );
  // The person's folds: a key is in `opened` or `closed` once they have chosen, and that choice beats the default.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const stored = runs.find(
    (entry) =>
      entry.leadId === leadId &&
      (proposalId === undefined || entry.proposalId === proposalId),
  );
  const current = run ?? stored;
  if (!current && !proposal) return null;

  const report = current?.goalReport;
  const nodes = current ? runNodes(current) : planNodes(proposal!);
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  // The rules' layers, in both cases: the run's own report, or the answer kept on a plan that has not started.
  const layers = placeLayers(
    current ? (report?.layers ?? []) : (proposal?.graph?.layers ?? []),
    nodes,
  );
  const big = nodes.length > SMALL_GRAPH;
  const isOpen = (key: string, auto: boolean) =>
    opened.has(key) || (!closed.has(key) && auto);
  const toggle = (key: string, open: boolean) => {
    setOpened((previous) => {
      const next = new Set(previous);
      if (open) next.delete(key);
      else next.add(key);
      return next;
    });
    setClosed((previous) => {
      const next = new Set(previous);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  };
  const goal = current?.goal || proposal?.goal || "";
  const check = current?.check ?? proposal?.check;
  const baseline = current?.baseline;
  const latest = current ? lastCheckRun(current) : undefined;
  const verdict = report ? verdictLine(report) : undefined;
  // WP-148: only a finished run's close names what the children used. A live run keeps the figure off.
  const usageLine =
    current?.status === "finished" ? closingUsageLine(current.closingUsage) : undefined;

  return (
    <section
      aria-label="Goal graph"
      data-goal-graph={current ? "run" : "plan"}
      className="border-t border-stroke px-3 py-2.5 font-sans"
    >
      <p className="text-[12px] leading-5 text-content/85" data-goal-goal>
        {goal || "No goal was written for this run."}
      </p>
      <div className="mt-1 space-y-0.5 text-[11px] leading-4 text-content/50">
        <p data-goal-check>Finish line · {goalCheckLine(check)}</p>
        {current && (
          <p data-goal-baseline>Before work · {checkWords(baseline, true)}</p>
        )}
        {current && (
          <p data-goal-latest>Latest check · {checkWords(latest, false)}</p>
        )}
        {verdict && (
          <p
            data-goal-verdict={report!.verdict}
            className={`${verdict.tone} pt-0.5`}
          >
            {verdict.text}
          </p>
        )}
        {usageLine && (
          <p data-goal-usage className="pt-0.5 text-content/60">
            {usageLine}
          </p>
        )}
      </div>
      <div className="mt-2 space-y-1.5">
        {layers.map((ids, index) => {
          const level = index + 1;
          const key = `layer:${level}`;
          const members = ids.map((id) => byId.get(id)!);
          const quiet = members.every((node) => node.state === "accepted");
          const open = isOpen(key, !big || !quiet);
          return (
            <div
              key={key}
              data-goal-layer={level}
              data-goal-folded={open ? undefined : ""}
            >
              <button
                type="button"
                aria-expanded={open}
                data-goal-layer-toggle={level}
                onClick={() => toggle(key, open)}
                className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[11px] text-content/50 hover:bg-content/8 hover:text-content/80"
              >
                {open ? (
                  <ChevronDown className="size-3" strokeWidth={1.75} />
                ) : (
                  <ChevronRight className="size-3" strokeWidth={1.75} />
                )}
                <span>Layer {level}</span>
                <span className="tabular-nums">
                  {open
                    ? `${members.length} ${members.length === 1 ? "task" : "tasks"}`
                    : quiet
                      ? `${members.length} accepted`
                      : `${members.length} folded`}
                </span>
              </button>
              {open && (
                <ul className="mt-0.5 flex flex-col pl-2">
                  {members.map((node) => {
                    const nodeKey = `node:${node.id}`;
                    const nodeOpen = isOpen(
                      nodeKey,
                      !big || node.state !== "accepted",
                    );
                    const repairs = nodes.filter((other) => other.repairs === node.id);
                    const extended = nodes.filter(
                      (other) => other.extendFrom === node.id,
                    );
                    const after = node.dependsOn
                      .map((id) => byId.get(id)?.title ?? id)
                      .join(", ");
                    const label = node.waiting
                      ? "Waiting for you"
                      : STATE_LABEL[node.state];
                    const tone = node.waiting ? "text-amber-400" : STATE_TONE[node.state];
                    return (
                      <li
                        key={node.id}
                        data-goal-node={node.id}
                        data-goal-state={node.state}
                        data-goal-role={node.role}
                        data-goal-verify={node.role === "verify" ? "" : undefined}
                        data-goal-repair={node.repairs}
                        data-goal-extend={node.extendFrom ? "" : undefined}
                        data-goal-handoff={node.handoff}
                        className="zen-phase-step orchestration-tree-step"
                      >
                        <button
                          type="button"
                          aria-expanded={nodeOpen}
                          aria-label={`Node details: ${node.title}`}
                          data-goal-node-toggle={node.id}
                          onClick={() => toggle(nodeKey, nodeOpen)}
                          className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left hover:bg-content/10"
                        >
                          <span className="grid size-3.5 shrink-0 place-items-center">
                            {glyph(node)}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[12px] text-content/80">
                            {node.title}
                          </span>
                          {node.role === "verify" && (
                            <span className="shrink-0 rounded bg-content/10 px-1 text-[10px] text-content/60">
                              Verify
                            </span>
                          )}
                          {node.repairs && (
                            <span className="shrink-0 rounded bg-content/10 px-1 text-[10px] text-content/60">
                              {node.cycle ? `Repair ${node.cycle}` : "Repair"}
                            </span>
                          )}
                          <span className={`shrink-0 text-[11px] ${tone}`}>
                            {label}
                          </span>
                        </button>
                        {nodeOpen && (
                          <div className="space-y-0.5 pb-1.5 pl-6 text-[11px] leading-4 text-content/45">
                            <p data-goal-model>{node.model}</p>
                            <p>{HANDOFF_WORDS[node.handoff]}</p>
                            {node.waiting && (
                              <p className="text-amber-400">
                                Waiting for you: {node.waiting}
                              </p>
                            )}
                            {!!node.dependsOn.length && (
                              <p data-goal-edge="after">After · {after}</p>
                            )}
                            {repairs.map((repair) => (
                              <p
                                key={repair.id}
                                data-goal-edge="repair"
                                data-goal-from={node.id}
                                data-goal-to={repair.id}
                              >
                                Repair{repair.cycle ? `, cycle ${repair.cycle}` : ""} ·{" "}
                                {repair.title}
                              </p>
                            ))}
                            {extended.map((added) => (
                              <p
                                key={added.id}
                                data-goal-edge="extend"
                                data-goal-from={node.id}
                                data-goal-to={added.id}
                              >
                                Extended · {added.title}
                              </p>
                            ))}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
