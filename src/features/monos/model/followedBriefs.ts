// Followed briefs (HUB-PLAN phase 3, T3 harvest "Briefs to a busy chat queue or steer instead of failing", and double
// delegation): briefs whose report is decided by watching the chat they went to, not by a launch's own callback.
//
// - **queue**: sent to a chat that was mid-turn, it waits in that chat's queue and goes in as its own turn once the
//   chat is idle (never steered into a Mono's work).
// - **steer**: sent to a chat that was mid-turn when the sender asked to steer, it joins the running turn.
// - **lead**: a leadership Mono's brief to a project Lead's long-running chat. The Lead does the work by delegating to
//   its own workers; its report is its final reply once every worker it started for this brief has reported to it.
//
// Each is a stored delegation row (delegations.rs `follow`) owned by the sender, with the chat as its child, so it
// survives a restart, shows in task_status and in the tree (H4's cascade Stop sees Lead-under-leadership rows), and
// reports through the H2 report-back path exactly once (its receipt). This module only decides; useFollowedBriefs acts.
import { wasTurnInterrupted } from "../../sessions/model/inFlight";
import { dequeueQueuedMessage } from "../../sessions/model/messageQueue";
import type { QueuedMessage, Session } from "../../sessions/model/session";
import { isOwed, type Delegation } from "./delegations";
import {
  monoSessionCompletionResult,
  type MonoSessionCompletionResult,
} from "./monoSessionCompletion";

/** A brief just recorded may not be in its chat's queue yet; give it this long before calling it taken out. */
export const FOLLOW_GRACE_MS = 15_000;

/** How a sender asks for a busy chat: queue behind the work (the default for briefs), steer into it, or let it decide. */
export type SendMode = "auto" | "queue" | "steer";
/** What happened to a brief: it started a turn, waits in the chat's queue, or joined the running turn. */
export type Delivery = "started" | "queued" | "steered";

export function sendMode(value: unknown): SendMode {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "queue" || value === "steer") return value;
  throw new Error('mode must be "auto", "queue" or "steer"');
}

/**
 * How a brief goes into `chat`: started when the chat is idle; otherwise steered only when asked and the chat can take
 * it, else queued. A Mono's chat that is busy queues (a brief never interrupts a Lead unasked).
 */
export function deliveryFor(
  chat: Pick<Session, "busy" | "queuedMessages">,
  mode: SendMode,
  canSteer: boolean,
): Delivery {
  // Behind messages already waiting, a brief waits too: it never overtakes them.
  if (!chat.busy && !chat.queuedMessages?.length) return "started";
  return mode === "steer" && chat.busy && canSteer ? "steered" : "queued";
}

/** The index of the user bubble the brief went in as (it carries the app request id), or -1 while it hasn't. */
export function briefSentAt(row: Pick<Delegation, "requestId">, chat: Pick<Session, "blocks">): number {
  for (let index = chat.blocks.length - 1; index >= 0; index--) {
    const block = chat.blocks[index];
    if (block.role === "user" && !block.draft && block.appRequestId === row.requestId) return index;
  }
  return -1;
}

/** The brief still waits in the chat's queue. */
export function briefWaiting(row: Pick<Delegation, "requestId">, chat: Pick<Session, "queuedMessages">): QueuedMessage | undefined {
  return chat.queuedMessages?.find((message) => message.id === row.requestId || message.appRequestId === row.requestId);
}

/** Take a queued brief back out of a chat: the queue row, and a Mono's pending bubble for it. */
export function withoutQueuedBrief(chat: Session, message: QueuedMessage): Session {
  const next = dequeueQueuedMessage(chat, message.id);
  return message.blockId
    ? { ...next, blocks: next.blocks.filter((block) => block.id !== message.blockId) }
    : next;
}

export type FollowStep =
  | { kind: "wait"; why: "queued" | "working" | "workers" }
  | { kind: "settle"; result: MonoSessionCompletionResult }
  | { kind: "cancel"; reason: string };

/**
 * What to do with one open followed brief now. `chat` is the chat it went to (null when that chat is gone), `children`
 * the rows of its tree (a Lead's workers have it as their parent), `now` the clock.
 */
export function followStep(
  row: Delegation,
  look: { chat: Session | null; children: readonly Delegation[]; now: number },
): FollowStep {
  const { chat } = look;
  if (!chat) return { kind: "cancel", reason: "The chat it was sent to is gone." };
  const sentAt = briefSentAt(row, chat);
  if (sentAt < 0) {
    if (briefWaiting(row, chat)) return { kind: "wait", why: "queued" };
    if (chat.busy || look.now - row.createdAt < FOLLOW_GRACE_MS) return { kind: "wait", why: "queued" };
    return {
      kind: "cancel",
      reason: `It was taken out of ${chat.title || "the chat"}'s queue before it started.`,
    };
  }
  if (chat.busy || wasTurnInterrupted(chat) || chat.queueStatus === "resuming")
    return { kind: "wait", why: "working" };
  // A Lead reports once every worker it started for this brief has reported to it (and it has had its say on that).
  if (row.follow === "lead" && look.children.some((child) => child.parentId === row.id && isOwed(child)))
    return { kind: "wait", why: "workers" };
  return { kind: "settle", result: followedResult(row, chat, sentAt) };
}

/** The report: the chat's reply to the brief (a Lead's: its latest reply, after its workers' reports), or its error. */
export function followedResult(row: Delegation, chat: Session, sentAt = briefSentAt(row, chat)): MonoSessionCompletionResult {
  const lead = row.follow === "lead";
  const after = chat.blocks.slice(Math.max(0, sentAt) + 1);
  const lastUser = lead ? lastIndex(chat.blocks, (b) => b.role === "user" && !b.draft) : sentAt;
  const tail = chat.blocks.slice(Math.max(0, lastUser) + 1);
  const failure = [...(lead ? tail : after)].reverse().find((b) => b.role === "system" && b.notice === "error");
  const replied = (lead ? tail : after).some((b) => b.role === "assistant" && !b.tool && !b.internal && b.text.trim());
  const failed = !!failure && !replied;
  return monoSessionCompletionResult({
    requestId: row.requestId,
    sessionId: chat.id,
    project: chat.cwd,
    prompt: row.brief ?? "",
    outcome: failed ? { status: "failed", text: "", error: failure!.text } : { status: "completed", text: "" },
    session: chat,
    latestTurn: lead,
  });
}

function lastIndex<T>(items: readonly T[], test: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) if (test(items[index])) return index;
  return -1;
}

/**
 * The brief a Lead is working on now: of its open Lead briefs, the one most recently sent into its chat. Its new
 * workers go under that one (delegations.rs `parent_id`), so its report waits for them and the tree shows them there.
 */
export function currentLeadBrief(rows: readonly Delegation[], lead: Pick<Session, "id" | "blocks">): Delegation | undefined {
  let best: { row: Delegation; at: number } | undefined;
  for (const row of rows) {
    if (row.follow !== "lead" || row.childSession !== lead.id) continue;
    if (row.state !== "running" && row.state !== "question") continue;
    const at = briefSentAt(row, lead);
    if (at >= 0 && (!best || at > best.at)) best = { row, at };
  }
  return best?.row;
}

/** A Lead brief whose report reached its owner as a turn, and the owner's answer to it, once that turn is over. */
export function answeredReport(
  row: Delegation,
  owner: Session,
  receipt: string,
): { report: string; answer: string } | undefined {
  if (row.follow !== "lead" || row.delivery === "pending" || row.delivery === "queued") return undefined;
  if (owner.busy) return undefined;
  const at = lastIndex(owner.blocks, (b) => b.role === "user" && b.appRequestId === receipt);
  if (at < 0) return undefined;
  let answer = "";
  for (const block of owner.blocks.slice(at + 1)) {
    if (block.role === "user") break;
    if (block.role === "assistant" && !block.tool && !block.internal && block.text.trim()) answer = block.text;
  }
  return { report: row.result ?? "", answer };
}
