// A question leaves Needs you for one of three reasons, and nothing else takes it away (Ash, 13 Nov: "it asked me a
// question, but then because I guess some sort of async result happened ... I didn't answer the question at all ... no
// longer needs you"). The three: he answered it, he let it go, or the work behind it ended. An async result that stops
// the chat waiting leaves the question on the list, saying so, until one of the three happens.
//
// The record is also the "Finished" pile (needs/ui/FinishedNeeds.tsx): the last finished rows, each with the reason it
// went, kept out of the flow and behind one folded line. It survives a relaunch; a question kept on the list does not
// (its chat is the thing that would ask it again).
import { useSyncExternalStore } from "react";
import { foldDecisionKey } from "../../hub/model/decisionKey";
import type { NeedsItem, NeedsSources } from "./needsYou";

export type SettledReason = "answered" | "letgo" | "ended";

/** One row that is off the list, with why it went. */
export type SettledNeed = {
  key: string;
  kind: NeedsItem["kind"];
  sentence: string;
  who: string;
  projectId?: string;
  /** The decision this row was, when a first mate's decision drew it. Keys the one it was let go from. */
  decisionKey?: string;
  reason: SettledReason;
  at: number;
};

/** A question kept on the list after its chat stopped waiting on it, unanswered. */
export type HeldNeed = {
  key: string;
  who: string;
  at: number;
  sentence: string;
  projectId?: string;
  monoId?: string;
  open?: NeedsItem["open"];
  decisionKey?: string;
};

/** How many finished rows the "Finished" fold keeps. */
export const FINISHED_CAP = 40;
/** Why a question is still on the list though its chat stopped waiting. */
export const HELD_LINE = "It stopped waiting in the chat. You never answered it.";

const STORE_KEY = "monocode:needs-finished";

/** The line a finished row reads, naming which of the three happened. */
export function settledLine(row: Pick<SettledNeed, "reason" | "who">): string {
  switch (row.reason) {
    case "answered":
      return `Answered: ${row.who} has it.`;
    case "letgo":
      return "You let it go.";
    case "ended":
      return "The work behind it ended before you answered.";
  }
}

let settled: SettledNeed[] = [];
let rowsView: readonly SettledNeed[] = [];
/** Questions kept on the list. This run only: a relaunch reads the chats as they stand. */
let held: HeldNeed[] = [];
let loaded = false;
const listeners = new Set<() => void>();

function read(): SettledNeed[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value): SettledNeed[] => {
      if (!value || typeof value !== "object") return [];
      const row = value as Partial<SettledNeed>;
      if (typeof row.key !== "string" || !row.key) return [];
      if (row.reason !== "answered" && row.reason !== "letgo" && row.reason !== "ended") return [];
      if (typeof row.sentence !== "string" || typeof row.who !== "string") return [];
      if (typeof row.at !== "number" || !Number.isFinite(row.at)) return [];
      return [{
        key: row.key,
        kind: typeof row.kind === "string" ? row.kind : "question",
        sentence: row.sentence,
        who: row.who,
        ...(typeof row.projectId === "string" && row.projectId ? { projectId: row.projectId } : {}),
        ...(typeof row.decisionKey === "string" && row.decisionKey ? { decisionKey: row.decisionKey } : {}),
        reason: row.reason,
        at: row.at,
      }];
    });
  } catch {
    return [];
  }
}

function write(): void {
  rowsView = [...settled].reverse().slice(0, FINISHED_CAP);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settled.slice(-FINISHED_CAP)));
  } catch {
    // Not kept past this run.
  }
}

/** Read what the last run kept, once. */
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  settled = read();
  write();
}

/** Every finished row, newest first. The same list until it changes, so a screen can subscribe to it. */
export function settledRows(): readonly SettledNeed[] {
  ensureLoaded();
  return rowsView;
}

export function settledFor(key: string): SettledNeed | undefined {
  ensureLoaded();
  return settled.find((row) => row.key === key);
}

function record(row: SettledNeed): void {
  if (settled.some((one) => one.key === row.key)) return;
  settled = [...settled, row].slice(-FINISHED_CAP);
  write();
}

/** Why the card that was asked on now reads one line, in plain words: the app's record if it has one. */
export function foldedLine(key: string, label: string): string {
  const row = settledFor(key);
  if (row) return settledLine(row);
  const words = label.replace(/\s+/g, " ").trim();
  return words ? `No longer needs you: ${words}` : "No longer needs you.";
}

/**
 * He answered a question from its card: its row is finished, and the line left behind says so. Only a question row:
 * a quiet ask's own answers ("Let it go", "Remind Mia") finish it their way.
 */
export function noteAnswerGone(key: string, who: string, sentence: string, now = Date.now()): void {
  if (!key.startsWith("question:")) return;
  ensureLoaded();
  record({ key, kind: "question", sentence, who, reason: "answered", at: now });
  held = held.filter((one) => one.key !== key);
  for (const listener of listeners) listener();
}

/** What a row must say to be let go: a row, or a first mate's decision that has no row of its own any more. */
export type DropRow = Pick<NeedsItem, "key" | "kind" | "sentence" | "who" | "projectId"> & { decisionKey?: string };

/**
 * "Let it go": his own drop from the row or its card. The row leaves and the record says so. A row a first mate's
 * decision drew also carries that decision's key, so the decision stops drawing a row of its own (`decisionLetGo`).
 */
export function dismissNeed(item: DropRow, now = Date.now()): void {
  ensureLoaded();
  record({
    key: item.key,
    kind: item.kind,
    sentence: item.sentence,
    who: item.who,
    ...(item.projectId ? { projectId: item.projectId } : {}),
    ...(item.decisionKey?.trim() ? { decisionKey: item.decisionKey.trim() } : {}),
    reason: "letgo",
    at: now,
  });
  held = held.filter((one) => one.key !== item.key);
  for (const listener of listeners) listener();
}

/**
 * The decisions he let go, in the folded spelling decision keys compare by. A first mate's decision the person dropped
 * draws no row again, even though the decision store still has it open.
 */
export function letGoDecisionKeys(): ReadonlySet<string> {
  ensureLoaded();
  const keys = new Set<string>();
  for (const row of settled) if (row.reason === "letgo" && row.decisionKey) keys.add(foldDecisionKey(row.decisionKey));
  return keys;
}

/** Whether the work behind a question has ended: its decision closed, or its chat is gone. */
function workEnded(item: NeedsItem, sources: NeedsSources): boolean {
  if (item.decisionKey?.trim()) return true;
  const open = item.open;
  if (open?.where !== "chat") return false;
  return sources.chatIds ? !sources.chatIds.has(open.id) : false;
}

function keptQuestion(one: HeldNeed): NeedsItem {
  return {
    key: one.key,
    kind: "question",
    ...(one.projectId ? { projectId: one.projectId } : {}),
    ...(one.monoId ? { monoId: one.monoId } : {}),
    who: one.who,
    at: one.at,
    sentence: one.sentence,
    detail: HELD_LINE,
    actions: [],
    ...(one.open ? { open: one.open } : {}),
    ...(one.decisionKey ? { decisionKey: one.decisionKey } : {}),
  };
}

/**
 * The list to publish: this read's rows, minus anything already finished, plus every question still waiting on him.
 * The previous read is what says a question left: a question that is gone from the chat unanswered is kept, with the
 * reason (`HELD_LINE`), until he answers it or lets it go.
 */
export function adoptQuestions(input: {
  sources: NeedsSources;
  previous: readonly NeedsItem[];
  next: readonly NeedsItem[];
  now: number;
}): NeedsItem[] {
  ensureLoaded();
  // A question the same chat asks again is new work: only "let it go" keeps a key hidden for good.
  const askedAgain = new Set(input.next.map((item) => item.key));
  const stale = settled.filter((row) => row.reason !== "letgo" && askedAgain.has(row.key));
  if (stale.length) {
    settled = settled.filter((row) => !stale.includes(row));
    write();
  }
  const done = new Set(settled.map((row) => row.key));
  const live = input.next.filter((item) => !done.has(item.key));
  const liveKeys = new Set(live.map((item) => item.key));
  const wasHeld = new Set(held.map((one) => one.key));
  const keep = held.filter((one) => !liveKeys.has(one.key) && !done.has(one.key));
  const keepKeys = new Set(keep.map((one) => one.key));
  for (const before of input.previous) {
    if (before.kind !== "question") continue;
    if (liveKeys.has(before.key) || done.has(before.key) || keepKeys.has(before.key) || wasHeld.has(before.key)) continue;
    if (input.sources.answered?.(before.key)) {
      record({
        key: before.key,
        kind: before.kind,
        sentence: before.sentence,
        who: before.who,
        ...(before.projectId ? { projectId: before.projectId } : {}),
        reason: "answered",
        at: input.now,
      });
      done.add(before.key);
      continue;
    }
    if (workEnded(before, input.sources)) {
      record({
        key: before.key,
        kind: before.kind,
        sentence: before.sentence,
        who: before.who,
        ...(before.projectId ? { projectId: before.projectId } : {}),
        reason: "ended",
        at: input.now,
      });
      done.add(before.key);
      continue;
    }
    keep.push({
      key: before.key,
      who: before.who,
      at: before.at,
      sentence: before.sentence,
      ...(before.projectId ? { projectId: before.projectId } : {}),
      ...(before.monoId ? { monoId: before.monoId } : {}),
      ...(before.open ? { open: before.open } : {}),
      ...(before.decisionKey ? { decisionKey: before.decisionKey } : {}),
    });
  }
  held = keep;
  return [...live, ...keep.map(keptQuestion)];
}

/** The same list, for a read that must not record anything (a count). */
export function visibleWithHeld(next: readonly NeedsItem[]): NeedsItem[] {
  ensureLoaded();
  const done = new Set(settled.filter((row) => row.reason === "letgo").map((row) => row.key));
  const live = next.filter((item) => !done.has(item.key));
  const liveKeys = new Set(live.map((item) => item.key));
  const kept = held.filter((one) => !liveKeys.has(one.key) && !done.has(one.key));
  return [...live, ...kept.map(keptQuestion)];
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The "Finished" pile, and a render whenever a row is let go. */
export function useSettledNeeds(): readonly SettledNeed[] {
  return useSyncExternalStore(subscribe, settledRows, settledRows);
}

export function resetSettledNeedsForTest(): void {
  settled = [];
  held = [];
  listeners.clear();
  rowsView = [];
  loaded = true;
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    // Nothing kept.
  }
}
