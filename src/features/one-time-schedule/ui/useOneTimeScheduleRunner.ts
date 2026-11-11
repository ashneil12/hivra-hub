// Fires a due one-time schedule while this app is open. A closed app does not run it.
import { useCallback, useEffect, useRef, useState } from "react";
import { projectKey } from "../../../shared/lib/paths";
import { createTauriOneTimeStore } from "../model/oneTimeScheduleApi";
import {
  SchedulesPausedError,
  deliverOneTimeSchedule,
  tickOneTimeSchedules,
  type OneTimeNotice,
  type OneTimeSchedule,
  type OneTimeScheduleStore,
} from "../model/oneTimeSchedule";

const TICK_MS = 15_000;
/** A paused copy is tried again later in the same session, not on every check and not never. */
export const ONE_TIME_PAUSED_RETRY_MS = 5 * 60 * 1000;

type Chat = { id: string; busy?: boolean };

function mergeNotices(current: OneTimeNotice[], extra: OneTimeNotice[]): OneTimeNotice[] {
  const seen = new Set(current.map((notice) => notice.id));
  const added = extra.filter((notice) => !seen.has(notice.id));
  return added.length === 0 ? current : [...current, ...added];
}

export function useOneTimeScheduleRunner(input: {
  store?: OneTimeScheduleStore;
  paused: () => boolean;
  sessions: () => Chat[];
  projectPaths: () => string[];
  createChat: (folder: string) => string;
  submit: (sessionId: string, prompt: string) => Promise<boolean>;
}): { notices: OneTimeNotice[]; note: (id: string) => void } {
  const inputRef = useRef(input);
  inputRef.current = input;
  const storeRef = useRef<OneTimeScheduleStore | null>(null);
  if (!storeRef.current) storeRef.current = input.store ?? createTauriOneTimeStore();
  const [notices, setNotices] = useState<OneTimeNotice[]>([]);
  const disposedRef = useRef(false);

  const note = useCallback((id: string) => {
    const store = storeRef.current;
    if (!store) return;
    void store
      .note(id, Date.now())
      .then(() => {
        if (!disposedRef.current) {
          setNotices((current) => current.filter((notice) => notice.id !== id));
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const store = storeRef.current;
    if (!store) return undefined;
    let disposed = false;
    let running = false;
    let launchReady = false;
    let pausedUntil = 0;
    disposedRef.current = false;
    const send = (schedule: OneTimeSchedule) => {
      const current = inputRef.current;
      return deliverOneTimeSchedule(schedule, {
        findChat: (id) => {
          const chat = current.sessions().find((entry) => entry.id === id);
          return chat ? { id: chat.id, busy: Boolean(chat.busy) } : null;
        },
        findProject: (id) => {
          const folder = current.projectPaths().find((path) => projectKey(path) === projectKey(id));
          return folder ? { folder } : null;
        },
        createChat: async (folder) => current.createChat(folder),
        rememberSession: (claimed, sessionId) =>
          store.rememberSession(claimed.id, claimed.claim?.token ?? "", sessionId, Date.now()),
        markHandedOff: (claimed) =>
          store.markHandedOff(claimed.id, claimed.claim?.token ?? "", Date.now()),
        submit: (sessionId, prompt) => current.submit(sessionId, prompt),
      });
    };
    const run = async (mode: "launch" | "open"): Promise<boolean> => {
      if (disposed || running) return false;
      const now = Date.now();
      if (mode === "open") {
        if (inputRef.current.paused()) return true;
        if (pausedUntil > now) return true;
      }
      running = true;
      let ok = true;
      try {
        const result = await tickOneTimeSchedules({
          mode,
          now,
          store,
          send,
          endUndeliverable: true,
        });
        if (!disposed && result.notices.length > 0) {
          setNotices((current) =>
            mode === "launch" ? result.notices : mergeNotices(current, result.notices),
          );
        }
      } catch (error) {
        ok = false;
        if (error instanceof SchedulesPausedError) {
          pausedUntil = Date.now() + ONE_TIME_PAUSED_RETRY_MS;
        }
        // Any other failure, including a timeout, leaves the run scheduled for the next tick.
      } finally {
        running = false;
      }
      return ok;
    };
    const followLaunch = (ok: boolean) => {
      if (!ok || disposed || launchReady) return;
      launchReady = true;
      void run("open");
    };
    void run("launch").then(followLaunch);
    const timer = window.setInterval(() => {
      void run(launchReady ? "open" : "launch").then((ok) => {
        if (!launchReady) followLaunch(ok);
      });
    }, TICK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && launchReady) void run("open");
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      disposedRef.current = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return { notices, note };
}
