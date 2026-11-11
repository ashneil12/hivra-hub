// Hivra WP-15: first-mate items in the Inbox. A new kind, beside the GitHub list, not inside it.

import { sameProjectPath } from "../../projects/model/recents";
import limits from "./decisionLimits.json";
import type { Notice } from "./digest";
import { firstPlainLine, type CrewDeliveryInput, type CrewWorkerInput } from "./rows";
import { knownStatus, statusWord } from "./words";

/** The same cap the decision store uses. A secret card is never cut to fit it; the store refuses a longer question. */
export const QUESTION_MAX = limits.questionMax;

export type FirstMateInboxKind = "decision" | "question" | "review" | "failure" | "credential";

export type DecisionInput = {
  project?: string | null;
  decisionKey?: string | null;
  question?: string | null;
  options?: unknown;
  recommended?: string | null;
  askedBy?: string | null;
  waiting?: unknown;
  state?: string | null;
  /** When it was asked. The wait is counted from here, never from `updatedAt`. */
  createdAt?: number;
  updatedAt?: number;
};

export type FirstMateItem = {
  id: string;
  kind: FirstMateInboxKind;
  title: string;
  body: string;
  statusWord: string | null;
  chatId: string | null;
  workerIds: string[];
  options: string[];
  recommended: string | null;
  /** WP-92: a line that sits under the answer buttons (a secret card's warning about "Always"). */
  note?: string | null;
  project: string;
  key: string | null;
  /**
   * When this item started waiting on a person: a decision from when it was asked, a blocked row from when it got
   * stuck, a failed or finished row from when it ended, any other row from when it was created. Zero when that start
   * is not known. It is never the last update:
   * a stream update or a refresh must not reset how long someone has waited.
   */
  since: number;
  /** The newest change to the item. It names the item's notice for the digest, and says nothing about how long it waited. */
  updatedAt: number;
};

const CREDENTIAL_CLASS = new Set(["auth", "billing", "usage_limit"]);

function cleanPath(value: string): string {
  return value.replace(/\r/g, "").trim();
}

function inProject(path: string | null | undefined, project: string): boolean {
  if (typeof path !== "string") return false;
  const cleaned = cleanPath(path);
  return cleaned !== "" && sameProjectPath(cleaned, project);
}

function firstLine(value: string | null | undefined, max: number): string {
  const line = (value ?? "").replace(/\r\n/g, "\n").split("\n")[0]?.trim() ?? "";
  return line.slice(0, max);
}

const SECRET_WARNING = "Warning: ";

/**
 * WP-92: a secret's approval card is the app's own words over several lines: a title, then the exact command and why it
 * asks, then (when "Always" is offered for a program that can run any code) a warning for under the buttons. Only a
 * `secret/` key is read this way; the app alone makes those (an agent's `ask_person` cannot).
 */
function secretCardParts(question: string | null | undefined): { title: string; body: string; note: string | null } {
  const lines = (question ?? "").replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
  const note = lines.find((line, at) => at > 0 && line.startsWith(SECRET_WARNING));
  const body = lines.filter((line, at) => at > 0 && line !== note);
  return {
    title: (lines[0] ?? "").slice(0, 160),
    body: body.join("\n"),
    note: note ? note.slice(SECRET_WARNING.length) : null,
  };
}

/** Em dashes and en dashes never reach a person. A number range keeps a hyphen. */
function plain(value: string): string {
  return value
    .replace(/(\d)\s*[—–]\s*(?=\d)/g, "$1-")
    .replace(/[ \t]*[—–][ \t]*/g, ", ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[,\s]+|[,\s]+$/g, "")
    .trim();
}

function shown(value: string): string {
  return plain(value);
}

/**
 * How long a row has been waiting, from the timestamp the row already has.
 * Nothing is said when that start, or the clock, is missing.
 */
export function waitingPhrase(since: number, now: number): string | null {
  if (typeof since !== "number" || !Number.isFinite(since) || since <= 0) return null;
  if (typeof now !== "number" || !Number.isFinite(now) || now < since) return null;
  const minutes = Math.floor((now - since) / 60_000);
  if (minutes < 1) return "waiting under a minute";
  if (minutes < 60) return minutes === 1 ? "waiting 1 minute" : `waiting ${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours === 1 ? "waiting 1 hour" : `waiting ${hours} hours`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "waiting 1 day" : `waiting ${days} days`;
}

function waitKey(value: number): number {
  return value > 0 && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function stamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * When a row began to wait: a blocked row from when it got stuck, a failed or finished one from when it ended (a worker
 * made at 09:00 that fails at 12:00 has waited since 12:00), any other from when it was created.
 */
function rowSince(row: CrewWorkerInput): number {
  if (row.stallKind === "blocked") {
    const stalled = stamp(row.stalledAt);
    if (stalled > 0) return stalled;
  }
  const status = knownStatus(row.status);
  if (status === "failed" || status === "done") {
    const ended = stamp(row.settledAt);
    if (ended > 0) return ended;
  }
  return stamp(row.createdAt);
}

/** The first plain line of a failure. A stack frame or a secret is not shown. */
export function failureWords(notice?: string | null, error?: string | null): string {
  return firstPlainLine(`${notice ?? ""}\n${error ?? ""}`) ?? "This work failed.";
}

function credential(row: CrewWorkerInput): boolean {
  if (CREDENTIAL_CLASS.has((row.errorClass ?? "").trim())) return true;
  const text = `${row.statusNotice ?? ""}\n${row.error ?? ""}`.toLowerCase();
  if (knownStatus(row.status) === "paused" && /usage limit|quota/.test(text)) return true;
  return /sign[- ]in|not signed in|missing cli|isn't installed|is not installed/.test(text);
}

function credentialTitle(row: CrewWorkerInput): string {
  const kind = (row.errorClass ?? "").trim();
  const text = `${row.statusNotice ?? ""}\n${row.error ?? ""}`.toLowerCase();
  if (kind === "usage_limit" || /usage limit|quota/.test(text)) return "Waiting for a usage limit";
  if (/missing cli|isn't installed|is not installed/.test(text)) return "The CLI is missing";
  return "Needs a sign-in";
}

/**
 * A needs-you row that is blocked on a permission, not on a question. Only the status notice and the error say so:
 * the title is what the work is called, and "Fix the permission check" is not a permission ask.
 */
function permissionAsk(row: CrewWorkerInput): boolean {
  if (knownStatus(row.status) !== "needs-you") return false;
  const text = `${row.statusNotice ?? ""}\n${row.error ?? ""}`.toLowerCase();
  return /permission|access denied|not allowed/.test(text);
}

function optionsOf(value: unknown, recommended: string | null | undefined): { options: string[]; recommended: string | null } {
  if (!Array.isArray(value)) return { options: [], recommended: null };
  const options: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.trim().slice(0, 200);
    if (!text || options.includes(text)) continue;
    options.push(text);
    if (options.length === 12) break;
  }
  const mark = (recommended ?? "").trim();
  return { options, recommended: mark && options.includes(mark) ? mark : null };
}

function waitingOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

function landed(delivery: CrewDeliveryInput | undefined): boolean {
  const state = (delivery?.state ?? "").trim();
  return state === "landed" || state === "merged" || state === "closed";
}

function newest(id: string, deliveries: readonly CrewDeliveryInput[]): CrewDeliveryInput | undefined {
  let best: CrewDeliveryInput | undefined;
  for (const delivery of deliveries) {
    if (delivery.delegationId !== id) continue;
    if (!best || (delivery.updatedAt ?? 0) >= (best.updatedAt ?? 0)) best = delivery;
  }
  return best;
}

/**
 * What the Inbox shows for one project. Questions first, then a sign-in or a
 * permission, then failures and reviews together. Within a group, the longest
 * wait first. A row's status word is copied, never chosen here.
 */
export function inboxItems(input: {
  project: string;
  decisions?: readonly DecisionInput[];
  rows?: readonly CrewWorkerInput[];
  deliveries?: readonly CrewDeliveryInput[];
}): FirstMateItem[] {
  const project = cleanPath(input.project ?? "");
  if (!project || project === "~") return [];
  const items: FirstMateItem[] = [];
  const decisions = new Map<string, DecisionInput>();
  for (const decision of input.decisions ?? []) {
    const key = (decision.decisionKey ?? "").trim();
    if (!key || decision.state === "answered") continue;
    if (!inProject(decision.project, project)) continue;
    const previous = decisions.get(key);
    if (!previous || (decision.updatedAt ?? 0) >= (previous.updatedAt ?? 0)) decisions.set(key, decision);
  }
  const waitingOnDecision = new Set<string>();
  for (const decision of decisions.values()) {
    const key = (decision.decisionKey ?? "").trim();
    const choice = optionsOf(decision.options, decision.recommended);
    const waiting = waitingOf(decision.waiting);
    for (const id of waiting) waitingOnDecision.add(id);
    const secret = key.startsWith("secret/") ? secretCardParts(decision.question) : null;
    items.push({
      id: `decision:${project}:${key}`,
      kind: "decision",
      // A secret's card is the exact command the person approves: it is not run through `shown`, which would rewrite
      // dashes and collapse spaces. The Rust side already wrote out every character that could mislead.
      title: (secret ? secret.title : shown(firstLine(decision.question, 160))) || "A decision is waiting",
      body: secret ? secret.body : "",
      note: secret ? secret.note : null,
      statusWord: "needs you",
      chatId: firstLine(decision.askedBy, 200) || null,
      workerIds: waiting,
      options: choice.options,
      recommended: choice.recommended,
      project,
      key,
      since: stamp(decision.createdAt),
      updatedAt: decision.updatedAt ?? 0,
    });
  }
  const seen = new Set<string>();
  const rows = [...(input.rows ?? [])].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  for (const row of rows) {
    if (!row?.id || seen.has(row.id) || row.follow === "lead") continue;
    if (!inProject(row.project, project)) continue;
    seen.add(row.id);
    const status = knownStatus(row.status);
    if (!status || waitingOnDecision.has(row.id)) continue;
    const word = statusWord(status);
    const delivery = newest(row.id, input.deliveries ?? []);
    if (credential(row)) {
      items.push({
        id: `credential:${row.id}`,
        kind: "credential",
        title: shown(credentialTitle(row)),
        body: shown(failureWords(row.statusNotice, row.error)),
        statusWord: word,
        chatId: row.childSession ?? null,
        workerIds: [row.id],
        options: [],
        recommended: null,
        project,
        key: null,
        since: rowSince(row),
        updatedAt: row.updatedAt ?? 0,
      });
      continue;
    }
    if (permissionAsk(row)) {
      items.push({
        id: `credential:${row.id}`,
        kind: "credential",
        title: "Needs a permission",
        body: shown(firstPlainLine(`${row.statusNotice ?? ""}\n${row.error ?? ""}`) ?? ""),
        statusWord: word,
        chatId: row.childSession ?? null,
        workerIds: [row.id],
        options: [],
        recommended: null,
        project,
        key: null,
        since: rowSince(row),
        updatedAt: row.updatedAt ?? 0,
      });
      continue;
    }
    if (status === "failed") {
      items.push({
        id: `failure:${row.id}`,
        kind: "failure",
        title: shown(firstLine(row.title, 120)) || "This work failed",
        body: shown(failureWords(row.statusNotice, row.error)),
        statusWord: word,
        chatId: row.childSession ?? null,
        workerIds: [row.id],
        options: [],
        recommended: null,
        project,
        key: null,
        since: rowSince(row),
        updatedAt: row.updatedAt ?? 0,
      });
      continue;
    }
    if (status === "done" && !landed(delivery)) {
      items.push({
        id: `review:${row.id}`,
        kind: "review",
        title: "Ready for review",
        body: shown(firstLine(row.title, 160)),
        statusWord: word,
        chatId: row.childSession ?? null,
        workerIds: [row.id],
        options: [],
        recommended: null,
        project,
        key: null,
        since: rowSince(row),
        updatedAt: row.updatedAt ?? 0,
      });
      continue;
    }
    if (status === "needs-you") {
      const title = shown(firstLine(row.title, 160) || firstLine(row.statusNotice, 160)) || "This work needs you";
      const notice = shown(firstPlainLine(row.statusNotice) ?? "");
      items.push({
        id: `question:${row.id}`,
        kind: "question",
        title,
        body: notice && notice !== title ? notice : "",
        statusWord: word,
        chatId: row.childSession ?? null,
        workerIds: [row.id],
        options: [],
        recommended: null,
        project,
        key: null,
        since: rowSince(row),
        updatedAt: row.updatedAt ?? 0,
      });
    }
  }
  const rank: Record<FirstMateInboxKind, number> = { decision: 0, question: 0, credential: 1, failure: 2, review: 2 };
  items.sort((a, b) => rank[a.kind] - rank[b.kind] || waitKey(a.since) - waitKey(b.since) || a.id.localeCompare(b.id));
  return items;
}

export type Answerable = {
  id: string;
  status?: unknown;
  questionOwner?: string | null;
  statusNotice?: string | null;
};

/**
 * What the screen shows once an answer is in. Only the decision's waiters move,
 * and only from needs you to working. A second answer, or an empty one, changes nothing.
 */
export function afterAnswer<T extends Answerable>(
  rows: readonly T[],
  decision: DecisionInput | undefined,
  answer: string,
): { rows: T[]; applied: boolean } {
  const text = answer.trim();
  const key = (decision?.decisionKey ?? "").trim();
  if (!decision || !key || decision.state === "answered" || !text || text.length > 2000) {
    return { rows: [...rows], applied: false };
  }
  const waiting = new Set(waitingOf(decision.waiting));
  return {
    applied: true,
    rows: rows.map((row) => {
      if (!waiting.has(row.id)) return row;
      const status = knownStatus(row.status);
      const forPerson = row.questionOwner === "person" || status === "needs-you";
      if (!forPerson || status === "failed" || status === "done") return row;
      return {
        ...row,
        status: "working",
        questionOwner: null,
        statusNotice: "Asked its first mate",
      };
    }),
  };
}

/** A credential needs the person now when they have to sign in, install a CLI, or pay. A usage limit waits. */
function credentialNeedsPerson(item: FirstMateItem, rows: readonly CrewWorkerInput[]): boolean {
  return item.workerIds.some((id) => {
    const row = rows.find((entry) => entry.id === id);
    if (!row) return false;
    if (knownStatus(row.status) === "needs-you") return true;
    const kind = (row.errorClass ?? "").trim();
    if (kind === "auth" || kind === "billing") return true;
    const text = `${row.statusNotice ?? ""}\n${row.error ?? ""}`.toLowerCase();
    return /sign[- ]in|not signed in|missing cli|isn't installed|is not installed/.test(text);
  });
}

/** Needs you goes out at once. A review, a failure, or a usage limit waits for the hourly digest. */
export function noticesFrom(items: readonly FirstMateItem[], rows: readonly CrewWorkerInput[] = []): Notice[] {
  const covered = new Set(items.flatMap((item) => item.workerIds));
  const notices: Notice[] = items.map((item) => ({
    id: `${item.id}:${item.updatedAt}`,
    immediate: item.kind === "decision" || item.kind === "question" || (item.kind === "credential" && credentialNeedsPerson(item, rows)),
    title: item.title,
    at: item.updatedAt,
  }));
  for (const row of rows) {
    if (!row?.id || knownStatus(row.status) !== "needs-you" || covered.has(row.id)) continue;
    notices.push({
      id: `needs:${row.id}:${row.updatedAt ?? 0}`,
      immediate: true,
      title: firstLine(row.title, 160) || "This work needs you",
      at: row.updatedAt ?? 0,
    });
  }
  return notices;
}

/**
 * A timed-out answer stays on screen. A load that still shows the decision open
 * must not paint the waiter back to needs you. A load that dropped the waiter keeps them.
 * Once the decision is no longer open, the load is the truth.
 */
export function preserveAnswer<T extends { id: string; status?: unknown }>(
  heldRows: readonly T[],
  loadedRows: readonly T[],
  decisionOpen: boolean,
): T[] {
  if (!decisionOpen) return [...loadedRows];
  const held = new Map(heldRows.map((row) => [row.id, row]));
  const out = loadedRows.map((row) => {
    const previous = held.get(row.id);
    if (!previous) return row;
    if (knownStatus(previous.status) === "working" && knownStatus(row.status) === "needs-you") return previous;
    return row;
  });
  for (const previous of heldRows) {
    if (knownStatus(previous.status) !== "working") continue;
    if (out.some((row) => row.id === previous.id)) continue;
    out.push(previous);
  }
  return out;
}

/** A refused answer puts the click back only when nothing newer has landed. */
export function refuseAnswer<T>(snapshot: T, current: T, newer: boolean): T {
  return newer ? current : snapshot;
}
