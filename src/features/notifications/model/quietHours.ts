// WP-164: quiet hours. The gate every banner and sound asks (allowsProjectNotification) holds routine
// categories inside the window. Approvals and questions stay unless that category is muted.
// Reminders are the exception: Rust fires them (src-tauri/src/reminders.rs), so this window does not reach them.

import type { NotificationCategory } from "./notificationPreferences";

export const QUIET_HOURS_KEY = "monocode.quietHours.v1";

/**
 * What the window does, in the words Settings shows. It says exactly what waits (only a finished-agent banner is kept
 * for the end of the window) and what comes through (a failed turn or check, an approval or question: never held; a
 * mute of that kind for the project still wins). Reminders come from Rust and are not held.
 */
export const QUIET_HOURS_DESCRIPTION =
  "Finished-agent banners wait until the window ends, then arrive as one notice. The inbox and linked pull request or issue sounds stay silent. Failed turns, failed checks, approvals and questions come through, unless you muted them for that project. Reminders you set still fire.";

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
function canonicalTime(value: unknown): string | null {
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
 * True when quiet hours hold this category right now: the window is on and the category is routine. Approvals and
 * questions (`agentInput`) are never held here. Muting is a separate rule and wins at any hour.
 */
export function holdsForQuietHours(
  category: NotificationCategory,
  now: number,
  quiet: QuietHours = loadQuietHours(),
): boolean {
  return category !== "agentInput" && isQuietHour(now, quiet);
}
