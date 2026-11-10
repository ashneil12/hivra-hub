// WP-165: the overnight scout is off until the person turns it on.

export const SCOUT_DEFAULT_TIME = "23:00";
export const SCOUT_DEFAULT_MAX = 3;
export const SCOUT_MAX_CAP = 20;

export type ScoutSettings = {
  /** Only an exact true turns the scout on. */
  enabled: boolean;
  /** "HH:MM" local time. A bad value falls back to 23:00. */
  time: string;
  /** New drafts allowed in one night. 0 writes none. A bad value falls back to 3. */
  maxDrafts: number;
  /** A folder the person picked. Null when they have not picked one. */
  watchFolder: string | null;
};

export const SCOUT_DEFAULTS: ScoutSettings = {
  enabled: false,
  time: SCOUT_DEFAULT_TIME,
  maxDrafts: SCOUT_DEFAULT_MAX,
  watchFolder: null,
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A bookmark the person picked. `..`, blanks and control characters are refused. */
export function watchFolder(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 500) return null;
  if (/[\u0000-\u001f]/.test(trimmed)) return null;
  const parts = trimmed.split(/[/\\]/);
  if (parts.some((part) => part === "..")) return null;
  return trimmed;
}

/** Settings read from disk, a form or another window. Anything untrusted falls back, and the fallback is off. */
export function parseScoutSettings(value: unknown): ScoutSettings {
  if (!value || typeof value !== "object") return { ...SCOUT_DEFAULTS };
  const raw = value as Record<string, unknown>;
  const time = typeof raw.time === "string" && TIME.test(raw.time) ? raw.time : SCOUT_DEFAULT_TIME;
  const max = raw.maxDrafts;
  const maxDrafts =
    typeof max === "number" && Number.isInteger(max) && max >= 0 && max <= SCOUT_MAX_CAP
      ? max
      : SCOUT_DEFAULT_MAX;
  return {
    enabled: raw.enabled === true,
    time,
    maxDrafts,
    watchFolder: watchFolder(raw.watchFolder),
  };
}
