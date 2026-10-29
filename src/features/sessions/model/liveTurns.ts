// Mid-turn chats as the app process currently sees them. Session.busy lives in
// the webview that started the turn; every workspace window reports its own
// set, and the process union is what the rail reads — including a window
// opened while a turn is already going.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MONO_WORKING, type MonoState } from "../../monos/model/mono";

export const LIVE_TURNS_EVENT = "monocode:live-turns";

export type LiveTurnsPayload = { sessionIds: string[] };

export function mergeLiveTurns(
  localBusy: ReadonlySet<string>,
  liveTurns: ReadonlySet<string>,
): Set<string> {
  if (liveTurns.size === 0) return new Set(localBusy);
  const ids = new Set(localBusy);
  for (const id of liveTurns) ids.add(id);
  return ids;
}

/** The existing working status, when another window has this chat mid-turn. */
export function overlayLiveWorking(
  state: MonoState,
  liveBusy: boolean,
): MonoState {
  if (!liveBusy || state.status !== "idle") return state;
  return MONO_WORKING;
}

export function publishLiveTurns(
  sessionIds: readonly string[],
): Promise<string[]> {
  return invoke<string[]>("live_turns_set", { sessionIds: [...sessionIds] });
}

export function listLiveTurns(): Promise<string[]> {
  return invoke<string[]>("live_turns_list");
}

export function subscribeLiveTurns(
  onChange: (sessionIds: string[]) => void,
): Promise<() => void> {
  return listen<LiveTurnsPayload>(LIVE_TURNS_EVENT, (event) => {
    const ids = event.payload?.sessionIds;
    if (Array.isArray(ids)) onChange(ids);
  });
}
