// The window's watch tracker for the board's components (Being built), which sit outside App's props. Kept apart from
// the hook (hooks/usePrWatches.ts) so the board doesn't pull in the session store and the Mono roster.
import { useSyncExternalStore } from "react";
import type { PrWatchTracker } from "./prWatches";

let current: PrWatchTracker | null = null;

export function setCurrentPrWatches(tracker: PrWatchTracker): void {
  current = tracker;
}

export function currentPrWatches(): PrWatchTracker | null {
  return current;
}

const noSubscribe = () => () => undefined;
const zero = () => 0;

/** Re-render on any change to the watches; returns the tracker (null before the app made one). */
export function usePrWatchesVersion(): PrWatchTracker | null {
  const tracker = current;
  useSyncExternalStore(tracker ? tracker.subscribe : noSubscribe, tracker ? tracker.snapshot : zero);
  return tracker;
}
