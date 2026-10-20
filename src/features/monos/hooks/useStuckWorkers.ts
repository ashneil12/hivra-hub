// The stuck workers as the UI reads them (model/workerStuck.ts): the delegation rows, Ash's dismissals and a clock that
// ticks every half minute, so "No output for 9 min" counts up and a question left on its Lead turns Ash's on time.
import { useEffect, useState } from "react";
import { useDelegationRows } from "../model/delegationStore";
import { stuckWorkers, useStuckDismissalsVersion, type StuckWorker } from "../model/workerStuck";

export const STUCK_CLOCK_MS = 30_000;

/** Now, ticking every `ms`; the order of anything shown never depends on it. */
export function useClock(ms = STUCK_CLOCK_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** Every stuck worker, oldest first, with the clock it was read at. */
export function useStuckWorkers(): { stuck: StuckWorker[]; now: number } {
  const rows = useDelegationRows();
  useStuckDismissalsVersion();
  const now = useClock();
  return { stuck: stuckWorkers(rows, now), now };
}
