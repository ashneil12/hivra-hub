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

  const outcomes = input.work.filter((row) => row.kind === "outcome" && row.day === day);
  outcomes.forEach((row, index) => {
    const projectId = row.project.trim();
    push({
      key: `work:${projectId}:${row.taskId}:${index}`,
      text: row.line.trim(),
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
