// Hivra WP-15: first-mate items in the Inbox. A new kind, beside the GitHub list, not inside it.

import { sameProjectPath } from "../../projects/model/recents";
import type { Notice } from "./digest";
import type { CrewDeliveryInput, CrewWorkerInput } from "./rows";
import { knownStatus, statusWord } from "./words";

export type FirstMateInboxKind = "decision" | "review" | "failure" | "credential";

export type DecisionInput = {
  project?: string | null;
  decisionKey?: string | null;
  question?: string | null;
  options?: unknown;
  recommended?: string | null;
  askedBy?: string | null;
  waiting?: unknown;
  state?: string | null;
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
  project: string;
  key: string | null;
  updatedAt: number;
};

const SECRET = /sk-|api[_ -]?key|\btoken\b|bearer /i;
const STACK = /^\s*at /;
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

/** The first plain line of a failure. A stack frame or a secret is not shown. */
export function failureWords(notice?: string | null, error?: string | null): string {
  const raw = `${notice ?? ""}\n${error ?? ""}`.replace(/\r\n/g, "\n");
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text || STACK.test(text) || SECRET.test(text)) continue;
    return text.slice(0, 240);
  }
  return "This work failed.";
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
 * What the Inbox shows for one project: open decisions, results ready for review,
 * failures, and credential needs. A row's status word is copied, never chosen here.
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
    items.push({
      id: `decision:${project}:${key}`,
      kind: "decision",
      title: firstLine(decision.question, 160) || "A decision is waiting",
      body: "",
      statusWord: "needs you",
      chatId: firstLine(decision.askedBy, 200) || null,
      workerIds: waiting,
      options: choice.options,
      recommended: choice.recommended,
      project,
      key,
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
        title: credentialTitle(row),
        body: failureWords(row.statusNotice, row.error),
        statusWord: word,
        chatId: row.childSession ?? null,
        workerIds: [row.id],
        options: [],
        recommended: null,
        project,
        key: null,
        updatedAt: row.updatedAt ?? 0,
      });
      continue;
    }
    if (status === "failed") {
      items.push({
        id: `failure:${row.id}`,
        kind: "failure",
        title: firstLine(row.title, 120) || "This work failed",
        body: failureWords(row.statusNotice, row.error),
        statusWord: word,
        chatId: row.childSession ?? null,
        workerIds: [row.id],
        options: [],
        recommended: null,
        project,
        key: null,
        updatedAt: row.updatedAt ?? 0,
      });
      continue;
    }
    if (status === "done" && !landed(delivery)) {
      items.push({
        id: `review:${row.id}`,
        kind: "review",
        title: "Ready for review",
        body: firstLine(row.title, 160),
        statusWord: word,
        chatId: row.childSession ?? null,
        workerIds: [row.id],
        options: [],
        recommended: null,
        project,
        key: null,
        updatedAt: row.updatedAt ?? 0,
      });
    }
  }
  const rank: Record<FirstMateInboxKind, number> = { decision: 0, credential: 1, failure: 2, review: 3 };
  items.sort((a, b) => rank[a.kind] - rank[b.kind] || a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
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

/** Needs you goes out at once. A review or a failure waits for the hourly digest. */
export function noticesFrom(items: readonly FirstMateItem[], rows: readonly CrewWorkerInput[] = []): Notice[] {
  const covered = new Set(items.flatMap((item) => item.workerIds));
  const notices: Notice[] = items.map((item) => ({
    id: `${item.id}:${item.updatedAt}`,
    immediate: item.kind === "decision" || item.kind === "credential",
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
