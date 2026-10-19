// Monos paused at a usage limit that resume by themselves, by display name ("EXO lead" → "Paused until 14:10"), for
// screens outside the chat (Being built). The app hook publishes it; screens read it.

import { useSyncExternalStore } from "react";

let paused: ReadonlyMap<string, string> = new Map();
let version = 0;
const listeners = new Set<() => void>();

export function publishPaused(next: ReadonlyMap<string, string>): void {
  const same = next.size === paused.size && [...next].every(([name, label]) => paused.get(name) === label);
  if (same) return;
  paused = next;
  version += 1;
  for (const listener of listeners) listener();
}

export function pausedFor(name: string): string | undefined {
  return paused.get(name);
}

export function usePausedVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
    () => version,
  );
}
