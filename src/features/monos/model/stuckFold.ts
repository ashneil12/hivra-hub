import { stuckOwner, type StuckWorker } from "./workerStuck";

/**
 * r70 (Critiquito): stopped workers (failed or stalled) above a Lead's composer fold into one line,
 * "<N> workers stopped · Show", that opens on a click. A worker asking a question keeps its own card (it waits on an
 * answer), and so does a red one only Ash can sort (billing or sign-in: the red rule). Today and Being built (`row`
 * lists) are not folded.
 */
export function foldStopped<S extends Pick<StuckWorker, "kind" | "row">>(
  stuck: readonly S[],
  open: boolean,
): { cards: S[]; stopped: number; stalled: number } {
  const keep = (s: S) => s.kind === "asking" || stuckOwner(s) === "needs-you";
  const stopped = stuck.filter((s) => !keep(s));
  const stalled = stopped.filter((s) => s.kind === "stalled").length;
  if (open || stopped.length === 0) return { cards: [...stuck], stopped: stopped.length, stalled };
  return { cards: stuck.filter(keep), stopped: stopped.length, stalled };
}

/**
 * "1 worker stopped" / "3 workers stopped". r91 (Critiquito): one word for a stalled worker everywhere, so when every
 * folded worker is stalled the line says so ("1 worker stalled"), as its card and its rail row do ("Stalled").
 */
export function stoppedLine(n: number, stalled = 0): string {
  return `${n} ${n === 1 ? "worker" : "workers"} ${stalled === n && n > 0 ? "stalled" : "stopped"}`;
}
