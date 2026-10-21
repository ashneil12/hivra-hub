// A8 (Ash, 21 Oct 20:40): a Mono's Sessions list shows its work while it runs, and only that. "when it's done, it's
// there. And then when you click on it, it disappears from there. And if it works again, then it shows back up there."
// So: a running session (working, or waiting on an approval/question) shows; one this app saw running and that has
// since finished stays, marked Done, until Ash clicks it; then it hides. Working again brings it back. A session that
// finished before the app ever saw it run (old history) does not show. Search and the filters still reach every one.
// Kept on this Mac by session id, so a finished one is still there after a restart until it is clicked.
import { useSyncExternalStore } from "react";

type Mark = "running" | "done";
const KEY = "monocode:mono-work-sessions";

let marks: Record<string, Mark> | undefined;
let version = 0;
const listeners = new Set<() => void>();

function load(): Record<string, Mark> {
  if (marks) return marks;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    marks =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? Object.fromEntries(Object.entries(raw).filter((e): e is [string, Mark] => e[1] === "running" || e[1] === "done"))
        : {};
  } catch {
    marks = {};
  }
  return marks;
}

function save(next: Record<string, Mark>): void {
  marks = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* kept for this run */
  }
  version++;
  listeners.forEach((listener) => listener());
}

/** How a session shows in the list: running, finished (done, stopped or failed; until clicked), or hidden. */
export type WorkSessionView = "running" | "done" | "stopped" | "failed" | "hidden";

/**
 * The view for a session that is `active` now (working, or waiting on Ash), from what was noted before. `ended` is how
 * its work ended when that is known (a delegated worker's row): one stopped before it ever answered, or one that
 * failed, is not "Done" (live 21 Oct: a worker Stopped before its first turn showed a green Done).
 */
export function workSessionView(id: string, active: boolean, ended?: "stopped" | "failed"): WorkSessionView {
  if (active) return "running";
  if (!load()[id]) return "hidden";
  return ended ?? "done";
}

/** Note what the list sees: an active session is running; one that was running and isn't any more is done. */
export function noteWorkSessions(observed: readonly { id: string; active: boolean }[]): void {
  const current = load();
  let next: Record<string, Mark> | undefined;
  for (const { id, active } of observed) {
    const want: Mark | undefined = active ? "running" : current[id] ? "done" : undefined;
    if (want && current[id] !== want) (next ??= { ...current })[id] = want;
  }
  if (next) save(next);
}

/** Ash clicked a finished session: it leaves the list until it works again. A running one stays. */
export function seenWorkSession(id: string): void {
  if (load()[id] !== "done") return;
  const next = { ...load() };
  delete next[id];
  save(next);
}

export function useWorkSessionsVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
    () => version,
  );
}

/** Tests: forget every mark. */
export function resetWorkSessions(): void {
  marks = undefined;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
  version++;
}
