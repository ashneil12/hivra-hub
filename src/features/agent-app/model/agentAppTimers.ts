// Hivra WP-11: timers a first mate sets (src-tauri/src/watcher/timers.rs): the `timers.*` app actions, reached with
// `monocode app timers.*`. A due timer becomes a wake in the first mate's queue ([MonoCode watcher]), so a first mate
// ends its turn instead of polling. Only a first mate's own chat (a Mono's chat or a coding-team chat) sets them.
import { sessionWorkCwd, type Session } from "../../sessions/model/session";
import { commandNamesLogin, safeCommand } from "../../autopilot/model/safeApproval";
import { tauriWakeQueue, type Check, type Timer, type WakeQueueBackend } from "../../firstmate/watcher/wakeQueue";
import type { AgentAppHost } from "./agentApp";

/** The FIELDS entries of the timer actions (agentApp.ts). */
export const TIMER_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["timers.set", ["inMinutes", "at", "note"]],
  ["timers.list", []],
  ["timers.cancel", ["id"]],
  ["timers.check", ["command", "pattern", "note", "everyMinutes"]],
];

export type AgentAppTimersHost = Pick<WakeQueueBackend, "timerSet" | "timerCancel" | "timers" | "checkSet" | "checkCancel">;

const MAX_MINUTES = 30 * 24 * 60;
/** A check looks at most once a minute, and stops after a day. */
const CHECK_MAX_MINUTES = 24 * 60;

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

/** `everyMinutes` from 1 to a day, defaulting to every minute. */
function everyMinutes(value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > CHECK_MAX_MINUTES)
    throw new Error(`everyMinutes must be a number from 1 to ${CHECK_MAX_MINUTES}`);
  return Math.round(value);
}

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
      if (!cancelled && !(await timers.checkCancel(source.id, id)))
        throw new Error(`No timer ${id} is set in this chat. timers.list shows them.`);
      return { id, cancelled: true };
    }
    case "timers.check": {
      const command = typeof input.command === "string" ? input.command.trim() : "";
      if (!command) throw new Error("command must be a read the app can run by itself");
      if ([...command].length > 2000) throw new Error("that command is too long");
      // Round 2: the same login-store and hidden-file check autopilot's approvals make, since the table alone allowed
      // `cat ~/.netrc` and `rg -g '.env*'`.
      const why = safeCommand(command, undefined, true) ?? commandNamesLogin(command);
      if (why) throw new Error(`That command doesn't run by itself: ${why}`);
      const pattern = input.pattern === undefined ? "" : input.pattern;
      if (typeof pattern !== "string" || [...pattern].length > 200)
        throw new Error("pattern must be text to watch for, at most 200 characters");
      const note = typeof input.note === "string" ? input.note.trim() : "";
      if (!note) throw new Error("note must say what this check is for");
      const every = everyMinutes(input.everyMinutes);
      // Stored with the check: it runs in the folder this chat works in, not wherever the app was started.
      const cwd = sessionWorkCwd(source);
      const check: Check = await timers.checkSet({
        ownerSession: source.id,
        command,
        pattern,
        note,
        intervalMs: every * 60_000,
        cwd,
      });
      const gap = every === 1 ? "minute" : `${every} minutes`;
      return {
        id: check.id,
        note: `Set. The app runs this check every ${gap}, in ${cwd}, and wakes you once as a new turn ([MonoCode watcher]) when it passes or its text matches, even after a restart. It stops after 24 hours. End your turn; don't poll.`,
      };
    }
  }
  throw new Error(`Unknown app action: ${action}`);
}
