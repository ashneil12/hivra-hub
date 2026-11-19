// The desktop store for one-time schedules. The open app is the only thing that fires them.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  SchedulesPausedError,
  decodeOneTimeSchedule,
  instantFromLocalInput,
  type OneTimeCreateInput,
  type OneTimeSchedule,
  type OneTimeScheduleStore,
} from "./oneTimeSchedule";

export const ONE_TIME_SCHEDULES_CHANGED = "monocode:one-time-schedules-changed";

function lift(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("does not run one-time schedules")) throw new SchedulesPausedError();
  throw error instanceof Error ? error : new Error(message);
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    lift(error);
  }
}

function kept(row: OneTimeSchedule): OneTimeSchedule {
  return decodeOneTimeSchedule(row) ?? row;
}

export function createTauriOneTimeStore(): OneTimeScheduleStore {
  const listeners = new Set<() => void>();
  const poke = () => {
    for (const listener of listeners) listener();
  };

  return {
    async list() {
      const rows = await call<unknown>("one_time_schedules_list");
      if (!Array.isArray(rows)) return [];
      return rows.flatMap((row) => {
        const decoded = decodeOneTimeSchedule(row);
        return decoded ? [decoded] : [];
      });
    },
    async create(input: OneTimeCreateInput, now: number) {
      const prompt = input.prompt.trim();
      if (!prompt) throw new Error("Write a prompt first.");
      const runAt = instantFromLocalInput(input.localText);
      if (runAt == null) throw new Error("That time is not a real date.");
      if (!(runAt > now)) throw new Error("Choose a time in the future.");
      const saved = await call<OneTimeSchedule>("one_time_schedules_create", {
        input: {
          id: input.id ?? crypto.randomUUID(),
          target: input.target,
          prompt,
          localText: input.localText,
          runAt,
        },
      });
      poke();
      return kept(saved);
    },
    async cancel(id, now) {
      void now;
      const saved = await call<OneTimeSchedule>("one_time_schedules_cancel", { id });
      poke();
      return kept(saved);
    },
    async missClosed(now) {
      void now;
      const rows = await call<unknown>("one_time_schedules_miss_closed");
      if (!Array.isArray(rows)) return [];
      return rows.flatMap((row) => {
        const decoded = decodeOneTimeSchedule(row);
        return decoded ? [decoded] : [];
      });
    },
    async claim(id, expectedUpdatedAt, token, until, now) {
      void now;
      const saved = await call<OneTimeSchedule | null>("one_time_schedules_claim", {
        id,
        expectedUpdatedAt,
        token,
        until,
      });
      if (saved) poke();
      return saved ? kept(saved) : null;
    },
    async rememberSession(id, token, sessionId, now) {
      void now;
      const saved = await call<OneTimeSchedule | null>("one_time_schedules_remember_session", {
        id,
        token,
        sessionId,
      });
      if (saved) poke();
      return saved ? kept(saved) : null;
    },
    async ackFired(id, token, now) {
      void now;
      const saved = await call<OneTimeSchedule | null>("one_time_schedules_ack_fired", {
        id,
        token,
      });
      if (saved) poke();
      return saved ? kept(saved) : null;
    },
    async release(id, token, now) {
      void now;
      const saved = await call<OneTimeSchedule | null>("one_time_schedules_release", { id, token });
      if (saved) poke();
      return saved ? kept(saved) : null;
    },
    async markHandedOff(id, token, now) {
      void now;
      const saved = await call<OneTimeSchedule | null>("one_time_schedules_mark_handed_off", {
        id,
        token,
      });
      if (saved) poke();
      return saved ? kept(saved) : null;
    },
    async markUndeliverable(id, token, now) {
      void now;
      const saved = await call<OneTimeSchedule | null>("one_time_schedules_mark_undeliverable", {
        id,
        token,
      });
      if (saved) poke();
      return saved ? kept(saved) : null;
    },
    async markLate(id, now) {
      void now;
      const saved = await call<OneTimeSchedule | null>("one_time_schedules_mark_late", { id });
      if (saved) poke();
      return saved ? kept(saved) : null;
    },
    async note(id, now) {
      void now;
      await call("one_time_schedules_note", { id });
      poke();
    },
    subscribe(listener) {
      listeners.add(listener);
      let stop = () => {};
      let alive = true;
      void listen(ONE_TIME_SCHEDULES_CHANGED, () => listener()).then(
        (unlisten) => {
          if (!alive) unlisten();
          else stop = unlisten;
        },
        () => undefined,
      );
      return () => {
        alive = false;
        listeners.delete(listener);
        stop();
      };
    },
  };
}
