// WP-165: the night run is code. It does not call a model, and a store that does not answer is not a finished night.

import type { LocalHubDisk } from "../../hub/model/localHub/localHub";
import { readScoutSettings, ScoutStoreUnavailable } from "./store";

export type ScoutTurn = { kind: "quiet" | "retry" };

async function defaultDisk(): Promise<LocalHubDisk> {
  const { tauriLocalHubDisk } = await import("../../hub/model/localHub/localTransport");
  return tauriLocalHubDisk;
}

/**
 * One night. Off settles quietly. On waits for the curator (filled in with the scout step).
 * A store that times out stays due, so the next check can try again.
 */
export async function runScheduledScout(input: { cwd: string; disk?: LocalHubDisk }): Promise<ScoutTurn> {
  void input.cwd;
  try {
    const settings = await readScoutSettings(input.disk ?? (await defaultDisk()));
    if (settings.enabled !== true) return { kind: "quiet" };
  } catch (error) {
    if (error instanceof ScoutStoreUnavailable) return { kind: "retry" };
    return { kind: "retry" };
  }
  return { kind: "retry" };
}
