// How the Autopilot screen reads: the switch in one line, each log row's outcome in plain words, rows by day, and the
// red-list calls left for Ash in this run. Pure, so the screen's words are tested here.

import { activeSwitches, EVERYTHING, type AutopilotStatus, type LogEntry, type Switch } from "./autopilot";
import { formatRemaining, formatUntil } from "./endTime";
import { isRedCategory, redLabel } from "./redList";

export type ProjectName = (id: string) => string;

function scopeName(scope: string, name: ProjectName): string {
  return scope === EVERYTHING ? "everything" : name(scope);
}

function setter(sw: Switch, name: (monoId: string) => string): string {
  if (sw.setBy === "ash") return "You turned it on here";
  const mono = sw.setBy.startsWith("mono:") ? name(sw.setBy.slice(5)) : sw.setBy;
  return sw.said ? `${mono} turned it on when you said “${sw.said}”` : `${mono} turned it on`;
}

export type SwitchLine = { scope: string; text: string; remaining: string; setBy: string };

/** One line per switch that is on: "On for everything until Mon 9:00", "2 days left", who turned it on. */
export function switchLines(
  status: AutopilotStatus | null,
  now: number,
  projectName: ProjectName,
  monoName: (monoId: string) => string,
): SwitchLine[] {
  return activeSwitches(status, now).map((sw) => ({
    scope: sw.scope,
    text: `On for ${scopeName(sw.scope, projectName)} until ${formatUntil(sw.untilMs, now)}`,
    remaining: `${formatRemaining(sw.untilMs, now)} left`,
    setBy: setter(sw, monoName),
  }));
}

/** The outcome as Ash reads it in the log. */
export function outcomeLabel(entry: Pick<LogEntry, "kind" | "outcome" | "red">): string {
  switch (entry.outcome) {
    case "taken":
      return entry.kind === "approval" ? "Allowed" : "Took its recommendation";
    case "held":
      if (isRedCategory(entry.red)) return `Waiting for you: ${redLabel(entry.red).toLowerCase()}`;
      return entry.kind === "approval" ? "Waiting for you: not one autopilot allows by itself" : "Waiting for you: red list";
    case "handed_back":
      return "Told to decide itself";
    case "on":
      return "Turned on";
    case "off":
      return "Turned off";
    case "ended":
      return "Ended";
    case "armed":
      return "Paused at a usage limit";
    case "resumed":
      return "Resumed";
    case "gave_up":
      return entry.kind === "relaunch" ? "Stopped reopening" : "Waiting for you";
    case "relaunched":
      return "Reopened after a crash";
    case "cancelled":
      return "Cancelled";
  }
}

/** A call autopilot made or held (as opposed to the switch's own events). */
export function isCall(entry: Pick<LogEntry, "kind">): boolean {
  return entry.kind === "decision" || entry.kind === "question" || entry.kind === "approval";
}

function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dayLabel(ms: number, now: number): string {
  const days = Math.round((dayStart(now) - dayStart(ms)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(ms);
  return `${d.toLocaleString("en-GB", { weekday: "short" })} ${d.getDate()} ${d.toLocaleString("en-GB", { month: "short" })}`;
}

export function timeLabel(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Newest first, one group per day. */
export function byDay(entries: readonly LogEntry[], now: number): { label: string; entries: LogEntry[] }[] {
  const groups: { label: string; entries: LogEntry[] }[] = [];
  for (const entry of [...entries].sort((a, b) => b.at - a.at)) {
    const label = dayLabel(entry.at, now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  }
  return groups;
}

/** Red-list calls held for Ash since autopilot last went on (they wait in the chats that asked). */
export function heldThisRun(entries: readonly LogEntry[]): LogEntry[] {
  const sorted = [...entries].sort((a, b) => b.at - a.at);
  const lastOn = sorted.find((e) => e.kind === "switch" && e.outcome === "on")?.at ?? 0;
  return sorted.filter((e) => e.outcome === "held" && isCall(e) && e.at >= lastOn);
}

/** Calls since Ash last looked. */
export function unseenCalls(entries: readonly LogEntry[], seenAt: number): number {
  return entries.filter((e) => isCall(e) && e.at > seenAt).length;
}
