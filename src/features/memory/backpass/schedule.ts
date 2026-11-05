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

/** Remember that the weekly line was shown. Off, or a bad time, is left alone. */
export function offerSchedule(schedule: Schedule, at: string): Schedule {
  if (!schedule || schedule.weekly !== true) return schedule;
  if (typeof at !== "string" || !at.trim() || !Number.isFinite(Date.parse(at))) return schedule;
  return { ...schedule, lastOfferedAt: at };
}

/** The saved state after an offer. `changed` is false when there is nothing to write. */
export function stateAfterOffer(
  state: Record<string, unknown>,
  at: string,
): { state: Record<string, unknown>; changed: boolean } {
  const schedule = parseSchedule(state.schedule);
  const next = offerSchedule(schedule, at);
  if (next.weekly === schedule.weekly && next.lastOfferedAt === schedule.lastOfferedAt) {
    return { state, changed: false };
  }
  return { state: { ...state, schedule: next }, changed: true };
}

/** Disk is untrusted. Anything that isn't this shape comes back as off. */
export function parseSchedule(value: unknown): Schedule {
  if (!value || typeof value !== "object") return defaultSchedule();
  const row = value as { weekly?: unknown; lastOfferedAt?: unknown };
  const last = typeof row.lastOfferedAt === "string" && row.lastOfferedAt.trim() ? row.lastOfferedAt : null;
  return { weekly: row.weekly === true, lastOfferedAt: last };
}
