// WP-83: a weekly run exists and is off until the person turns it on.

export type Schedule = { weekly: boolean; lastOfferedAt: string | null };

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function defaultSchedule(): Schedule {
  return { weekly: false, lastOfferedAt: null };
}

/** Due only when weekly is on, and it has never been offered or a week has passed. */
export function weeklyDue(schedule: Schedule, nowMs: number): boolean {
  if (!schedule || schedule.weekly !== true) return false;
  if (!schedule.lastOfferedAt) return true;
  const at = Date.parse(schedule.lastOfferedAt);
  if (!Number.isFinite(at)) return true;
  return nowMs - at >= WEEK_MS;
}

/** Disk is untrusted. Anything that isn't this shape comes back as off. */
export function parseSchedule(value: unknown): Schedule {
  if (!value || typeof value !== "object") return defaultSchedule();
  const row = value as { weekly?: unknown; lastOfferedAt?: unknown };
  const last = typeof row.lastOfferedAt === "string" && row.lastOfferedAt.trim() ? row.lastOfferedAt : null;
  return { weekly: row.weekly === true, lastOfferedAt: last };
}
