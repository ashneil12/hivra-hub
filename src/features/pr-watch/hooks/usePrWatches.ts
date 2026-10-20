// The app's one hook for PR watches (model/prWatches.ts): one tracker per window, kept fresh from pr_watch.rs's
// events; the main window also delivers wakes, at start (boot recovery) and whenever the poller stores one.
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { getSession } from "../../sessions/data/sessionStore";
import type { QueuedMessage, Session } from "../../sessions/model/session";
import { isMonoSession } from "../../monos/model/mono";
import { setCurrentPrWatches } from "../model/prWatchBoard";
import {
  OWNER_RETRY_MS,
  PR_WATCH_WAKE,
  PR_WATCHES_CHANGED,
  PrWatchTracker,
  loadOwner,
  tauriPrWatches,
  type PrWatchBackend,
} from "../model/prWatches";

function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
}

export function usePrWatches(options: {
  sessionsRef: MutableRefObject<Session[]>;
  /** Put a wake in a Mono's queue (queueMonoSessionCompletion). */
  queueWake: (monoId: string, message: QueuedMessage) => Promise<void>;
  backend?: PrWatchBackend;
}): PrWatchTracker {
  const latest = useRef(options);
  latest.current = options;
  const [tracker] = useState(
    () =>
      new PrWatchTracker(options.backend ?? tauriPrWatches, {
        isMono: isMonoSession,
        load: (id) => loadOwner(latest.current.sessionsRef.current, id, getSession),
        queueWake: (monoId, message) => latest.current.queueWake(monoId, message),
      }),
  );
  setCurrentPrWatches(tracker);

  useEffect(() => {
    const deliver = isMainWindow();
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      void tracker.refresh().catch((error: unknown) => console.error("Could not read the PR watches", error));
    };
    const sendWakes = () => {
      if (!deliver) return;
      void tracker
        .deliver()
        .then((summary) => {
          // An owner whose chat couldn't be read keeps its wakes: try again soon rather than at the next wake.
          if (live && summary.waiting && !retry)
            retry = setTimeout(() => {
              retry = undefined;
              if (live) sendWakes();
            }, OWNER_RETRY_MS);
        })
        .catch((error: unknown) => console.error("Could not deliver a PR watch wake", error));
    };
    refresh();
    sendWakes();
    const offs = [
      listen(PR_WATCHES_CHANGED, () => live && refresh()),
      listen(PR_WATCH_WAKE, () => {
        if (!live) return;
        sendWakes();
        refresh();
      }),
    ];
    return () => {
      live = false;
      if (retry) clearTimeout(retry);
      for (const off of offs) void off.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [tracker]);

  return tracker;
}
