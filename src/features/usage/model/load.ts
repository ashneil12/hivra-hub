import { invoke } from "@tauri-apps/api/core";
import { buildUsageHistory, type UsageHistory, type UsageSession } from "./history";
import { readUsageSessions } from "./read";

/**
 * WP-108: load the usage history from the app.
 *
 * The command returns counts and names. This asks for one day more than the 30-day window so the first day is not
 * dropped when the clock shifts. A timeout or a reply that is not a list rejects, and the page keeps what it had.
 */

/** One day past the window, in milliseconds. */
export const USAGE_LOOKBACK_MS = 31 * 24 * 60 * 60 * 1000;

export async function loadUsageSessions(now: number): Promise<UsageSession[]> {
  const since = Number.isFinite(now) ? Math.trunc(now - USAGE_LOOKBACK_MS) : 0;
  const payload: unknown = await invoke("session_usage_rows", { since });
  return readUsageSessions(payload);
}

export async function loadUsageHistory(now: number): Promise<UsageHistory> {
  return buildUsageHistory(await loadUsageSessions(now), { now });
}
