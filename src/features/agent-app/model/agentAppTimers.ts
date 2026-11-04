// Hivra WP-11: timers a first mate sets (src-tauri/src/watcher/timers.rs): the `timers.*` app actions, reached with
// `monocode app timers.*`. A due timer becomes a wake in the first mate's queue ([MonoCode watcher]), so a first mate
// ends its turn instead of polling. Only a first mate's own chat (a Mono's chat or a coding-team chat) sets them.
import type { Session } from "../../sessions/model/session";
import { tauriWakeQueue, type Timer, type WakeQueueBackend } from "../../firstmate/watcher/wakeQueue";
import type { AgentAppHost } from "./agentApp";

/** The FIELDS entries of the timer actions (agentApp.ts). */
export const TIMER_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["timers.set", ["inMinutes", "at", "note"]],
  ["timers.list", []],
  ["timers.cancel", ["id"]],
];

export type AgentAppTimersHost = Pick<WakeQueueBackend, "timerSet" | "timerCancel" | "timers">;

const MAX_MINUTES = 30 * 24 * 60;

function firstMate(source: Session, host: AgentAppHost): AgentAppTimersHost {
  const mono = host.isMono(source.id) ? host.monoOf?.(source.id) : undefined;
  if (!mono && !host.codingTeamOf?.(source.id))
    throw new Error(
      "Only a first mate's own chat (a Mono's chat or a coding-team chat) sets timers. A worker reports to the chat that delegated it.",
    );
  return host.timers ?? tauriWakeQueue;
}

/** When, from `inMinutes` (1 to 43200) or `at` (an ISO time), never both. */
export function dueAt(input: Record<string, unknown>, now: number): number {
  const { inMinutes, at } = input;
  if ((inMinutes === undefined) === (at === undefined)) throw new Error("give inMinutes or at (an ISO time), not both");
  if (inMinutes !== undefined) {
    if (typeof inMinutes !== "number" || !Number.isFinite(inMinutes) || inMinutes < 1 || inMinutes > MAX_MINUTES)
      throw new Error(`inMinutes must be a number from 1 to ${MAX_MINUTES}`);
    return now + Math.round(inMinutes * 60_000);
  }
  const when = typeof at === "string" ? Date.parse(at) : NaN;
  if (!Number.isFinite(when)) throw new Error('at must be an ISO time, like "2026-11-04T09:00:00Z"');
  return when;
}

const view = (timer: Timer) => ({ id: timer.id, due: new Date(timer.dueAt).toISOString(), note: timer.note });

/** The `timers.*` actions (agentApp.ts dispatches them here after checking their fields). */
export async function handleTimers(source: Session, action: string, input: Record<string, unknown>, host: AgentAppHost, now = Date.now()): Promise<unknown> {
  const timers = firstMate(source, host);
  switch (action) {
    case "timers.set": {
      const note = typeof input.note === "string" ? input.note.trim() : "";
      if (!note) throw new Error("note must say what to look at when it fires");
      const timer = await timers.timerSet({ ownerSession: source.id, dueAt: dueAt(input, now), note });
      return {
        ...view(timer),
        note: `Set. The app wakes you as a new turn ([MonoCode watcher]) at ${new Date(timer.dueAt).toISOString()}, even after a restart. End your turn; don't poll.`,
      };
    }
    case "timers.list": {
      const armed = await timers.timers(source.id);
      return { timers: armed.map(view) };
    }
    case "timers.cancel": {
      const id = typeof input.id === "string" ? input.id.trim() : "";
      if (!id) throw new Error("id must be a timer id, as timers.list shows it");
      const cancelled = await timers.timerCancel(source.id, id);
      if (!cancelled) throw new Error(`No timer ${id} is set in this chat. timers.list shows them.`);
      return { id, cancelled: true };
    }
  }
  throw new Error(`Unknown app action: ${action}`);
}
