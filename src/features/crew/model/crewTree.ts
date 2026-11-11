// Hivra WP-119: a first mate, the crew, and the subagents already on those chats.
// Built from the open session and the crew rows. Nothing is read from a log file.

import { isAgentTool } from "../../../integrations/harness/core/preview";
import { sameProjectPath } from "../../projects/model/recents";
import type { AgentStep, Block } from "../../sessions/model/session";
import {
  isHiddenTool,
  isSubagentBlock,
  isToolBlock,
  subagentBrief,
  subagentName,
  toolCallLabel,
  toolCallState,
} from "../../sessions/model/transcriptActivity";
import { firstPlainLine, type CrewWorkerInput } from "./rows";
import { knownStatus, statusWord } from "./words";

export type CrewTreeSession = {
  id: string;
  title?: string | null;
  cwd?: string | null;
  firstMate?: boolean;
  busy?: boolean;
  blocks?: readonly unknown[] | null;
};

export type CrewTreeTool = {
  id: string;
  label: string;
  running: boolean;
  timing: string | null;
};

export type CrewTreeRole = "mate" | "worker" | "subagent";

export type CrewTreeNode = {
  id: string;
  role: CrewTreeRole;
  title: string;
  sessionId: string | null;
  brief: string | null;
  statusWord: string | null;
  latestTool: string | null;
  tools: CrewTreeTool[];
  children: CrewTreeNode[];
};

export type CrewTree = { root: CrewTreeNode | null };

/** Em dashes and en dashes never reach a person. A number range keeps a hyphen. */
function plain(value: string): string {
  return value
    .replace(/(\d)\s*[—–]\s*(?=\d)/g, "$1-")
    .replace(/[ \t]*[—–][ \t]*/g, ", ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[,\s]+|[,\s]+$/g, "")
    .trim();
}

function line(value: string | null | undefined, max = 160): string | null {
  const text = firstPlainLine(value, max);
  if (!text) return null;
  const cleaned = plain(text);
  return cleaned || null;
}

function cleanPath(value: string): string {
  return value.replace(/\r/g, "").trim();
}

function inProject(path: string | null | undefined, project: string): boolean {
  if (typeof path !== "string") return false;
  const cleaned = cleanPath(path);
  return cleaned !== "" && sameProjectPath(cleaned, project);
}

function timingPhrase(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return "under a second";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return seconds === 1 ? "1 second" : `${seconds} seconds`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

function timingOf(startedAt: unknown, updatedAt: unknown, running: boolean, now: number): string | null {
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt <= 0) return null;
  if (running) {
    if (typeof now === "number" && Number.isFinite(now) && now >= startedAt) return timingPhrase(now - startedAt);
    return "under a second";
  }
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt < startedAt) return null;
  return timingPhrase(updatedAt - startedAt);
}

function blocksOf(session: CrewTreeSession | undefined): Block[] {
  if (!session || !Array.isArray(session.blocks)) return [];
  const blocks: Block[] = [];
  for (const block of session.blocks) {
    if (!block || typeof block !== "object") continue;
    const row = block as Partial<Block>;
    if (typeof row.id !== "string" || !row.id || typeof row.role !== "string") continue;
    blocks.push(block as Block);
  }
  return blocks;
}

function lastPrompt(blocks: readonly Block[]): string | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (!block || block.role !== "user" || block.internal) continue;
    const text = line(block.text, 240);
    if (text) return text;
  }
  return null;
}

function stepRunning(status: string | undefined): boolean {
  const value = (status ?? "").toLowerCase();
  return value === "running" || value === "in_progress" || value === "pending";
}

function stepTools(steps: readonly AgentStep[] | undefined): CrewTreeTool[] {
  if (!Array.isArray(steps)) return [];
  const tools: CrewTreeTool[] = [];
  for (const step of steps) {
    if (!step || typeof step !== "object" || step.kind !== "tool") continue;
    if (isAgentTool(step.toolKind, step.text)) continue;
    const label = plain((step.text || step.toolKind || "Tool").trim()).slice(0, 160) || "Tool";
    const id = typeof step.id === "string" && step.id ? step.id : `step-${tools.length}`;
    tools.push({ id, label, running: stepRunning(step.status), timing: null });
  }
  return tools;
}

function latestToolLabel(
  tools: readonly CrewTreeTool[],
  working: boolean,
  childLabel: string | null,
  notice: string | null,
): string | null {
  if (!working) return null;
  for (let i = tools.length - 1; i >= 0; i--) {
    if (tools[i].running) return tools[i].label;
  }
  if (childLabel) return childLabel;
  if (tools.length > 0) return tools[tools.length - 1].label;
  return notice;
}

function toolsFromBlocks(blocks: readonly Block[], now: number): CrewTreeTool[] {
  const tools: CrewTreeTool[] = [];
  for (const block of blocks) {
    if (!isToolBlock(block) || isSubagentBlock(block) || isHiddenTool(block)) continue;
    const running = toolCallState(block) === "pending";
    tools.push({
      id: block.id,
      label: plain(toolCallLabel(block)) || "Tool",
      running,
      timing: timingOf(block.tool?.startedAt, block.tool?.updatedAt, running, now),
    });
  }
  return tools;
}

// WP-122: native CLI children are a separate list on the parent thread. This tree stays the first-mate crew.
function stepChildren(sessionId: string, blockId: string, steps: readonly AgentStep[] | undefined): CrewTreeNode[] {
  if (!Array.isArray(steps)) return [];
  const nodes: CrewTreeNode[] = [];
  for (const step of steps) {
    if (!step || step.kind !== "tool" || !isAgentTool(step.toolKind, step.text)) continue;
    const id = typeof step.id === "string" && step.id ? step.id : `step-${nodes.length}`;
    const running = stepRunning(step.status);
    const status = (step.status ?? "").toLowerCase();
    nodes.push({
      id: `step:${sessionId}:${blockId}:${id}`,
      role: "subagent",
      title: plain((step.text || "Subagent").replace(/^(?:agent|task|subagent)\b[\s:·-]*/i, "").trim()).slice(0, 120) || "Subagent",
      sessionId,
      brief: line(step.text, 240),
      statusWord: running ? "working" : status === "failed" || status === "error" ? "failed" : status ? "done" : null,
      latestTool: null,
      tools: [],
      children: [],
    });
  }
  return nodes;
}

function workflowChildren(sessionId: string, block: Block): CrewTreeNode[] {
  const agents = block.workflowRun?.agents;
  if (!Array.isArray(agents)) return [];
  const nodes: CrewTreeNode[] = [];
  for (const agent of agents) {
    if (!agent || typeof agent !== "object" || typeof agent.label !== "string") continue;
    const index = typeof agent.index === "number" && Number.isFinite(agent.index) ? agent.index : nodes.length;
    const state = agent.state;
    const title = plain(agent.label).slice(0, 120) || "Agent";
    const timing =
      typeof agent.durationMs === "number" && Number.isFinite(agent.durationMs) && agent.durationMs >= 0
        ? timingPhrase(agent.durationMs)
        : null;
    nodes.push({
      id: `workflow:${sessionId}:${block.id}:${index}`,
      role: "subagent",
      title,
      sessionId,
      brief: line(agent.prompt, 240),
      statusWord: state === "working" ? "working" : state === "failed" ? "failed" : state === "done" ? "done" : null,
      latestTool: null,
      tools: timing ? [{ id: `span:${block.id}:${index}`, label: state === "working" ? "In progress" : "Finished", running: state === "working", timing }] : [],
      children: [],
    });
  }
  return nodes;
}

function subagentNodes(sessionId: string, blocks: readonly Block[]): CrewTreeNode[] {
  const nodes: CrewTreeNode[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    if (!isSubagentBlock(block) || seen.has(block.id)) continue;
    seen.add(block.id);
    const tools = stepTools(block.agentRun?.steps);
    const children = [...workflowChildren(sessionId, block), ...stepChildren(sessionId, block.id, block.agentRun?.steps)];
    const pending = toolCallState(block) === "pending";
    const working = pending || tools.some((tool) => tool.running) || children.some((child) => child.statusWord === "working");
    const childLabel = [...children].reverse().find((child) => child.statusWord === "working")?.title ?? null;
    nodes.push({
      id: `subagent:${sessionId}:${block.id}`,
      role: "subagent",
      title: plain(subagentName(block)) || "Subagent",
      sessionId,
      brief: line(subagentBrief(block), 240),
      statusWord: working ? "working" : toolCallState(block) === "rejected" ? "failed" : "done",
      latestTool: latestToolLabel(tools, working, childLabel, null),
      tools,
      children,
    });
  }
  return nodes;
}

function stamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The crew of one project. The first mate is the root. Workers hang off the mate,
 * or off the worker that spawned them. A cycle, a missing parent, or a lead row
 * that is not itself shown goes on the mate. No workers and no first mate is an
 * empty tree, not a throw.
 */
export function crewTree(input: {
  project: string;
  workers?: readonly CrewWorkerInput[] | null;
  sessions?: readonly CrewTreeSession[] | null;
  now: number;
}): CrewTree {
  const project = cleanPath(input.project ?? "");
  if (!project || project === "~") return { root: null };
  const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : 0;

  const bySession = new Map<string, CrewTreeSession>();
  for (const session of input.sessions ?? []) {
    if (!session || typeof session.id !== "string" || !session.id.trim()) continue;
    bySession.set(session.id, session);
  }

  const byWorker = new Map<string, CrewWorkerInput>();
  for (const worker of input.workers ?? []) {
    if (!worker || typeof worker.id !== "string" || !worker.id.trim() || worker.follow === "lead") continue;
    if (!inProject(worker.project, project)) continue;
    const id = worker.id.trim();
    const previous = byWorker.get(id);
    if (!previous || stamp(worker.updatedAt) >= stamp(previous.updatedAt)) byWorker.set(id, { ...worker, id });
  }

  const mates = [...bySession.values()].filter(
    (session) => session.firstMate === true && typeof session.cwd === "string" && inProject(session.cwd, project),
  );
  const owners = new Map<string, number>();
  for (const worker of byWorker.values()) {
    const id = typeof worker.ownerSession === "string" ? worker.ownerSession.trim() : "";
    if (id) owners.set(id, (owners.get(id) ?? 0) + 1);
  }
  mates.sort((a, b) => (owners.get(b.id) ?? 0) - (owners.get(a.id) ?? 0) || a.id.localeCompare(b.id));

  let mateId: string | null = mates[0]?.id ?? null;
  if (!mateId && byWorker.size > 0) {
    let bestCount = 0;
    for (const [id, count] of owners) {
      if (count > bestCount || (count === bestCount && mateId !== null && id.localeCompare(mateId) < 0)) {
        mateId = id;
        bestCount = count;
      }
    }
  }
  // Workers with no recorded owner still need a root. An empty crew does not.
  const standIn = !mateId && byWorker.size > 0;
  if (!mateId && !standIn) return { root: null };
  if (!mateId) mateId = "crew";

  const mateSession = standIn ? undefined : bySession.get(mateId);
  const mateBlocks = blocksOf(mateSession);
  const mateSubs = subagentNodes(mateId, mateBlocks);
  const mateTools = toolsFromBlocks(mateBlocks, now);
  const mateChild = [...mateSubs].reverse().find((child) => child.statusWord === "working")?.title ?? null;
  const mateWorking = mateSession?.busy === true || mateTools.some((tool) => tool.running) || mateChild != null;

  const nodes = new Map<string, CrewTreeNode>();
  const parentOf = new Map<string, string | null>();
  const createdAt = new Map<string, number>();

  for (const worker of byWorker.values()) {
    const childId = typeof worker.childSession === "string" ? worker.childSession.trim() : "";
    const child = childId ? bySession.get(childId) : undefined;
    const blocks = blocksOf(child);
    const tools = toolsFromBlocks(blocks, now);
    const subs = childId ? subagentNodes(childId, blocks) : [];
    const childLabel = [...subs].reverse().find((node) => node.statusWord === "working")?.title ?? null;
    const status = knownStatus(worker.status);
    const working =
      status === "working" || child?.busy === true || tools.some((tool) => tool.running) || childLabel != null;
    const notice = line(worker.statusNotice, 160);
    nodes.set(worker.id, {
      id: worker.id,
      role: "worker",
      title: line(worker.title, 120) || "Untitled work",
      sessionId: childId || null,
      brief: line(worker.brief, 240) ?? line(worker.goal, 240) ?? lastPrompt(blocks),
      statusWord: status ? statusWord(status) : null,
      latestTool: latestToolLabel(tools, working, childLabel, notice),
      tools,
      children: subs,
    });
    const parent = typeof worker.parentId === "string" ? worker.parentId.trim() : "";
    parentOf.set(worker.id, parent || null);
    createdAt.set(worker.id, stamp(worker.createdAt));
  }

  function parentIdOf(id: string): string | null {
    const immediate = parentOf.get(id) ?? null;
    if (!immediate || !nodes.has(immediate) || immediate === id) return null;
    const seen = new Set<string>([id, immediate]);
    let current = parentOf.get(immediate) ?? null;
    let guard = 0;
    while (current && guard++ < 100) {
      if (seen.has(current)) return null;
      if (!nodes.has(current)) break;
      seen.add(current);
      current = parentOf.get(current) ?? null;
    }
    if (guard >= 100 && current) return null;
    return immediate;
  }

  const childIds = new Map<string, string[]>();
  const roots: string[] = [];
  for (const id of nodes.keys()) {
    const parent = parentIdOf(id);
    if (!parent) roots.push(id);
    else {
      const list = childIds.get(parent) ?? [];
      list.push(id);
      childIds.set(parent, list);
    }
  }
  const byAge = (a: string, b: string) => (createdAt.get(a) ?? 0) - (createdAt.get(b) ?? 0) || a.localeCompare(b);
  function attach(id: string): CrewTreeNode {
    const node = nodes.get(id)!;
    const kids = (childIds.get(id) ?? []).sort(byAge).map(attach);
    node.children = [...kids, ...node.children];
    return node;
  }

  const root: CrewTreeNode = {
    id: `mate:${mateId}`,
    role: "mate",
    title: line(mateSession?.title, 120) || "First mate",
    sessionId: standIn ? null : mateId,
    brief: lastPrompt(mateBlocks),
    statusWord: mateWorking ? "working" : null,
    latestTool: latestToolLabel(mateTools, mateWorking, mateChild, null),
    tools: mateTools,
    children: [...roots.sort(byAge).map(attach), ...mateSubs],
  };
  return { root };
}
