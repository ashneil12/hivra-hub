import { examples } from "./examples";
// Being built data, behind the hub data layer. Mock for now; Claude Code wires
// live workers and their activity.
import { useSyncExternalStore } from "react";
import type { JobState, Worker } from "./types";

const WORKERS: Worker[] = examples([
  {
    id: "w1", activeAgo: 0, projectId: "exo-game", who: "Lead", kind: "coding", minutes: 42,
    doing: "Example: adding the air dodge",
    steps: [
      { id: "1", at: "8:46pm", text: "Example: running the movement tests (14 of 22 pass so far)" },
      { id: "2", at: "8:41pm", text: "Example: changed how long the dodge lasts in the air" },
      { id: "3", at: "8:30pm", text: "Example: read the air and dodge rules in the design doc" },
      { id: "4", at: "8:12pm", text: "Example: looked at how the player controller handles jumps" },
      { id: "5", at: "8:05pm", text: "Example: started on build 0.15, air and dodge rules" },
    ],
  },
  {
    id: "w2", activeAgo: 2, projectId: "exo-game", who: "Playtester", kind: "mono", minutes: 12, state: "checking",
    doing: "Example: playtesting build 0.14",
    steps: [
      { id: "1", at: "8:44pm", text: "Example: noted that the Area 2 jump feels late" },
      { id: "2", at: "8:38pm", text: "Example: beat the first boss; autosave kicked in" },
      { id: "3", at: "8:35pm", text: "Example: opened build 0.14" },
    ],
  },
  {
    id: "w3", activeAgo: 6, projectId: "exo-game", who: "Lead", kind: "coding", minutes: 80, stuck: "stuck", waitingId: "build:b13b", stuckReason: "Example: the shader step keeps failing",
    doing: "Example: building 0.13.1 (shader fix)",
    steps: [
      { id: "1", at: "8:40pm", text: "Example: shader step timed out again (third try)" },
      { id: "2", at: "8:10pm", text: "Example: shader step timed out (second try)" },
      { id: "3", at: "7:40pm", text: "Example: shader step timed out" },
      { id: "4", at: "7:27pm", text: "Example: started building 0.13.1, shader cache fix" },
    ],
  },
  {
    id: "w4", projectId: "exo-game", who: "Critiquito", kind: "mono", minutes: 35, finishedAt: "4:20pm",
    doing: "Example: reviewed the Area 3 layout", steps: [{ id: "1", at: "4:20pm", text: "Example: left three notes on Area 3" }],
  },
  {
    id: "w5", projectId: "exo-game", who: "Lead", kind: "coding", minutes: 95, finishedAt: "4:10am",
    doing: "Example: built 0.14, new level and autosave", steps: [{ id: "1", at: "4:10am", text: "Example: build 0.14 is ready to play" }],
  },
  {
    id: "w6", activeAgo: 55, projectId: "hivra", who: "Projects Manager", kind: "mono", minutes: 50, stuck: "lead_gave_up", waitingId: "s2", stuckReason: "Example: the email sender refused the login",
    doing: "Example: sending the waitlist welcome emails",
    steps: [{ id: "1", at: "7:55pm", text: "Example: the email sender refused the login; the lead gave up" }],
  },
]);

/** Example: one more job, so a Mono shows two rows. */
WORKERS.length && WORKERS.push({
  id: "w7", activeAgo: 0, projectId: "exo-game", who: "Lead", kind: "coding", minutes: 9,
  doing: "Example: fixing the save bug",
  steps: [
    { id: "1", at: "8:44pm", text: "Example: found where autosave writes the wrong slot" },
    { id: "2", at: "8:39pm", text: "Example: reading how saves are written" },
  ],
});

WORKERS.length && WORKERS.push(
  { id: "w8", activeAgo: 18, projectId: "exo-game", who: "frank", kind: "mono", minutes: 20, state: "needs_you",
    doing: "Example: choosing the boss music", steps: [{ id: "1", at: "8:30pm", text: "Example: two takes ready; waiting for you to pick" }] },
  { id: "w9", activeAgo: 160, projectId: "exo-game", who: "frank", kind: "mono", minutes: 15, state: "parked",
    doing: "Example: the photo mode", steps: [{ id: "1", at: "6:02pm", text: "Example: parked until after 0.15" }] },
);

let version = 0;
const subs = new Set<() => void>();
export function useWorkVersion(): number {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => version);
}
const changed = () => { version++; subs.forEach((f) => f()); };

export function jobState(w: Worker): JobState {
  if (w.finishedAt) return w.seen ? "done" : "done_unseen";
  if (w.stuck) return w.stuck === "lead_gave_up" ? (gaveUpAsNeedsYou() ? "needs_you" : "gave_up") : "stuck";
  return w.state ?? "working";
}
/** Opening a Done job marks it seen; leaving it archives it. */
export function markSeen(id: string): void {
  const w = WORKERS.find((x) => x.id === id);
  if (w?.finishedAt && !w.seen) { w.seen = true; changed(); }
}
export function archiveIfSeen(id: string): void {
  const w = WORKERS.find((x) => x.id === id);
  if (w?.finishedAt && w.seen && !w.archived) { w.archived = true; changed(); }
}

export function activeWorkers(projectId: string): Worker[] {
  return WORKERS.filter((w) => w.projectId === projectId && !w.finishedAt);
}
export function finishedToday(projectId: string): Worker[] {
  return WORKERS.filter((w) => w.projectId === projectId && w.finishedAt && !w.archived);
}
export function getWorker(id: string): Worker | undefined {
  return WORKERS.find((w) => w.id === id);
}
export function durationLabel(min: number): string {
  if (min < 60) return `${min} min`;
  const m = min % 60;
  return m ? `${Math.floor(min / 60)} h ${m} min` : `${Math.floor(min / 60)} h`;
}

/** Default (Ash approved): Lead gave up = red Stuck. Alternative kept behind a dev flag for comparison. */
function gaveUpAsNeedsYou(): boolean {
  try { return localStorage.getItem("monocode:hub-gaveup-style") === "needs_you"; } catch { return false; }
}

/** Quiet last-active label: Now, 2m, 1h, 3d. Finished jobs: their finish time. */
export function lastActiveLabel(w: Worker): string {
  if (w.finishedAt) return w.finishedAt;
  const m = w.activeAgo ?? 0;
  if (m < 1) return "Now";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}
