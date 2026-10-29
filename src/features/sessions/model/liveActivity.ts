// What an agent is doing right now, in plain words, for the live step line under a working reply (Ash, 28 Oct: "instead
// of just saying 'writing,' I have no idea if it's actually working or not"). Built only from the turn's own streamed
// blocks: no detail means "Thinking", never a guessed step. The timer and the stall clock are what this window saw
// (blocks carry no times of their own), kept per turn so a remount doesn't reset them.
import { isReadTool } from "../../../integrations/harness/core/preview";
import { displayPath } from "../../../shared/lib/paths";
import type { Block } from "./session";
import { isProseBlock, isThinkingBlock, isToolBlock, needsApproval, toolCategory } from "./transcriptActivity";

export type LiveStep = { key: string; label: string };
/** A step, when this window first saw it, and when it last saw anything new in the turn's stream. */
export type LiveActivity = LiveStep & { since: number; lastEventAt: number };

/** No new event for this long and the line says so, in grey, instead of a step that may be over. */
export const STALL_MS = 60_000;

const DONE = new Set(["completed", "failed", "error", "cancelled", "canceled", "interrupted", "stopped"]);
const CHECK = /\b(?:test|tests|vitest|jest|playwright|tsc|typecheck|lint|eslint|clippy|check|cargo\s+(?:test|check|fmt))\b/i;
const MAX_PATH = 56;

function shortPath(path: string): string {
  return path.length > MAX_PATH ? `…${path.slice(path.length - MAX_PATH + 1)}` : path;
}

function toolStep(block: Block, cwd?: string): string {
  const preview = block.tool?.preview;
  const rawPath = preview?.path ? displayPath(preview.path, cwd) : preview?.fileName;
  const path = rawPath ? shortPath(rawPath) : undefined;
  const title = block.text || block.tool?.title || "";
  switch (toolCategory(block)) {
    case "agent":
      return "Waiting on a worker";
    case "edit":
      return path ? `Editing ${path}` : "Editing a file";
    case "research":
      if (isReadTool(block.tool?.kind, title, preview)) return path ? `Reading ${path}` : "Reading a file";
      return "Searching the project";
    case "run":
      return CHECK.test(title) ? "Running a check" : "Running a command";
    default:
      return "Using a tool";
  }
}

/** The turn's current step, from its latest block that says anything. */
export function liveStep(blocks: readonly Block[], cwd?: string): LiveStep {
  const seen = blocks.filter((b) => b.role !== "user" && !b.internal && !b.draft);
  const waiting = seen.find(needsApproval);
  if (waiting) return { key: `approval:${waiting.id}`, label: "Waiting for your OK" };
  const workflow = seen.find((b) => b.workflowRun?.status === "running");
  if (workflow) return { key: `workflow:${workflow.id}`, label: "Waiting on workers" };
  let latest: Block | undefined;
  for (const block of seen) if (isToolBlock(block) || isProseBlock(block) || isThinkingBlock(block)) latest = block;
  if (!latest) return { key: "start", label: "Thinking" };
  if (isToolBlock(latest)) {
    const status = latest.tool?.status?.toLowerCase();
    if (latest.tool?.background && !DONE.has(status ?? "")) return { key: `bg:${latest.id}`, label: "Waiting on a background task" };
    // A finished call is not what it is doing now: it is deciding what comes next.
    if (status && DONE.has(status)) return { key: `after:${latest.id}`, label: "Thinking" };
    return { key: `tool:${latest.id}`, label: toolStep(latest, cwd) };
  }
  if (isProseBlock(latest)) return { key: `prose:${latest.id}`, label: "Writing" };
  return { key: `think:${latest.id}`, label: "Thinking" };
}

/** Changes whenever the stream brings anything: a block, more words, output, a status. */
function signature(blocks: readonly Block[]): string {
  let chars = 0;
  let detail = 0;
  let marks = "";
  for (const b of blocks) {
    chars += b.text.length;
    detail += b.tool?.detail?.length ?? 0;
    marks += `${b.tool?.status ?? ""}${b.approval?.decided ?? ""}${b.workflowRun?.status ?? ""},`;
  }
  return `${blocks.length}:${chars}:${detail}:${marks}`;
}

type Tracked = LiveActivity & { sig: string };
const tracked = new Map<string, Tracked>();
const MAX_TRACKED = 200;

/**
 * The activity of turn `id` given its blocks now: the step's start moves when the step changes, the last event when
 * anything in the stream does. `startedAt` (the turn's own start, when known) seeds a turn seen for the first time with nothing back yet; `override` is a
 * step the caller knows better (waiting for answers, or on background tasks).
 */
export function trackActivity(
  id: string,
  blocks: readonly Block[],
  now: number,
  cwd?: string,
  startedAt?: number,
  override?: LiveStep,
): LiveActivity {
  const step = override ?? liveStep(blocks, cwd);
  const sig = signature(blocks);
  const prev = tracked.get(id);
  let next: Tracked;
  if (!prev) {
    // Only a turn with nothing back yet has been "Thinking" since it began; a later step, first seen now, starts now.
    const start = startedAt && startedAt <= now && step.key === "start" ? startedAt : now;
    next = { ...step, since: start, lastEventAt: blocks.some((b) => b.role !== "user") ? now : start, sig };
  } else {
    next = {
      ...step,
      since: prev.key === step.key ? prev.since : now,
      lastEventAt: prev.sig === sig ? prev.lastEventAt : now,
      sig,
    };
  }
  tracked.delete(id);
  tracked.set(id, next);
  if (tracked.size > MAX_TRACKED) tracked.delete(tracked.keys().next().value as string);
  const { sig: _sig, ...activity } = next;
  return activity;
}

/** The turn is over: its clocks go. */
export function forgetActivity(id: string): void {
  tracked.delete(id);
}

/** "6s", "1m 02s", "1h 05m". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** What the line reads at `now`: the step and its timer, or, after a minute with nothing new, that nothing is happening. */
export function activityLine(activity: LiveActivity, now: number): { text: string; stalled: boolean } {
  const idle = now - activity.lastEventAt;
  if (idle >= STALL_MS) return { text: `No activity for ${Math.floor(idle / 60_000)} min`, stalled: true };
  return { text: `${activity.label} · ${formatElapsed(now - activity.since)}`, stalled: false };
}
