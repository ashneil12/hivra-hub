import { isInFlightSession } from "./inFlight";
import { plainToolStep } from "./liveActivity";
import {
  sessionDisplayTitle,
  type Block,
  type HarnessId,
  type Session,
} from "./session";

export type LiveAgent = {
  id: string;
  cwd: string;
  title: string;
  harness: HarnessId;
  activity: string;
  startedAt?: number;
  durationMs?: number;
  needsApproval: boolean;
  done: boolean;
};

/** Inbox discussions and orchestration workers have their own panels and
 * never appear as live agents. */
export function isLiveAgentSession(
  session: Pick<Session, "inboxAsk" | "orchestrationLeadId">,
): boolean {
  return !session.inboxAsk && !session.orchestrationLeadId;
}

/**
 * The Working tray's rows: chats running now, and (unless `runningOnly`, the Hub's rule: Ash, 20 Oct, a finished job
 * listed there reads as still going) finished ones not yet seen. A delegated worker is named by its task's title
 * (`taskTitle`), never by the brief's "[MonoCode brief from …]" first line its chat was named from.
 */
export function liveAgentsFromSessions(
  sessions: Session[],
  unseenFinishedIds: ReadonlySet<string> = new Set(),
  excludedIds: ReadonlySet<string> = new Set(),
  options: { runningOnly?: boolean; taskTitle?: (sessionId: string) => string | undefined } = {},
): LiveAgent[] {
  const finished = options.runningOnly ? new Set<string>() : unseenFinishedIds;
  return sessions
    .filter(
      (session) =>
        !excludedIds.has(session.id) &&
        isLiveAgentSession(session) &&
        (isInFlightSession(session) || finished.has(session.id)),
    )
    .map((session) =>
      toLiveAgent(session, finished.has(session.id), options.taskTitle?.(session.id)),
    )
    .sort(compareLiveAgents);
}

/** The app's own header on a brief another chat sent ("[MonoCode brief from Chief of Staff]"). */
const BRIEF_HEADER = /^\s*\[MonoCode (?:brief|report|question|notification)[^\]\n]*\]\s*/i;

/** A chat's title as Ash reads it: without the brief header a delegated chat was named from. */
export function cleanWorkTitle(title: string): string {
  const clean = title.replace(BRIEF_HEADER, "").replace(/\s+/g, " ").trim();
  return clean || "Delegated work";
}

export function formatLiveElapsed(startedAt: number, now: number): string {
  const seconds = Math.max(1, Math.round((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minRest = minutes % 60;
  return minRest ? `${hours}h ${minRest}m` : `${hours}h`;
}

function toLiveAgent(
  session: Session,
  unseenFinished: boolean,
  taskTitle: string | undefined,
): LiveAgent {
  const pending = session.blocks.find(
    (block) => block.approval && !block.approval.decided,
  );
  const pendingQuestion = session.pendingQuestion;
  const done = unseenFinished && !isInFlightSession(session);
  const activityBlock = pending ?? lastActivityBlock(session.blocks);
  return {
    id: session.id,
    cwd: session.cwd,
    title: taskTitle?.trim() || cleanWorkTitle(sessionDisplayTitle(session.title, session.harness)),
    harness: session.harness,
    activity: done
      ? "Done"
      : pendingQuestion
        ? pendingQuestion.title ||
          pendingQuestion.questions[0]?.prompt ||
          "Question"
        : activityLabel(activityBlock, session.cwd),
    startedAt: turnStartedAt(session.blocks),
    durationMs: done ? turnDurationMs(session.blocks) : undefined,
    needsApproval: Boolean(pending) || Boolean(pendingQuestion),
    done,
  };
}

function compareLiveAgents(a: LiveAgent, b: LiveAgent): number {
  if (a.needsApproval !== b.needsApproval) return a.needsApproval ? -1 : 1;
  if (a.done !== b.done) return a.done ? 1 : -1;
  return (
    (a.startedAt ?? Number.MAX_SAFE_INTEGER) -
    (b.startedAt ?? Number.MAX_SAFE_INTEGER)
  );
}

function lastActivityBlock(blocks: Block[]): Block | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.role === "tool" || block.role === "approval") return block;
    if (block.role === "handoff" && block.handoff?.status === "preparing") {
      return block;
    }
  }
  return undefined;
}

function turnStartedAt(blocks: Block[]): number | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].role === "user") return blocks[i].startedAt;
  }
  return undefined;
}

function turnDurationMs(blocks: Block[]): number | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].role === "user") return blocks[i].durationMs;
  }
  return undefined;
}

function activityLabel(block: Block | undefined, cwd: string): string {
  if (!block) return "Working";
  if (block.role === "handoff" && block.handoff?.status === "preparing") {
    return "Preparing a handoff";
  }
  // r94 (Critiquito a): the sidebar foot's rows go through the chat's own plain-words step, every time, not only when a
  // raw tool name or a temp path slips through: no paths outside the file's name, no mcp__ names, no regex.
  return plainToolStep(block, cwd);
}
