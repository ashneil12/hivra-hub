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
import { dequeueQueuedMessage, queueStatusOnEnqueue } from "../../sessions/model/messageQueue";
import type { Block, QueuedMessage, Session } from "../../sessions/model/session";
import { isOwed, type Delegation } from "./delegations";
import { unfinishedWorker } from "./workerStuck";
import {
  completionReceipt,
  monoSessionCompletionResult,
  type MonoSessionCompletionResult,
} from "./monoSessionCompletion";
import { forUser } from "../../hub/model/userName";

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

/**
 * Queue a brief behind a Mono's work with no bubble yet: the transcript shows it pending at the end
 * (monoPendingTranscriptBlocks), and once it goes in its turn sits after the work it waited for, not above it.
 */
export function queueBriefForIdle(
  chat: Session,
  brief: Pick<QueuedMessage, "text" | "attachments" | "intent"> & { requestId: string },
): Session {
  return {
    ...chat,
    queuedMessages: [
      ...(chat.queuedMessages ?? []),
      {
        id: brief.requestId,
        text: brief.text,
        attachments: brief.attachments,
        ...(brief.intent ? { intent: brief.intent } : {}),
        appRequestId: brief.requestId,
        waitForIdle: true,
      },
    ],
    queueStatus: queueStatusOnEnqueue(chat),
  };
}

/**
 * A waiting brief whose followed row was cancelled meanwhile (task_cancel, a cascade Stop): it must never go in, even
 * when the queue that still held it was saved before the cancel took it out (a crash, a restart). `rows` are the rows
 * sent into the brief's chat (delegations.rs `followed_into`).
 */
export function briefCancelled(rows: readonly Pick<Delegation, "requestId" | "state">[], requestId: string): boolean {
  return rows.some((row) => row.requestId === requestId && row.state === "cancelled");
}

/** Take a queued brief back out of a chat: the queue row, and a Mono's pending bubble for it. */
export function withoutQueuedBrief(chat: Session, message: QueuedMessage): Session {
  const next = dequeueQueuedMessage(chat, message.id);
  return message.blockId
    ? { ...next, blocks: next.blocks.filter((block) => block.id !== message.blockId) }
    : next;
}

export type FollowStep =
  | { kind: "wait"; why: "queued" | "working" | "workers" | "report" }
  | { kind: "settle"; result: MonoSessionCompletionResult }
  /** The Lead's last turn on the brief also took a message steered into it: ask it for its report on its own. */
  | { kind: "ask"; request: QueuedMessage }
  | { kind: "cancel"; reason: string };

/** A worker as the brief's failure line names it. */
function workerName(row: Pick<Delegation, "title">): string {
  return row.title?.trim().split("\n")[0].slice(0, 60) || "a worker";
}

/**
 * The brief's report when one of its workers declared it cannot finish (D5, task_cannot): a failure naming the worker
 * and its reason, sent back at once, so the sender hears about the block rather than waiting on a job that will not
 * land. It is the worker's own word, never a judgment (workerStall.ts never clears it).
 */
function cannotFinishResult(row: Delegation, chat: Session, worker: Delegation): MonoSessionCompletionResult {
  const name = workerName(worker);
  const reason = worker.stallReason?.trim();
  return monoSessionCompletionResult({
    requestId: row.requestId,
    sessionId: chat.id,
    project: chat.cwd,
    prompt: row.brief ?? "",
    outcome: {
      status: "failed",
      text: "",
      error: `${name.charAt(0).toUpperCase()}${name.slice(1)} cannot finish${reason ? `: ${reason}` : ""}.`,
    },
    session: chat,
  });
}

/**
 * What to do with one open followed brief now. `chat` is the chat it went to (null when that chat is gone), `children`
 * the rows of its tree (a Lead's workers have it as their parent), `now` the clock, `asked` the report requests this
 * window already queued (a Lead's, `reportRequest`) and when.
 */
export function followStep(
  row: Delegation,
  look: { chat: Session | null; children: readonly Delegation[]; now: number; asked?: ReadonlyMap<string, number> },
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
  // D5: a worker that said it cannot finish (task_cannot) is not waited on. It is still running — declaring is not
  // cancelling — but waiting on it would hold the brief open forever, so the brief fails at once, naming it.
  const declaring = look.children.find(
    (child) =>
      child.parentId === row.id &&
      child.state === "running" &&
      child.stallKind === "blocked" &&
      // A block the Lead already worked around (a retried generation) is not held against the brief.
      unfinishedWorker(child, look.now) !== undefined,
  );
  if (row.follow === "lead" && declaring)
    return { kind: "settle", result: cannotFinishResult(row, chat, declaring) };
  // A Lead reports once every worker it started for this brief has reported to it (and it has had its say on that).
  if (row.follow === "lead" && look.children.some((child) => child.parentId === row.id && isOwed(child)))
    return { kind: "wait", why: "workers" };
  if (row.follow === "lead") return leadReportStep(row, chat, look.children, look.asked ?? new Map(), look.now);
  return { kind: "settle", result: followedResult(row, chat, look.children) };
}

/** A report request's first words (the studio's sweep skips "[MonoCode ", so it is never read as Ash's). */
export const REPORT_REQUEST_PREFIX = "[MonoCode report request]";

/** The id of the report request a Lead gets for one brief (its queue id, and the request id its turn carries). */
export function reportRequestId(row: Pick<Delegation, "id" | "generation">): string {
  return `report-request-${row.id}-g${row.generation}`;
}

/** Who sent the brief, as its first line names them ("[MonoCode brief from Chief of Staff]"). */
function briefSender(row: Pick<Delegation, "brief">): string {
  return /^\[MonoCode brief from ([^\]\n]{1,80})\]/.exec(row.brief ?? "")?.[1]?.trim() || "the Mono that briefed you";
}

/**
 * The app's request for a Lead's report on one brief, when its last turn on it also answered a message steered in
 * meanwhile (so that reply is not a clean report). It waits for the Lead to be idle like a worker's report, never
 * steers, and its turn's reply is the report.
 */
export function reportRequest(row: Delegation): QueuedMessage {
  const owner = briefSender(row);
  const title = row.title?.trim() || "your brief";
  return {
    id: reportRequestId(row),
    attachments: [],
    monoSessionCompletion: { sessionId: row.ownerSession, title: `Report for ${owner}`, status: "completed" },
    text: forUser`${REPORT_REQUEST_PREFIX} MonoCode notification: you have finished the brief "${title}" from ${owner} and every task you started for it is back, but your last turn on it also answered a message that came in while you wrote it, so that reply is not a clean report. Write your final report on that brief for ${owner} now, in one message: what was done, how it was checked (the evidence), and anything unresolved or waiting on Ash. Only the report: it goes back to ${owner} exactly as you write it. This is an app notification, not a new message from Ash.`,
  };
}

/** A message that joined a turn already running (appendSteerUser): sent, never started. */
function isSteer(block: Block): boolean {
  return block.role === "user" && block.sentAt != null && block.startedAt == null;
}

/**
 * One turn of a Lead's chat, from the user bubble at `at`: its last reply, the error that ended it, and whether a
 * message joined it meanwhile (`mixed`), so its reply also answers that. A message still waiting in the queue isn't in
 * the conversation yet and is skipped; one that waited there and went in as a new turn is shown where it was sent, so
 * if it was sent before this turn ended its answer is mixed in with this turn's words too.
 */
function leadTurn(chat: Session, at: number): { reply: string; cleanReply: string; failure?: string; mixed: boolean } {
  const opening = chat.blocks[at];
  const pending = new Set((chat.queuedMessages ?? []).flatMap((message) => (message.blockId ? [message.blockId] : [])));
  const ended = opening?.startedAt != null && opening.durationMs != null ? opening.startedAt + opening.durationMs : undefined;
  let mixed = !!opening && isSteer(opening);
  let reply = "";
  let cleanReply = "";
  let failure: string | undefined;
  for (const block of chat.blocks.slice(at + 1)) {
    if (block.role === "user") {
      if (block.draft || pending.has(block.id)) continue;
      if (isSteer(block)) {
        mixed = true;
        continue;
      }
      if (block.sentAt != null && (ended == null || block.sentAt < ended)) mixed = true;
      break;
    }
    if (block.role === "assistant" && !block.tool && !block.internal && block.text.trim()) {
      reply = block.text;
      if (!mixed) cleanReply = block.text;
      failure = undefined;
    } else if (block.role === "system" && block.notice === "error") failure = block.text;
  }
  return { reply, cleanReply, ...(failure && !reply ? { failure } : {}), mixed };
}

/**
 * A Lead's brief whose work is all back: its report is the Lead's answer in its last turn on the brief. When a message
 * was steered into that turn (Ash asking how it goes, another brief), the turn's last words may answer that instead,
 * and its first words may be cut off before it: then the Lead is asked once for the report on its own, and that turn's
 * reply is the report. Never a trap: a request that went missing settles on the turn's last words.
 */
function leadReportStep(
  row: Delegation,
  chat: Session,
  children: readonly Delegation[],
  asked: ReadonlyMap<string, number>,
  now: number,
): FollowStep {
  const turn = reportTurn(row, chat, children);
  const last = leadTurn(chat, turn.at);
  // D5: a Lead's "done" is checked against what its workers actually did: a worker that failed, or said it cannot
  // finish, makes the brief a failure naming it. A retried worker (leadRetried) is not held against the Lead.
  const notDone = children
    .filter((child) => child.parentId === row.id && unfinishedWorker(child, now) !== undefined)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((child) => `${workerName(child)} — ${unfinishedWorker(child, now)}`);
  const unfinished = notDone.length ? `Not done: ${notDone.join("; ")}.` : undefined;
  const settle = (reply: string, failure?: string, requestId = turn.requestId): FollowStep => {
    const error = failure ?? unfinished;
    return {
      kind: "settle",
      result: monoSessionCompletionResult({
        requestId,
        sessionId: chat.id,
        project: chat.cwd,
        prompt: row.brief ?? "",
        outcome: error ? { status: "failed", text: "", error } : { status: "completed", text: "" },
        session: chat,
        reply,
      }),
    };
  };
  if (!last.mixed) return settle(last.reply, last.failure);
  const id = reportRequestId(row);
  const sent = briefSentAt({ requestId: id }, chat);
  if (sent > turn.at) {
    const answer = leadTurn(chat, sent);
    // A message steered into this turn too: what it wrote before that is the report it was asked for.
    const reply = (answer.mixed ? answer.cleanReply : answer.reply) || answer.reply || last.reply;
    return settle(reply, reply ? undefined : answer.failure, id);
  }
  if (chat.queuedMessages?.some((message) => message.id === id)) return { kind: "wait", why: "report" };
  const at = asked.get(id);
  // Just asked: it may not be in the queue yet. Taken out of it since (Ash removed it): the turn's last words go.
  if (at !== undefined) return now - at < FOLLOW_GRACE_MS ? { kind: "wait", why: "report" } : settle(last.reply, last.failure);
  return { kind: "ask", request: reportRequest(row) };
}

/**
 * The turn whose reply is the report: the brief's own, or for a Lead the last turn in which one of its workers for
 * this brief reported to it (the Lead's reply to that is its final word on the brief). Other briefs' turns in the same
 * long-running chat never count. Returns that turn's user bubble index and the request id it carries.
 */
function reportTurn(row: Delegation, chat: Session, children: readonly Delegation[]): { at: number; requestId: string } {
  let best = { at: briefSentAt(row, chat), requestId: row.requestId };
  if (row.follow !== "lead") return best;
  const reports = new Set(
    children
      .filter((child) => child.parentId === row.id)
      .flatMap((child) => [child.deliveryMessage, completionReceipt(child.requestId, child.generation)])
      .filter((id): id is string => !!id),
  );
  chat.blocks.forEach((block, at) => {
    if (block.role === "user" && block.appRequestId && reports.has(block.appRequestId) && at > best.at)
      best = { at, requestId: block.appRequestId };
  });
  return best;
}

/** The report: the chat's reply to the brief (a Lead's: its reply after its workers' reports), or the error it hit. */
export function followedResult(
  row: Delegation,
  chat: Session,
  children: readonly Delegation[] = [],
): MonoSessionCompletionResult {
  const turn = reportTurn(row, chat, children);
  const after: typeof chat.blocks = [];
  for (const block of chat.blocks.slice(Math.max(0, turn.at) + 1)) {
    if (block.role === "user") break;
    after.push(block);
  }
  const failure = [...after].reverse().find((b) => b.role === "system" && b.notice === "error");
  const replied = after.some((b) => b.role === "assistant" && !b.tool && !b.internal && b.text.trim());
  const failed = !!failure && !replied;
  return monoSessionCompletionResult({
    requestId: turn.requestId,
    sessionId: chat.id,
    project: chat.cwd,
    prompt: row.brief ?? "",
    outcome: failed ? { status: "failed", text: "", error: failure!.text } : { status: "completed", text: "" },
    session: chat,
  });
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
  let at = -1;
  owner.blocks.forEach((b, index) => {
    if (b.role === "user" && b.appRequestId === receipt) at = index;
  });
  if (at < 0) return undefined;
  let answer = "";
  for (const block of owner.blocks.slice(at + 1)) {
    if (block.role === "user") break;
    if (block.role === "assistant" && !block.tool && !block.internal && block.text.trim()) answer = block.text;
  }
  return { report: row.result ?? "", answer };
}
