// Keeps the UI's delegation rows (model/delegationStore.ts) current: the recent rows at start, then again after each
// change delegations.rs announces (batched, so a burst of writes is one read).
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import {
  DELEGATIONS_CHANGED,
  tauriDelegations,
  type DelegationsBackend,
} from "../model/delegations";
import { setDelegationRows } from "../model/delegationStore";
import { CHILD_CHATS_RECENT_MS } from "../model/delegationView";

const BATCH_MS = 150;
/** A slow look even without events, so rows that age out of "recent" drop off the sidebar. */
const REFRESH_MS = 60_000;

export function useDelegationFeed(
  backend: DelegationsBackend = tauriDelegations,
): void {
  useEffect(() => {
    const recent = backend.recent?.bind(backend);
    if (!recent) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    let again = false;
    const read = async () => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      try {
        const rows = await recent(Date.now() - CHILD_CHATS_RECENT_MS);
        if (live) setDelegationRows(rows);
      } catch (error) {
        console.error("Could not read the delegation rows", error);
      } finally {
        reading = false;
        if (again && live) {
          again = false;
          void read();
        }
      }
    };
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void read(), BATCH_MS);
    };
    void read();
    const interval = setInterval(() => void read(), REFRESH_MS);
    const unlisten = listen(DELEGATIONS_CHANGED, soon).catch(() => undefined);
    return () => {
      live = false;
      clearTimeout(timer);
      clearInterval(interval);
      void unlisten.then((off) => off?.());
    };
  }, [backend]);
}
