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

type Chat = { id: string; busy?: boolean };

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
    let pausedCopy = false;
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
        submit: (sessionId, prompt) => current.submit(sessionId, prompt),
      });
    };
    const run = async (mode: "launch" | "open") => {
      if (disposed || running) return;
      if (mode === "open" && (pausedCopy || inputRef.current.paused())) return;
      running = true;
      try {
        const result = await tickOneTimeSchedules({
          mode,
          now: Date.now(),
          store,
          send,
        });
        if (mode === "launch" && !disposed) setNotices(result.notices);
      } catch (error) {
        if (error instanceof SchedulesPausedError) {
          pausedCopy = true;
        }
        // Any other failure, including a timeout, leaves the run scheduled for the next tick.
      } finally {
        running = false;
      }
    };
    void run("launch").then(() => {
      if (!disposed) void run("open");
    });
    const timer = window.setInterval(() => void run("open"), TICK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void run("open");
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
