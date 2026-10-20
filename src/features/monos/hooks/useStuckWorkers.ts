// The stuck workers as the UI reads them (model/workerStuck.ts): the delegation rows, Ash's dismissals and a clock that
// ticks every half minute, so "No output for 9 min" counts up and a question left on its Lead turns Ash's on time.
import { useEffect, useState } from "react";
import { useDelegationRows } from "../model/delegationStore";
import { stuckWorkers, useStuckDismissalsVersion, type StuckWorker } from "../model/workerStuck";

export const STUCK_CLOCK_MS = 30_000;

/**
 * Now, read at every render and at least every `ms` (so "9 min" counts up on its own); a render for new rows reads the
 * time afresh, so a row is never measured against an older clock. The order of anything shown never depends on it.
 */
export function useClock(ms = STUCK_CLOCK_MS): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return Date.now();
}

/** Every stuck worker, oldest first, with the clock it was read at. */
export function useStuckWorkers(): { stuck: StuckWorker[]; now: number } {
  const rows = useDelegationRows();
  useStuckDismissalsVersion();
  const now = useClock();
  return { stuck: stuckWorkers(rows, now), now };
}
