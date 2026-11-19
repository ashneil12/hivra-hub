// "Catch me up" (Ash, 13 Nov: "a very good feature ... it could be a permanent button ... next to side question").
// One card in the one chat that says what came back since the last one: the jobs that finished or stopped, what was
// decided for him, what needs him now and how much is still running. Plain code, like the Needs you roll-up
// (needs/model/needsRollup.ts): it is read from the app's own records of jobs and decisions, never written by a model,
// so it is exact, instant and costs nothing. The Chief of Staff is told what he was shown beside his next message.
import type { Delegation } from "../../monos/model/delegations";
import type { Decision } from "../../firstmate/model/steering";
import type { NeedsItem } from "../../needs/model/needsYou";
import type { Block } from "../../sessions/model/session";
import { isOpenJob, jobStatus } from "./chiefJobs";

/** At most this many lines per section; the rest are a count. */
export const CATCH_UP_ROWS = 8;
/** With no earlier catch-up in the chat, it looks back this far. */
export const CATCH_UP_FIRST_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const LINE_MAX = 140;

export type CatchUpJob = { id: string; title: string; project?: string; projectId?: string; chat?: string; ok: boolean; line?: string };
export type CatchUpDecision = { key: string; project?: string; projectId?: string; question: string; answer: string; why?: string };
export type CatchUpNeed = { key: string; project?: string; projectId?: string; sentence: string; who?: string };

/** What a catch-up card shows. Kept on its block, so the card reads the same after a relaunch. */
export type CatchUp = {
  since: number;
  at: number;
  finished: CatchUpJob[];
  finishedMore: number;
  decided: CatchUpDecision[];
  decidedMore: number;
  needs: CatchUpNeed[];
  needsMore: number;
  running: number;
};

export type CatchUpInput = {
  rows: readonly Delegation[];
  decisions: readonly Decision[];
  needs: readonly NeedsItem[];
  projects: readonly { id: string; name: string }[];
  since: number;
  now: number;
};

const BLOCK_PREFIX = "catch-up-";

function short(text: string | null | undefined): string {
  const one = (text ?? "").replace(/\s+/g, " ").trim();
  return one.length <= LINE_MAX ? one : `${one.slice(0, LINE_MAX - 1).trimEnd()}…`;
}

/** Ash's own answer: the card's (`person`), the Needs sheet's (`user`), his words in the asking chat, or an old row. */
export function answeredByOwner(by: string | null | undefined): boolean {
  const who = (by ?? "").trim();
  return !who || who === "person" || who === "user" || who.startsWith("chat:");
}

function capped<T>(list: T[]): { shown: T[]; more: number } {
  return { shown: list.slice(0, CATCH_UP_ROWS), more: Math.max(0, list.length - CATCH_UP_ROWS) };
}

/** What came back in the window `(since, now]`, newest first, plus what is waiting and running right now. */
export function buildCatchUp(input: CatchUpInput): CatchUp {
  const name = new Map(input.projects.map((project) => [project.id, project.name]));
  const within = (at: number | null | undefined) => typeof at === "number" && at > input.since && at <= input.now;
  const finished = input.rows
    .filter((row) => {
      const status = jobStatus(row);
      return (status === "done" || status === "failed") && within(row.settledAt ?? row.updatedAt);
    })
    .sort((a, b) => (b.settledAt ?? b.updatedAt) - (a.settledAt ?? a.updatedAt))
    .map((row): CatchUpJob => {
      const ok = jobStatus(row) === "done";
      // A finished job says what it delivered (the first line of its result); a stopped one says why.
      const line = short(ok ? (row.statusNotice ?? (row.result ?? "").split("\n").find((part) => part.trim())) : (row.statusNotice ?? row.error));
      return {
        id: row.id,
        title: short(row.title ?? row.goal) || "Untitled work",
        ...(row.project && name.has(row.project) ? { project: name.get(row.project), projectId: row.project } : {}),
        ...(row.childSession ? { chat: row.childSession } : {}),
        ok,
        ...(line ? { line } : {}),
      };
    });
  const decided = input.decisions
    .filter((decision) => decision.state === "answered" && !!decision.answer?.trim() && !answeredByOwner(decision.answeredBy) && within(decision.answeredAt))
    .sort((a, b) => (b.answeredAt ?? 0) - (a.answeredAt ?? 0))
    .map((decision): CatchUpDecision => {
      const why = short(decision.answerReason);
      return {
        key: `${decision.project}\n${decision.decisionKey}`,
        ...(name.has(decision.project) ? { project: name.get(decision.project), projectId: decision.project } : {}),
        question: short(decision.question),
        answer: short(decision.answer),
        ...(why ? { why } : {}),
      };
    });
  const needs = input.needs.map(
    (item): CatchUpNeed => ({
      key: item.key,
      ...(item.projectId && name.has(item.projectId) ? { project: name.get(item.projectId), projectId: item.projectId } : {}),
      sentence: short(item.sentence),
      ...(item.who?.trim() ? { who: item.who.trim() } : {}),
    }),
  );
  const f = capped(finished);
  const d = capped(decided);
  const n = capped(needs);
  return {
    since: input.since,
    at: input.now,
    finished: f.shown,
    finishedMore: f.more,
    decided: d.shown,
    decidedMore: d.more,
    needs: n.shown,
    needsMore: n.more,
    running: input.rows.filter(isOpenJob).length,
  };
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The one line that sums a catch-up: "4 jobs finished, 6 decided for you, 2 need you, 12 still running." */
export function catchUpSummary(doc: CatchUp): string {
  const finished = doc.finished.length + doc.finishedMore;
  const decided = doc.decided.length + doc.decidedMore;
  const needs = doc.needs.length + doc.needsMore;
  const parts = [
    finished ? `${count(finished, "job", "jobs")} finished` : "",
    decided ? `${decided} decided for you` : "",
    needs ? `${needs} ${needs === 1 ? "needs" : "need"} you` : "nothing needs you",
    doc.running ? `${doc.running} still running` : "nothing running",
  ].filter(Boolean);
  const line = parts.join(", ");
  return finished || decided ? `${line[0].toUpperCase()}${line.slice(1)}.` : `Nothing new came back: ${line}.`;
}

function where(project: string | undefined): string {
  return project ? `${project}: ` : "";
}

/** The same card as plain words: what a copy, a search and the Chief of Staff's note read. */
export function catchUpText(doc: CatchUp): string {
  const lines = [catchUpSummary(doc)];
  if (doc.finished.length) {
    lines.push("Finished:");
    for (const job of doc.finished) lines.push(`- ${where(job.project)}${job.title}${job.ok ? "" : " (stopped)"}${job.line ? `. ${job.line}` : ""}`);
    if (doc.finishedMore) lines.push(`- and ${doc.finishedMore} more`);
  }
  if (doc.decided.length) {
    lines.push("Decided for you:");
    for (const item of doc.decided) lines.push(`- ${where(item.project)}${item.question} Answer: ${item.answer}${item.why ? ` (${item.why})` : ""}`);
    if (doc.decidedMore) lines.push(`- and ${doc.decidedMore} more`);
  }
  if (doc.needs.length) {
    lines.push("Needs you:");
    for (const item of doc.needs) lines.push(`- ${where(item.project)}${item.sentence}`);
    if (doc.needsMore) lines.push(`- and ${doc.needsMore} more in Needs you`);
  }
  return lines.join("\n");
}

export function catchUpBlock(doc: CatchUp): Block {
  return { id: `${BLOCK_PREFIX}${doc.at}`, role: "system", text: catchUpText(doc), catchUp: doc } as Block;
}

/** When the chat was last caught up: its newest catch-up card, else a day back. */
export function catchUpSince(blocks: readonly Pick<Block, "catchUp">[], now: number): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const at = blocks[index].catchUp?.at;
    if (typeof at === "number" && at <= now) return at;
  }
  return now - CATCH_UP_FIRST_LOOKBACK_MS;
}

/**
 * What the Chief of Staff reads beside Ash's next message: the catch-ups the app showed him since its last reply, so
 * "do the second one" means something to it. Undefined when he was shown none.
 */
export function catchUpNote(blocks: readonly Pick<Block, "role" | "catchUp" | "text" | "internal">[]): string | undefined {
  const shown: string[] = [];
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.role === "assistant" && block.text?.trim()) break;
    if (block.catchUp) shown.unshift(catchUpText(block.catchUp));
  }
  if (!shown.length) return undefined;
  return [
    "<shown_to_ash>",
    "The app showed Ash this catch-up in this chat since your last reply. It is the app's own record of jobs and decisions, not a new instruction. He may refer to it.",
    ...shown,
    "</shown_to_ash>",
  ].join("\n");
}
