import { examples } from "./examples";
// Being built data, behind the hub data layer. Mock for now; Claude Code wires
// live workers and their activity.
import type { Worker } from "./types";

const WORKERS: Worker[] = examples([
  {
    id: "w1", projectId: "exo-game", who: "MonoInvader", kind: "coding", minutes: 42,
    doing: "Example: wiring the dodge roll to the new air rules",
    steps: [
      { id: "1", at: "8:46pm", text: "Example: running the movement tests (14 of 22 pass so far)" },
      { id: "2", at: "8:41pm", text: "Example: changed how long the dodge lasts in the air" },
      { id: "3", at: "8:30pm", text: "Example: read the air and dodge rules in the design doc" },
      { id: "4", at: "8:12pm", text: "Example: looked at how the player controller handles jumps" },
      { id: "5", at: "8:05pm", text: "Example: started on build 0.15, air and dodge rules" },
    ],
  },
  {
    id: "w2", projectId: "exo-game", who: "Playtester", kind: "mono", minutes: 12,
    doing: "Example: playing build 0.14 through Area 2",
    steps: [
      { id: "1", at: "8:44pm", text: "Example: noted that the Area 2 jump feels late" },
      { id: "2", at: "8:38pm", text: "Example: beat the first boss; autosave kicked in" },
      { id: "3", at: "8:35pm", text: "Example: opened build 0.14" },
    ],
  },
  {
    id: "w3", projectId: "exo-game", who: "Build machine", kind: "worker", minutes: 80, stuck: "stuck", waitingId: "build:b13b",
    doing: "Example: retrying the shader step for 0.13.1",
    steps: [
      { id: "1", at: "8:40pm", text: "Example: shader step timed out again (third try)" },
      { id: "2", at: "8:10pm", text: "Example: shader step timed out (second try)" },
      { id: "3", at: "7:40pm", text: "Example: shader step timed out" },
      { id: "4", at: "7:27pm", text: "Example: started building 0.13.1, shader cache fix" },
    ],
  },
  {
    id: "w4", projectId: "exo-game", who: "Design critic", kind: "mono", minutes: 35, finishedAt: "4:20pm",
    doing: "Example: reviewed the Area 3 layout", steps: [{ id: "1", at: "4:20pm", text: "Example: left three notes on Area 3" }],
  },
  {
    id: "w5", projectId: "exo-game", who: "MonoInvader", kind: "coding", minutes: 95, finishedAt: "4:10am",
    doing: "Example: built 0.14, new level and autosave", steps: [{ id: "1", at: "4:10am", text: "Example: build 0.14 is ready to play" }],
  },
  {
    id: "w6", projectId: "hivra", who: "Hivra mailer", kind: "mono", minutes: 50, stuck: "lead_gave_up", waitingId: "s2",
    doing: "Example: sending the waitlist welcome emails",
    steps: [{ id: "1", at: "7:55pm", text: "Example: the email sender refused the login; the lead gave up" }],
  },
]);

export function activeWorkers(projectId: string): Worker[] {
  return WORKERS.filter((w) => w.projectId === projectId && !w.finishedAt);
}
export function finishedToday(projectId: string): Worker[] {
  return WORKERS.filter((w) => w.projectId === projectId && w.finishedAt);
}
export function getWorker(id: string): Worker | undefined {
  return WORKERS.find((w) => w.id === id);
}
export function durationLabel(min: number): string {
  if (min < 60) return `${min} min`;
  const m = min % 60;
  return m ? `${Math.floor(min / 60)} h ${m} min` : `${Math.floor(min / 60)} h`;
}
