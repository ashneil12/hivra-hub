// WP-164: quiet hours for routine programme notices. Approvals stay unless that category is muted.

import type { NotificationCategory } from "./notificationPreferences";

export const QUIET_HOURS_KEY = "monocode.quietHours.v1";

const DEFAULT_START = "22:00";
const DEFAULT_END = "08:00";

/** Local wall-clock window. `start` is included and `end` is not. */
export type QuietHours = {
  enabled: boolean;
  start: string;
  end: string;
};

export function defaultQuietHours(): QuietHours {
  return { enabled: false, start: DEFAULT_START, end: DEFAULT_END };
}

/** "HH:MM", or "HH:MM:SS" from a time input, trimmed. Anything else is refused. */
export function canonicalTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(value.trim());
  if (!match) return null;
  return `${match[1]}:${match[2]}`;
}

/** Disk and other windows are untrusted. A bad field falls back; it does not throw. */
export function parseQuietHours(raw: unknown): QuietHours {
  const base = defaultQuietHours();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const value = raw as Record<string, unknown>;
  return {
    enabled: value.enabled === true,
    start: canonicalTime(value.start) ?? base.start,
    end: canonicalTime(value.end) ?? base.end,
  };
}

export function loadQuietHours(): QuietHours {
  try {
    const raw = localStorage.getItem(QUIET_HOURS_KEY);
    if (raw == null) return defaultQuietHours();
    return parseQuietHours(JSON.parse(raw));
  } catch {
    return defaultQuietHours();
  }
}

/** Stores the repaired window. A write that cannot land still returns that window. */
export function saveQuietHours(next: QuietHours): QuietHours {
  const stored = parseQuietHours(next);
  try {
    localStorage.setItem(QUIET_HOURS_KEY, JSON.stringify(stored));
  } catch {
    // private mode or a full disk: the caller keeps `stored` in memory
  }
  return stored;
}

function minutesOfDay(now: number): number | null {
  if (!Number.isFinite(now)) return null;
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) return null;
  return date.getHours() * 60 + date.getMinutes();
}

function clockMinutes(time: string): number {
  const [hour, minute] = time.split(":");
  return Number(hour) * 60 + Number(minute);
}

/**
 * True when `now` sits in the local window. A disabled, empty, or unreadable
 * window is not quiet, so a bad setting does not hide notices.
 */
export function isQuietHour(now: number, quiet: QuietHours): boolean {
  if (!quiet.enabled) return false;
  const start = canonicalTime(quiet.start);
  const end = canonicalTime(quiet.end);
  const minutes = minutesOfDay(now);
  if (start === null || end === null || minutes === null) return false;
  const startMin = clockMinutes(start);
  const endMin = clockMinutes(end);
  if (startMin === endMin) return false;
  if (startMin < endMin) return minutes >= startMin && minutes < endMin;
  return minutes >= startMin || minutes < endMin;
}

/**
 * Programme ticks ask this before a routine notice. Quiet hours hold every
 * category except approvals and questions. A muted category stays muted at
 * any hour, including approvals.
 */
export function allowsProgrammeNotification(input: {
  category: NotificationCategory | string;
  categoryMuted: boolean;
  quiet: QuietHours;
  now: number;
}): boolean {
  if (input.categoryMuted) return false;
  if (!isQuietHour(input.now, input.quiet)) return true;
  return input.category === "agentInput";
}
