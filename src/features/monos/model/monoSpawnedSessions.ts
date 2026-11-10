import { unwrapShellCommand } from "../../../integrations/harness/core/shellIntent";
import {
  delegateToolData,
  fanoutSessions,
  monoCodeToolCall,
} from "../../sessions/model/monocodeToolCall";
import {
  isProseBlock,
  type TurnItem,
} from "../../sessions/model/transcriptActivity";
import { cleanCliFallback } from "../../crew/model/cliFallback";
import { cleanRanFrom } from "../../crew/model/workerChoice";
import {
  HARNESSES,
  sessionDraftBlock,
  sessionNeedsInput,
  type Block,
  type MonoSpawnedSession,
  type Session,
} from "../../sessions/model/session";

export function sanitizeMonoSpawnedSessions(
  value: unknown,
): MonoSpawnedSession[] {
  if (!Array.isArray(value)) return [];
  const result = new Map<string, MonoSpawnedSession>();
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.sessionId !== "string" ||
      !/^[A-Za-z0-9_-]{1,512}$/.test(item.sessionId) ||
      typeof item.cwd !== "string" ||
      !item.cwd.trim() ||
      typeof item.title !== "string" ||
      !HARNESSES.includes(item.harness) ||
      typeof item.model !== "string" ||
      !item.model.trim()
    )
      continue;
    const effort =
      typeof item.effort === "string" && item.effort.trim() && item.effort.length <= 40
        ? item.effort.trim()
        : undefined;
    const from = cleanRanFrom(item.from);
    const cliFallback = cleanCliFallback(item.cliFallback);
    if (!result.has(item.sessionId))
      result.set(item.sessionId, {
        sessionId: item.sessionId,
        cwd: item.cwd,
        title: item.title.trim().slice(0, 300) || "Agent session",
        harness: item.harness,
        model: item.model,
        ...(effort ? { effort } : {}),
        ...(from ? { from } : {}),
        ...(cliFallback ? { cliFallback } : {}),
      });
  }
  return [...result.values()];
}

/** Record accepted launches and follow-ups; retries never duplicate a card. */
export function recordMonoSpawnedSession(
  mono: Session,
  turnId: string,
  launched: MonoSpawnedSession,
): Session {
  const index = mono.blocks.findIndex(
    (block) => block.id === turnId && block.role === "user",
  );
  if (index < 0) return mono;
  const block = mono.blocks[index];
  if (
    block.monoSpawnedSessions?.some(
      (entry) => entry.sessionId === launched.sessionId,
    )
  )
    return mono;
  const blocks = mono.blocks.slice();
  blocks[index] = {
    ...block,
    monoSpawnedSessions: [...(block.monoSpawnedSessions ?? []), launched],
  };
  return { ...mono, blocks };
}

/**
 * A card already in the chat for a worker that was waiting. Undefined means leave
 * it. A start that names no source does not rewrite a card that named none.
 */
export function waitingCardAfterStart(
  card: MonoSpawnedSession,
  start: Pick<MonoSpawnedSession, "model" | "harness" | "effort" | "from" | "cliFallback">,
): MonoSpawnedSession | undefined {
  const named = !!(card.from || card.effort || card.cliFallback);
  const startNames = !!(start.from || start.effort || start.cliFallback);
  // A start that names no source does not rewrite a card that named none.
  if (!named && !startNames) return undefined;
  const next: MonoSpawnedSession = {
    ...card,
    model: start.model.trim() || card.model,
    harness: start.harness,
  };
  if (start.effort) next.effort = start.effort;
  else delete next.effort;
  if (start.from) next.from = start.from;
  else delete next.from;
  if (start.cliFallback) next.cliFallback = start.cliFallback;
  else delete next.cliFallback;
  if (
    next.model === card.model &&
    next.harness === card.harness &&
    next.effort === card.effort &&
    next.from === card.from &&
    next.cliFallback === card.cliFallback
  )
    return undefined;
  return next;
}

type SessionReceipt = {
  launches: MonoSpawnedSession[];
  listed: MonoSpawnedSession[];
  /** Chats a call sent work to: one for delegate_task or sessions.send, each task's for delegate_tasks (WP-171). */
  sentSessionIds: string[];
};

const blockReceipts = new WeakMap<Block, SessionReceipt>();

/** Blocks are immutable, so old receipts only need to be parsed once. */
function sessionReceipt(block: Block): SessionReceipt {
  const cached = blockReceipts.get(block);
  if (cached) return cached;
  const found: SessionReceipt = {
    launches: sanitizeMonoSpawnedSessions(block.monoSpawnedSessions),
    listed: [],
    sentSessionIds: [],
  };
  if (
    block.tool &&
    ["completed", "success"].includes(block.tool.status ?? "")
  ) {
    const command =
      block.tool.preview?.kind === "shell"
        ? block.tool.preview.title
        : (block.tool.title ?? block.text);
    const call = command
      ? monoCodeToolCall({
          ...block,
          tool: {
            ...block.tool,
            preview: { kind: "shell", title: unwrapShellCommand(command) },
          },
        })
      : undefined;
    // The delegate tool's delegate_task names the worker's chat; its details come from the launch the app recorded.
    // WP-171: delegate_tasks names one chat for each task it handed out.
    const delegated =
      call?.delegate === "delegate_task"
        ? [delegateToolData(block.tool.detail)?.childSessionId]
        : call?.delegate === "delegate_tasks"
          ? fanoutSessions(block)
          : [];
    for (const id of delegated)
      if (typeof id === "string" && id.startsWith("app-"))
        found.sentSessionIds.push(id);
    if (
      call &&
      ["sessions.start", "sessions.list", "sessions.send"].includes(call.action)
    ) {
      try {
        const receipt = JSON.parse(block.tool.detail ?? "");
        if (
          call.action === "sessions.start" &&
          receipt?.ok === true &&
          typeof receipt.result?.id === "string" &&
          receipt.result.id.startsWith("app-")
        ) {
          const entry = sanitizeMonoSpawnedSessions([
            {
              ...receipt.result,
              sessionId: receipt.result.id,
              title: receipt.result.title ?? "Agent session",
            },
          ])[0];
          if (
            entry &&
            !found.launches.some(
              (existing) => existing.sessionId === entry.sessionId,
            )
          )
            found.launches.push(entry);
        } else if (
          call.action === "sessions.list" &&
          receipt?.ok === true &&
          Array.isArray(receipt.result?.sessions)
        ) {
          found.listed = sanitizeMonoSpawnedSessions(
            receipt.result.sessions.map((session: Record<string, unknown>) => ({
              ...session,
              sessionId: session?.id,
              cwd: receipt.result.cwd,
            })),
          );
        } else if (
          call.action === "sessions.send" &&
          receipt?.ok === true &&
          receipt.result?.submitted === true &&
          typeof receipt.result.sessionId === "string"
        ) {
          found.sentSessionIds.push(receipt.result.sessionId);
        }
      } catch {
        // Incomplete or truncated output is not a confirmed launch.
      }
    }
  }
  blockReceipts.set(block, found);
  return found;
}

/** Saved chats predate launch metadata, so recover successful CLI receipts too. */
export function monoSpawnedSessions(
  blocks: readonly Block[],
  knownSessions: readonly MonoSpawnedSession[] = [],
): MonoSpawnedSession[] {
  const known = new Map(knownSessions.map((entry) => [entry.sessionId, entry]));
  const receipts = blocks.map(sessionReceipt);
  // A listing provides the details for an older accepted follow-up, but
  // listing or reading a session alone never puts a card in the chat.
  for (const receipt of receipts) {
    for (const entry of [...receipt.listed, ...receipt.launches]) {
      known.set(entry.sessionId, entry);
    }
  }
  const found = new Map<string, MonoSpawnedSession>();
  for (const receipt of receipts) {
    for (const entry of receipt.launches) {
      if (!found.has(entry.sessionId)) found.set(entry.sessionId, entry);
    }
    for (const id of receipt.sentSessionIds) {
      const sent = known.get(id);
      if (sent && !found.has(sent.sessionId)) found.set(sent.sessionId, sent);
    }
  }
  return [...found.values()];
}

/** Where a launched session stands, for its card in the Mono's chat. */
export type LaunchedSessionState =
  | "working"
  | "input"
  | "draft"
  | "failed"
  | "stopped"
  | "done"
  /** Not started yet: its project's workers are all busy, or its provider is at its limit (H8, workerPool.ts). */
  | "waiting";

export type LaunchedSessionView = {
  state: LaunchedSessionState;
  title: string;
  /** Out of its provider's usage and held (H8): when it tries again by itself, and the provider's name. */
  retryAt?: number;
  provider?: string;
  /** Waiting on another task of this fan-out, not on a free worker (WP-171). The card says so. */
  forTask?: boolean;
};

export function launchedSessionState(session: Session): LaunchedSessionState {
  if (sessionNeedsInput(session)) return "input";
  if (session.busy) return "working";
  if (sessionDraftBlock(session)) return "draft";
  const notice = session.blocks[session.blocks.length - 1]?.notice;
  if (notice === "error") return "failed";
  if (notice === "interrupt") return "stopped";
  // It stopped resuming itself after restarts and waits for someone to look.
  if (notice === "resume-stopped") return "input";
  return "done";
}

/**
 * Where a turn's launched sessions go: each after the first reply that came
 * after its launch, so a Mono reporting back later in the same turn writes
 * below them, as it happened. A launch no reply has followed goes at the end.
 */
export function launchAnchors(
  items: readonly TurnItem[],
  launches: readonly MonoSpawnedSession[],
): {
  afterItem: Map<number, MonoSpawnedSession[]>;
  atEnd: MonoSpawnedSession[];
} {
  const afterItem = new Map<number, MonoSpawnedSession[]>();
  const atEnd: MonoSpawnedSession[] = [];
  if (launches.length === 0) return { afterItem, atEnd };
  const launched = items.map((item) =>
    monoSpawnedSessions(
      item.type === "block" ? [item.block] : item.blocks,
      launches,
    ).map((entry) => entry.sessionId),
  );
  for (const launch of launches) {
    // The tool call that started it; the prompt also lists it, as a fallback.
    const isPrompt = (index: number) => {
      const item = items[index];
      return item.type === "block" && item.block.role === "user";
    };
    const has = (index: number) => launched[index].includes(launch.sessionId);
    let at = items.findIndex((_, index) => has(index) && !isPrompt(index));
    if (at < 0) at = items.findIndex((_, index) => has(index));
    const reply =
      at < 0
        ? -1
        : items.findIndex(
            (item, index) =>
              index > at && item.type === "block" && isProseBlock(item.block),
          );
    if (reply < 0) atEnd.push(launch);
    else afterItem.set(reply, [...(afterItem.get(reply) ?? []), launch]);
  }
  return { afterItem, atEnd };
}
