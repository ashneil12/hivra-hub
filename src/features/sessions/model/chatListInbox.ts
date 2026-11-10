// Optional chat list inbox (WP-113). Settle and snooze live in their own document,
// never on the session, so a chat can leave the active list without deleting
// anything. Being built is not read or sorted here.
import { lastTurnFailure } from "../../monos/model/turnFailure";
import { hasPendingApproval, type Session } from "./session";

export const INBOX_STATE_KEY = "monocode.chatListInboxState";

export const EMPTY_INBOX: InboxDoc = { rev: 0, chats: {} };

export type InboxMark = {
  touch: number;
  settledAt?: number;
  snoozeAt?: number;
  snoozeUntil?: number;
};

/** A stored mark, or a clear that only exists so a newer write can win a merge. */
export type InboxDoc = {
  rev: number;
  chats: Record<string, InboxMark | undefined>;
};

export type ChatAttention = {
  needsApproval: boolean;
  hasQuestion: boolean;
  failed: boolean;
  /** Approval, a question, or a failed turn. A person's own message is not this. */
  needsPerson: boolean;
  /**
   * Epoch ms the newest of those needs began (the approval was asked, the question was asked, the turn failed), when
   * known. A need with no time cannot be shown to be newer than a settle, so it does not undo one.
   */
  needAt?: number;
  /**
   * An approval the person must answer has no time: the list was told of it from elsewhere (the Sidebar's approval ids,
   * which also cover a Lead whose worker asks and a chat in a remote project), or its card carries none. It cannot be
   * shown to be older than a settle, and an approval is never hidden, so it brings a settled chat back and the chat
   * cannot be settled while it waits.
   */
  approvalUndated?: boolean;
  ownMessage: "none" | "undated" | "at";
  lastUserMessageAt: number | null;
  repliedAt?: number;
};

export type AttentionBlock = {
  id?: string;
  role: string;
  text?: string;
  draft?: boolean;
  internal?: boolean;
  streaming?: boolean;
  startedAt?: number;
  sentAt?: number;
  durationMs?: number;
  notice?: string;
  monoNote?: unknown;
  monoCheck?: unknown;
  monoSessionCompletion?: unknown;
  approval?: { decided?: string; at?: number };
  failure?: { at?: number; errorClass?: string; retryable?: boolean; resetsAt?: number };
};

export type InboxShelf = "active" | "settled" | "snoozed";

export type InboxCommand =
  | { type: "settle"; at: number }
  | { type: "unsettle"; at: number }
  | { type: "snooze"; at: number; until: number }
  | { type: "unsnooze"; at: number }
  | { type: "restore"; at: number; marks: Readonly<Record<string, InboxMark | undefined>> };

export type AutoSettleInput = {
  enabled: boolean;
  mergedAt: number;
  ownMessage: ChatAttention["ownMessage"];
  lastUserMessageAt: number | null;
  alreadySettled: boolean;
};

export const SNOOZE_PRESETS = [
  { id: "1h", label: "In 1 hour" },
  { id: "3h", label: "In 3 hours" },
  { id: "evening", label: "This evening" },
  { id: "tomorrow", label: "Tomorrow morning" },
  { id: "next-week", label: "Next week" },
] as const;

export type SnoozePreset = (typeof SNOOZE_PRESETS)[number]["id"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function validChatId(id: string): boolean {
  if (id.length < 1 || id.length > 200) return false;
  for (let i = 0; i < id.length; i += 1) {
    const code = id.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function finiteAt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/** Drop a mark that does not still settle or snooze. A bare touch is a clear. */
export function cleanMark(mark: InboxMark | undefined): InboxMark | undefined {
  if (!mark) return undefined;
  const settledAt = finiteAt(mark.settledAt);
  const snoozeAt = finiteAt(mark.snoozeAt);
  const snoozeUntil = finiteAt(mark.snoozeUntil);
  const snooze = snoozeAt != null && snoozeUntil != null && snoozeUntil > snoozeAt;
  if (settledAt == null && !snooze) return undefined;
  const touch = finiteAt(mark.touch) ?? settledAt ?? snoozeAt ?? 0;
  return {
    touch,
    ...(settledAt != null ? { settledAt } : {}),
    ...(snooze ? { snoozeAt, snoozeUntil } : {}),
  };
}

export function parseInboxDoc(raw: string | null | undefined): InboxDoc {
  if (raw == null) return { rev: 0, chats: {} };
  const text = raw.replace(/^﻿/, "").trim();
  if (!text) return { rev: 0, chats: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { rev: 0, chats: {} };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { rev: 0, chats: {} };
  const rec = value as Record<string, unknown>;
  const rev = typeof rec.rev === "number" && Number.isSafeInteger(rec.rev) && rec.rev >= 0 ? rec.rev : 0;
  const chatsIn = rec.chats;
  if (!chatsIn || typeof chatsIn !== "object" || Array.isArray(chatsIn)) return { rev, chats: {} };
  const chats: Record<string, InboxMark> = {};
  for (const [id, mark] of Object.entries(chatsIn)) {
    if (!validChatId(id) || !mark || typeof mark !== "object" || Array.isArray(mark)) continue;
    const fields = mark as Record<string, unknown>;
    const settledAt = finiteAt(fields.settledAt);
    const snoozeAt = finiteAt(fields.snoozeAt);
    const snoozeUntilAt = finiteAt(fields.snoozeUntil);
    const touch = finiteAt(fields.touch) ?? settledAt ?? snoozeAt;
    if (touch == null) continue;
    const kept = cleanMark({
      touch,
      ...(settledAt != null ? { settledAt } : {}),
      ...(snoozeAt != null ? { snoozeAt } : {}),
      ...(snoozeUntilAt != null ? { snoozeUntil: snoozeUntilAt } : {}),
    });
    if (kept) chats[id] = kept;
  }
  return { rev, chats };
}

export function stripInbox(doc: InboxDoc): InboxDoc {
  const chats: Record<string, InboxMark> = {};
  for (const [id, mark] of Object.entries(doc.chats)) {
    if (!validChatId(id)) continue;
    const kept = cleanMark(mark);
    if (kept) chats[id] = kept;
  }
  const rev = Number.isSafeInteger(doc.rev) && doc.rev >= 0 ? doc.rev : 0;
  return { rev, chats };
}

function marksEqual(a: InboxMark | undefined, b: InboxMark | undefined): boolean {
  const left = cleanMark(a);
  const right = cleanMark(b);
  if (!left || !right) return !left && !right;
  return (
    left.touch === right.touch &&
    left.settledAt === right.settledAt &&
    left.snoozeAt === right.snoozeAt &&
    left.snoozeUntil === right.snoozeUntil
  );
}

function touchOf(mark: InboxMark | undefined): number {
  if (!mark || !Number.isFinite(mark.touch)) return Number.NEGATIVE_INFINITY;
  return mark.touch;
}

/**
 * Two windows wrote since the same base. The higher touch wins for that chat.
 * A tie keeps the latest window's mark. A clear is a mark with only a touch.
 */
export function mergeInbox(base: InboxDoc, ours: InboxDoc, latest: InboxDoc): InboxDoc {
  const ids = new Set([
    ...Object.keys(base.chats),
    ...Object.keys(ours.chats),
    ...Object.keys(latest.chats),
  ]);
  const chats: Record<string, InboxMark | undefined> = {};
  for (const id of ids) {
    const before = base.chats[id];
    const own = ours.chats[id];
    const other = latest.chats[id];
    const ownChanged = !sameRaw(before, own);
    const otherChanged = !sameRaw(before, other);
    let chosen: InboxMark | undefined;
    if (ownChanged && otherChanged) chosen = touchOf(own) > touchOf(other) ? own : other;
    else if (ownChanged) chosen = own;
    else chosen = other ?? before;
    if (chosen) chats[id] = chosen;
  }
  return { rev: Math.max(base.rev, ours.rev, latest.rev), chats };
}

function sameRaw(a: InboxMark | undefined, b: InboxMark | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.touch === b.touch && a.settledAt === b.settledAt && a.snoozeAt === b.snoozeAt && a.snoozeUntil === b.snoozeUntil;
}

function nextMark(prev: InboxMark | undefined, command: Exclude<InboxCommand, { type: "restore" }>): InboxMark | undefined {
  if (command.type === "settle") return { touch: command.at, settledAt: command.at };
  if (command.type === "snooze") {
    if (!(Number.isFinite(command.until) && command.until > command.at)) return prev;
    return { touch: command.at, snoozeAt: command.at, snoozeUntil: command.until };
  }
  if (command.type === "unsettle") {
    const kept = cleanMark(prev);
    if (kept?.snoozeAt != null && kept.snoozeUntil != null) {
      return { touch: command.at, snoozeAt: kept.snoozeAt, snoozeUntil: kept.snoozeUntil };
    }
    return undefined;
  }
  const settled = cleanMark(prev);
  if (settled?.settledAt != null) return { touch: command.at, settledAt: settled.settledAt };
  return undefined;
}

export function applyInbox(
  doc: InboxDoc,
  ids: readonly string[],
  command: InboxCommand,
): { doc: InboxDoc; previous: Record<string, InboxMark | undefined> } {
  const previous: Record<string, InboxMark | undefined> = {};
  const chats = { ...doc.chats };
  const seen = new Set<string>();
  for (const id of ids) {
    if (!validChatId(id) || seen.has(id)) continue;
    if (command.type === "snooze" && !(Number.isFinite(command.until) && command.until > command.at)) continue;
    seen.add(id);
    previous[id] = chats[id];
    if (command.type === "restore") {
      const saved = command.marks[id];
      const kept = cleanMark(saved);
      chats[id] = kept ? { ...kept, touch: command.at } : { touch: command.at };
      continue;
    }
    const next = nextMark(chats[id], command);
    chats[id] = next ?? { touch: command.at };
  }
  return { doc: { rev: doc.rev, chats }, previous };
}

export function storedMarksEqual(a: InboxMark | undefined, b: InboxMark | undefined): boolean {
  return marksEqual(a, b);
}

export function chatAttention(session: {
  busy?: boolean;
  worktreeRemoved?: boolean;
  usageLimit?: Session["usageLimit"];
  pendingQuestion?: unknown;
  blocks: readonly AttentionBlock[];
}): ChatAttention {
  const removed = session.worktreeRemoved === true;
  const blocks = session.blocks.map((block, index) => ({
    ...block,
    id: block.id ?? `block-${index}`,
    text: block.text ?? "",
  })) as Session["blocks"];
  const needsApproval = !removed && session.busy !== false && hasPendingApproval(blocks);
  const hasQuestion = !removed && session.pendingQuestion != null;
  const failed =
    !removed &&
    lastTurnFailure({
      blocks,
      busy: session.busy,
      usageLimit: session.usageLimit,
      worktreeRemoved: session.worktreeRemoved,
    }) != null;
  const own = lastOwnMessage(session.blocks);
  const repliedAt = lastReplyAt(session.blocks);
  const approvalUndated = needsApproval && hasUndatedApprovalCard(session.blocks);
  const needAt = newestNeedAt([
    needsApproval ? newestApprovalAt(session.blocks) : undefined,
    hasQuestion ? askedAt(session.pendingQuestion) : undefined,
    failed ? failureAt(session) : undefined,
  ]);
  return {
    needsApproval,
    hasQuestion,
    failed,
    needsPerson: needsApproval || hasQuestion || failed,
    ...(needAt != null ? { needAt } : {}),
    ...(approvalUndated ? { approvalUndated } : {}),
    ownMessage: own.kind,
    lastUserMessageAt: own.kind === "at" ? own.at : null,
    ...(repliedAt != null ? { repliedAt } : {}),
  };
}

function newestNeedAt(times: readonly (number | undefined)[]): number | undefined {
  const known = times.filter((at): at is number => at != null && Number.isFinite(at) && at > 0);
  return known.length > 0 ? Math.max(...known) : undefined;
}

/** When the newest undecided approval card was asked, from the card itself. */
function newestApprovalAt(blocks: readonly AttentionBlock[]): number | undefined {
  return newestNeedAt(blocks.map((block) => (block.approval && !block.approval.decided ? block.approval.at : undefined)));
}

/** An undecided approval card with no time of its own. */
function hasUndatedApprovalCard(blocks: readonly AttentionBlock[]): boolean {
  return blocks.some(
    (block) =>
      block.approval &&
      !block.approval.decided &&
      !(typeof block.approval.at === "number" && Number.isFinite(block.approval.at) && block.approval.at > 0),
  );
}

function askedAt(question: unknown): number | undefined {
  const at = question && typeof question === "object" ? (question as { askedAt?: unknown }).askedAt : undefined;
  return typeof at === "number" ? at : undefined;
}

/** When the last turn failed: the error notice's time. A chat stopped at its usage limit with no notice has none. */
function failureAt(session: Parameters<typeof chatAttention>[0]): number | undefined {
  const blocks = session.blocks.map((block, index) => ({
    ...block,
    id: block.id ?? `block-${index}`,
    text: block.text ?? "",
  })) as Session["blocks"];
  return lastTurnFailure({
    blocks,
    busy: session.busy,
    usageLimit: session.usageLimit,
    worktreeRemoved: session.worktreeRemoved,
  })?.at;
}

function isOwnMessage(block: AttentionBlock): boolean {
  return (
    block.role === "user" &&
    !block.draft &&
    !block.internal &&
    block.monoNote == null &&
    block.monoCheck == null &&
    block.monoSessionCompletion == null
  );
}

function lastOwnMessage(blocks: readonly AttentionBlock[]): { kind: "none" | "undated" | "at"; at: number | null } {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (!block || !isOwnMessage(block)) continue;
    const at = block.sentAt ?? block.startedAt;
    if (at == null || !Number.isFinite(at)) return { kind: "undated", at: null };
    return { kind: "at", at };
  }
  return { kind: "none", at: null };
}

function lastReplyAt(blocks: readonly AttentionBlock[]): number | undefined {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (!block || block.role !== "assistant" || block.streaming) continue;
    if (typeof block.text === "string" && /^API Error\b/.test(block.text)) continue;
    for (let j = i - 1; j >= 0; j -= 1) {
      const user = blocks[j];
      if (!user || !isOwnMessage(user)) continue;
      if (user.startedAt == null || !Number.isFinite(user.startedAt)) return undefined;
      if (user.durationMs != null && user.durationMs >= 0 && Number.isFinite(user.durationMs)) {
        return user.startedAt + user.durationMs;
      }
      return user.startedAt;
    }
    return undefined;
  }
  return undefined;
}

/** A snoozed chat comes back before its time for approval, a question, a failure, or the person's own message. */
export function wakesEarly(snoozeAt: number, attention: ChatAttention): boolean {
  if (attention.needsApproval || attention.hasQuestion || attention.failed) return true;
  if (attention.ownMessage === "undated") return true;
  return attention.ownMessage === "at" && attention.lastUserMessageAt != null && attention.lastUserMessageAt > snoozeAt;
}

/**
 * A settled chat comes back, like an archived mail thread, when it needs the person again or gets a new message.
 *
 * Needs the person again: an approval, a question or a failed turn that began after it was settled. One that was
 * already there when the person settled the chat does not undo it (they settled it knowing that), so settling a chat
 * with a failed turn, a usage limit or an open question keeps it settled, and it does not drop back to the shelf later
 * only when that need clears.
 *
 * An approval is the exception: it is never hidden. One with no time (`approvalUndated`) cannot be shown to be older than
 * the settle, so it brings the chat back, and the Settle action is disabled while one waits (`inboxMenuChoices`).
 *
 * A new message: the person writes after the settle, or a turn the person started finishes after it. A turn the app
 * starts itself, such as one a worker's report begins, does not: `repliedAt` only follows the person's own messages, so
 * the app's own notes do not unsettle a chat.
 *
 * A need or a message with no time cannot be shown to be newer than the settle, so it does not undo one.
 */
export function settledWakes(settledAt: number, attention: ChatAttention): boolean {
  if (attention.approvalUndated) return true;
  if (attention.needsPerson && attention.needAt != null && attention.needAt > settledAt) return true;
  const wrote =
    attention.ownMessage === "at" && attention.lastUserMessageAt != null && attention.lastUserMessageAt > settledAt;
  return wrote || (attention.repliedAt != null && attention.repliedAt > settledAt);
}

export function shelfFor(mark: InboxMark | undefined, now: number, attention?: ChatAttention): InboxShelf {
  const kept = cleanMark(mark);
  if (!kept) return "active";
  if (kept.settledAt != null) return attention && settledWakes(kept.settledAt, attention) ? "active" : "settled";
  if (kept.snoozeAt == null || kept.snoozeUntil == null) return "active";
  if (!Number.isFinite(now)) return "snoozed";
  if (now >= kept.snoozeUntil) return "active";
  if (attention && wakesEarly(kept.snoozeAt, attention)) return "active";
  return "snoozed";
}

export function splitInboxSessions<T extends { id: string }>(
  rows: readonly T[],
  input: {
    enabled: boolean;
    marks: Readonly<Record<string, InboxMark | undefined>>;
    now: number;
    attention?: ReadonlyMap<string, ChatAttention>;
  },
): { active: T[]; settled: T[]; snoozed: T[] } {
  if (!input.enabled) return { active: [...rows], settled: [], snoozed: [] };
  const active: T[] = [];
  const settled: T[] = [];
  const snoozed: T[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    const shelf = shelfFor(input.marks[row.id], input.now, input.attention?.get(row.id));
    if (shelf === "settled") settled.push(row);
    else if (shelf === "snoozed") snoozed.push(row);
    else active.push(row);
  }
  return { active, settled, snoozed };
}

export type InboxSortRow = {
  id: string;
  pinned?: boolean;
  updatedAt: number;
};

/**
 * Off matches today's list: pin, then last update, then id.
 * On puts a chat that needs the person first, then the later of the update and the reply.
 * Pin still wins. This never looks at Being built.
 */
export function compareInboxOrder(
  a: InboxSortRow,
  b: InboxSortRow,
  enabled: boolean,
  attention?: ReadonlyMap<string, ChatAttention>,
): number {
  const pin = Number(!!b.pinned) - Number(!!a.pinned);
  if (pin !== 0) return pin;
  if (!enabled) return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
  const need = Number(!!attention?.get(b.id)?.needsPerson) - Number(!!attention?.get(a.id)?.needsPerson);
  if (need !== 0) return need;
  const back = (row: InboxSortRow) => {
    const replied = attention?.get(row.id)?.repliedAt;
    return Math.max(row.updatedAt, replied ?? Number.NEGATIVE_INFINITY);
  };
  return back(b) - back(a) || a.id.localeCompare(b.id);
}

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * The attention map with the Sidebar's approval ids added: chats the list is told need the person from elsewhere.
 *
 * An id is listed for a need of the chat's own (its approval card, its open question) or for a worker's approval it
 * leads. `elsewhereIds` names the second kind (a subset of `approvalIds`), so the two are told apart:
 * - listed for a worker's approval: the approval has no time and is never hidden, whatever the chat has of its own (an
 *   open question, an approval card with a time, a failed turn), so it brings a settled chat back and Settle is off;
 * - listed for its own question: that question has a time and a settle holds for it, so it is not an approval from
 *   elsewhere;
 * - listed with no reason known (a remote project's chat): taken as an approval with no time, unless the chat has its
 *   own question or approval to explain the listing.
 */
export function attentionWithApprovals(
  attention: ReadonlyMap<string, ChatAttention> | undefined,
  approvalIds: ReadonlySet<string>,
  elsewhereIds: ReadonlySet<string> = NO_IDS,
): ReadonlyMap<string, ChatAttention> {
  if (approvalIds.size === 0) return attention ?? new Map();
  const next = new Map(attention ?? []);
  for (const id of approvalIds) {
    const current = next.get(id);
    const workers = elsewhereIds.has(id);
    // Its own transcript already holds an approval, and nothing from elsewhere is added to it.
    if (current?.needsApproval && !(workers && !current.approvalUndated)) continue;
    next.set(id, {
      needsApproval: true,
      hasQuestion: current?.hasQuestion ?? false,
      failed: current?.failed ?? false,
      needsPerson: true,
      // The need it already had keeps its time. An approval listed from elsewhere has none to add, so it is undated and
      // never hidden. A chat whose only need is its own open question is listed too (the ids mean "needs input"), and
      // that question has a time of its own, so it is not an approval from elsewhere unless a worker's is listed too.
      ...(current?.needAt != null ? { needAt: current.needAt } : {}),
      ...(workers || !current?.hasQuestion ? { approvalUndated: true } : {}),
      ownMessage: current?.ownMessage ?? "none",
      lastUserMessageAt: current?.lastUserMessageAt ?? null,
      ...(current?.repliedAt != null ? { repliedAt: current.repliedAt } : {}),
    });
  }
  return next;
}

/** A merged pull request can settle the chat only when the person has not written since the merge. */
export function autoSettleOnMerge(input: AutoSettleInput): boolean {
  if (!input.enabled || input.alreadySettled) return false;
  if (!Number.isFinite(input.mergedAt) || input.mergedAt <= 0) return false;
  if (input.ownMessage === "undated") return false;
  if (input.ownMessage === "at" && input.lastUserMessageAt != null && input.lastUserMessageAt > input.mergedAt) {
    return false;
  }
  return true;
}

export function settleIfMerged(doc: InboxDoc, id: string, input: AutoSettleInput, now: number): InboxDoc {
  if (!autoSettleOnMerge(input) || !validChatId(id)) return doc;
  return applyInbox(doc, [id], { type: "settle", at: now }).doc;
}

export function inboxNoticeCopy(
  command: "settle" | "unsettle" | "snooze" | "unsnooze",
  count: number,
  untilLabel?: string,
): { text: string; sr: string } {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  let text: string;
  if (command === "settle") text = n === 1 ? "Settled this chat." : `Settled ${n} chats.`;
  else if (command === "unsettle") text = n === 1 ? "Brought this chat back." : `Brought ${n} chats back.`;
  else if (command === "unsnooze") text = n === 1 ? "Unsnoozed this chat." : `Unsnoozed ${n} chats.`;
  else {
    const when = untilLabel && untilLabel.trim() ? untilLabel.trim() : "later";
    text = n === 1 ? `Snoozed this chat until ${when}.` : `Snoozed ${n} chats until ${when}.`;
  }
  return { text, sr: text };
}

/** Clock matches a reminder: one hour, three hours, this evening, tomorrow morning, next Monday. */
export function snoozeUntil(preset: SnoozePreset, now: Date): number | null {
  if (preset === "1h") return now.getTime() + 60 * 60 * 1000;
  if (preset === "3h") return now.getTime() + 3 * 60 * 60 * 1000;
  const date = new Date(now.getTime());
  if (preset === "evening") date.setHours(18, 0, 0, 0);
  else if (preset === "tomorrow") {
    date.setDate(date.getDate() + 1);
    date.setHours(9, 0, 0, 0);
  } else if (preset === "next-week") {
    date.setDate(date.getDate() + ((8 - date.getDay()) % 7 || 7));
    date.setHours(9, 0, 0, 0);
  } else return null;
  return date.getTime() > now.getTime() ? date.getTime() : null;
}

export function parseSnoozeChoice(value: string, now: number): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match || !Number.isFinite(now)) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] != null ? Number(match[6]) : 0;
  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    return null;
  }
  if (date.getTime() <= now) return null;
  return date.getTime();
}

export function formatSnoozeWhen(until: number, now: number): string {
  if (!Number.isFinite(until) || !Number.isFinite(now)) return "later";
  const when = new Date(until);
  const clock = formatClock(when);
  const start = new Date(now);
  if (sameDay(when, start)) return clock;
  const tomorrow = new Date(start.getTime());
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (sameDay(when, tomorrow)) return `tomorrow at ${clock}`;
  return `${MONTHS[when.getMonth()]} ${when.getDate()} at ${clock}`;
}

function formatClock(date: Date): string {
  let hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const suffix = hours >= 12 ? "pm" : "am";
  hours %= 12;
  if (hours === 0) hours = 12;
  return `${hours}:${minutes} ${suffix}`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** True when any of these chats has an approval waiting whose time is not known (Settle is off for the selection). */
export function settleHeldBack(
  ids: readonly string[],
  attention: ReadonlyMap<string, ChatAttention> | undefined,
): boolean {
  return !!attention && ids.some((id) => attention.get(id)?.approvalUndated === true);
}

export type InboxMenuChoice = {
  id: string;
  label: string;
  /** Why the choice is disabled, in plain words. */
  description?: string;
  disabled?: boolean;
  children?: { id: string; label: string; disabled?: boolean }[];
};

/** Why Settle is off while an approval waits whose time is not known: settling it would bounce straight back. */
export function settleBlockedReason(count: number): string {
  return count === 1 ? "Answer its approval first" : "Answer their approvals first";
}

export function inboxMenuChoices(
  ids: readonly string[],
  marks: Readonly<Record<string, InboxMark | undefined>>,
  now: Date,
  attention?: ReadonlyMap<string, ChatAttention>,
): InboxMenuChoice[] {
  const heldBack = settleHeldBack(ids, attention);
  const snoozed = ids.some((id) => {
    const mark = cleanMark(marks[id]);
    return mark?.snoozeAt != null && mark.snoozeUntil != null;
  });
  return [
    ...(snoozed ? [{ id: "inbox-unsnooze", label: "Unsnooze" }] : []),
    heldBack
      ? { id: "inbox-settle", label: "Settle", disabled: true, description: settleBlockedReason(ids.length) }
      : { id: "inbox-settle", label: "Settle" },
    {
      id: "inbox-snooze",
      label: "Snooze",
      children: [
        ...SNOOZE_PRESETS.map((preset) => ({
          id: `inbox-snooze:${preset.id}`,
          label: preset.label,
          disabled: snoozeUntil(preset.id, now) == null,
        })),
        { id: "inbox-snooze:choose", label: "Choose a time" },
      ],
    },
  ];
}
