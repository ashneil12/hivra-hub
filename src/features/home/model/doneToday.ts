// What finished today. Merged pull requests, work-log outcomes, and accepted delegations.
// Newest first, five at most. A value from disk is untrusted.

import type { ActivityEntry } from "../../activity/model/activity";
import type { HomeOpenTarget } from "./opener";
import { localDay, type WorkLogLine } from "../../workLog/model/workLog";

export const DONE_LIMIT = 5;

export type DoneDelegation = {
  id: string;
  state: string;
  delivery: string;
  settledAt: number | null;
  title: string | null;
  goal: string | null;
  project: string | null;
  childSession: string;
};

export type DoneLine = {
  key: string;
  text: string;
  time: string;
  projectId: string;
  open: HomeOpenTarget;
};

function clock(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function sameDay(at: number, now: Date): boolean {
  const date = new Date(at);
  if (Number.isNaN(date.getTime()) || Number.isNaN(now.getTime())) return false;
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

function httpLink(link: string): string | undefined {
  const href = link.trim();
  return /^https?:\/\//i.test(href) ? href : undefined;
}

type Ranked = DoneLine & { rank: number };

/** A name for the tag. The id itself is not a name. */
export function projectTag(projectId: string, label: (projectId: string) => string | undefined): string | undefined {
  const name = label(projectId)?.trim();
  if (!name || name === projectId.trim()) return undefined;
  return name;
}

export function doneToday(input: {
  activity: readonly ActivityEntry[];
  work: readonly WorkLogLine[];
  delegations: readonly DoneDelegation[];
  now: Date;
  label: (projectId: string) => string | undefined;
}): DoneLine[] {
  if (Number.isNaN(input.now.getTime())) return [];
  const day = localDay(input.now);
  const ranked: Ranked[] = [];
  const seen = new Set<string>();

  function push(line: Ranked): void {
    if (!line.text.trim() || seen.has(line.key)) return;
    seen.add(line.key);
    ranked.push(line);
  }

  for (const entry of input.activity) {
    if (!entry || entry.kind !== "git.merge" || typeof entry.at !== "number" || !sameDay(entry.at, input.now)) continue;
    if (typeof entry.id !== "string" || !entry.id) continue;
    const text = typeof entry.summary === "string" ? entry.summary.trim() : "";
    const href = httpLink(typeof entry.link === "string" ? entry.link : "");
    const projectId = typeof entry.project === "string" ? entry.project.trim() : "";
    push({
      key: `merge:${entry.id}`,
      text,
      time: clock(entry.at),
      projectId,
      rank: entry.at,
      open: href ? { kind: "url", href } : { kind: "coding", projectId },
    });
  }

  for (const row of input.delegations) {
    if (row.state !== "completed" || row.delivery !== "acknowledged") continue;
    if (typeof row.settledAt !== "number" || !sameDay(row.settledAt, input.now)) continue;
    if (!row.id) continue;
    const text = (row.title ?? "").trim() || (row.goal ?? "").trim() || "Finished work";
    const projectId = (row.project ?? "").trim();
    push({
      key: `delegation:${row.id}`,
      text,
      time: clock(row.settledAt),
      projectId,
      rank: row.settledAt,
      open: row.childSession
        ? { kind: "chat", id: row.childSession, projectId }
        : { kind: "coding", projectId },
    });
  }

  // Ash 12 Nov: one job showed three times, each row a raw report. One row per job (its latest outcome), one plain line.
  const outcomes = latestPerTask(input.work.filter((row) => row.kind === "outcome" && row.day === day));
  outcomes.forEach((row, index) => {
    const projectId = row.project.trim();
    const text = plainOutcome(row.line);
    if (ranked.some((line) => sameJob(line.text, text))) return;
    push({
      key: `work:${projectId}:${row.taskId}:${index}`,
      text,
      time: "",
      projectId,
      // Later lines in the log were written later. No clock, so they stay behind anything timed.
      rank: index - 1_000_000_000_000,
      open: row.taskId
        ? { kind: "task", projectId, id: row.taskId }
        : { kind: "settings", section: "work-log", anchor: "" },
    });
  });

  ranked.sort((a, b) => b.rank - a.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return ranked.slice(0, DONE_LIMIT).map((line) => ({
    key: line.key,
    text: line.text,
    time: line.time,
    projectId: line.projectId,
    open: line.open,
  }));
}

/** The last outcome line for each task (a later line is a later word on the same job); untasked lines stay. */
function latestPerTask<T extends { taskId?: string | null }>(rows: readonly T[]): T[] {
  const last = new Map<string, number>();
  rows.forEach((row, index) => {
    if (row.taskId) last.set(row.taskId, index);
  });
  return rows.filter((row, index) => !row.taskId || last.get(row.taskId) === index);
}

/**
 * A work-log outcome as one plain line: its own first clause ("Done: Refactor the Hivra homepage, local only"), no
 * markdown, no "Delivered:" report, no brief text after it; the row opens the rest.
 */
export function plainOutcome(line: string): string {
  const flat = line
    .replace(/\*\*|__|`|^#+\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const head = flat.split(/\s(?:Delivered|It failed|Changes|What's there):/i)[0]!.trim();
  const sentence = /^(.{12,}?[.!?])(\s|$)/.exec(head)?.[1] ?? head;
  const cut = sentence.length > 110 ? `${sentence.slice(0, 109).trimEnd()}…` : sentence;
  return cut.replace(/[.]$/, "");
}

/** Two lines about the same job: the same first words once status words and punctuation are gone. */
function sameJob(a: string, b: string): boolean {
  const words = (text: string) =>
    text
      .toLowerCase()
      .replace(/^(done|failed|finished|stopped)\s*:\s*/, "")
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 5)
      .join(" ");
  const left = words(a);
  return left.length > 8 && left === words(b);
}
