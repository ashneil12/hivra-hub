// One prompt, once, at a local date and time. The open app fires it. A closed app misses it.
// No login item and no background service: a later package hosts runs while the desktop is shut.

export const CLOSED_APP_WARNING =
  "Hivra only runs this while it is open. If Hivra is closed at this time, the run is missed.";

export const ONE_TIME_STATUSES = ["scheduled", "fired", "missed", "cancelled"] as const;
export type OneTimeStatus = (typeof ONE_TIME_STATUSES)[number];

export type OneTimeTarget =
  | { kind: "chat"; sessionId: string }
  | { kind: "project"; projectId: string };

export type OneTimeClaim = { token: string; until: number };

export type OneTimeSchedule = {
  id: string;
  target: OneTimeTarget;
  prompt: string;
  /** Instant the person chose, in milliseconds since the unix epoch. */
  runAt: number;
  /** The wall time they picked, `YYYY-MM-DDTHH:mm`, in the machine's zone. */
  localText?: string;
  status: OneTimeStatus;
  createdAt: number;
  updatedAt: number;
  notedAt?: number;
  claim?: OneTimeClaim;
  startedSessionId?: string;
};

export type OneTimeNotice = { id: string; text: string };

export class RetryableScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableScheduleError";
  }
}

/** The copy is not allowed to start scheduled runs (a dev copy, or a build on trial). */
export class SchedulesPausedError extends Error {
  constructor() {
    super("This copy does not run one-time schedules.");
    this.name = "SchedulesPausedError";
  }
}

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const MAX_PROMPT = 100_000;
const MAX_PROJECT = 4096;
const DEFAULT_CLAIM_HOLD_MS = 10 * 60 * 1000;

export function instantFromLocalInput(value: string): number | null {
  const match = LOCAL.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || hour > 23 || minute > 59) {
    return null;
  }
  const instant = new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
  if (!Number.isFinite(instant)) return null;
  const back = new Date(instant);
  if (
    back.getFullYear() !== year ||
    back.getMonth() !== month - 1 ||
    back.getDate() !== day ||
    back.getHours() !== hour ||
    back.getMinutes() !== minute
  ) {
    return null;
  }
  return instant;
}

export function missedScheduleNotice(schedule: OneTimeSchedule): string {
  const when = schedule.localText ? schedule.localText.replace("T", " ") : "the chosen time";
  const preview = schedule.prompt.replace(/\s+/g, " ").trim();
  const short = preview.length > 80 ? `${preview.slice(0, 77)}...` : preview;
  return `A scheduled prompt was missed because Hivra was closed. "${short}" was set for ${when}.`;
}

export function oneTimeStatusLabel(status: OneTimeStatus): string {
  switch (status) {
    case "scheduled":
      return "Scheduled";
    case "fired":
      return "Fired";
    case "missed":
      return "Missed";
    case "cancelled":
      return "Cancelled";
  }
}

export type OneTimeCreateInput = {
  id?: string;
  target: OneTimeTarget;
  prompt: string;
  localText: string;
};

function copy(schedule: OneTimeSchedule): OneTimeSchedule {
  return {
    ...schedule,
    target: { ...schedule.target },
    ...(schedule.claim ? { claim: { ...schedule.claim } } : {}),
  };
}

function validId(value: string): boolean {
  return ID.test(value);
}

function validTarget(target: OneTimeTarget): boolean {
  if (target.kind === "chat") return validId(target.sessionId);
  if (target.kind !== "project") return false;
  if (target.projectId.length < 1 || target.projectId.length > MAX_PROJECT) return false;
  return !target.projectId.includes("\0") && !/[\r\n]/.test(target.projectId);
}

function validPrompt(prompt: string): boolean {
  return prompt.trim().length > 0 && prompt.length <= MAX_PROMPT && !prompt.includes("\0");
}

/** A row from disk. Invalid rows are dropped, not thrown. */
export function decodeOneTimeSchedule(raw: unknown): OneTimeSchedule | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<OneTimeSchedule>;
  if (typeof row.id !== "string" || !validId(row.id)) return null;
  if (!row.target || !validTarget(row.target as OneTimeTarget)) return null;
  if (typeof row.prompt !== "string" || !validPrompt(row.prompt)) return null;
  if (typeof row.runAt !== "number" || !Number.isSafeInteger(row.runAt) || row.runAt <= 0) return null;
  if (typeof row.status !== "string" || !ONE_TIME_STATUSES.includes(row.status as OneTimeStatus)) {
    return null;
  }
  if (typeof row.createdAt !== "number" || !Number.isSafeInteger(row.createdAt)) return null;
  if (typeof row.updatedAt !== "number" || !Number.isSafeInteger(row.updatedAt)) return null;
  const schedule: OneTimeSchedule = {
    id: row.id,
    target: row.target.kind === "chat"
      ? { kind: "chat", sessionId: row.target.sessionId }
      : { kind: "project", projectId: row.target.projectId },
    prompt: row.prompt,
    runAt: row.runAt,
    status: row.status as OneTimeStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (typeof row.localText === "string" && instantFromLocalInput(row.localText) === row.runAt) {
    schedule.localText = row.localText;
  }
  if (typeof row.notedAt === "number" && Number.isSafeInteger(row.notedAt)) schedule.notedAt = row.notedAt;
  if (typeof row.startedSessionId === "string" && validId(row.startedSessionId)) {
    schedule.startedSessionId = row.startedSessionId;
  }
  const claim = row.claim;
  if (
    claim &&
    typeof claim === "object" &&
    typeof claim.token === "string" &&
    validId(claim.token) &&
    typeof claim.until === "number" &&
    Number.isSafeInteger(claim.until)
  ) {
    schedule.claim = { token: claim.token, until: claim.until };
  }
  return schedule;
}

export interface OneTimeScheduleStore {
  list(): Promise<OneTimeSchedule[]>;
  create(input: OneTimeCreateInput, now: number): Promise<OneTimeSchedule>;
  cancel(id: string, now: number): Promise<OneTimeSchedule>;
  /** First call in this process marks due runs missed. Later calls only report ones not yet told. */
  missClosed(now: number): Promise<OneTimeSchedule[]>;
  claim(
    id: string,
    expectedUpdatedAt: number,
    token: string,
    until: number,
    now: number,
  ): Promise<OneTimeSchedule | null>;
  rememberSession(
    id: string,
    token: string,
    sessionId: string,
    now: number,
  ): Promise<OneTimeSchedule | null>;
  ackFired(id: string, token: string, now: number): Promise<OneTimeSchedule | null>;
  release(id: string, token: string, now: number): Promise<OneTimeSchedule | null>;
  note(id: string, now: number): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export function createMemoryOneTimeStore(dump?: string): OneTimeScheduleStore & { dump(): string } {
  const rows = new Map<string, OneTimeSchedule>();
  if (dump) {
    try {
      const parsed: unknown = JSON.parse(dump);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const row = decodeOneTimeSchedule(item);
          if (row && !rows.has(row.id)) rows.set(row.id, row);
        }
      }
    } catch {
      // A broken save starts empty. The next save replaces it.
    }
  }
  let reconciled = false;
  let snapshot: OneTimeSchedule[] = [];
  const listeners = new Set<() => void>();
  const publish = () => {
    snapshot = [...rows.values()].sort((a, b) => a.runAt - b.runAt || (a.id < b.id ? -1 : 1));
    for (const listener of listeners) listener();
  };
  publish();

  const requireRow = (id: string) => {
    const row = rows.get(id);
    if (!row) throw new Error("That schedule is not here.");
    return row;
  };

  return {
    async list() {
      return snapshot.map(copy);
    },
    async create(input, now) {
      const id = input.id ?? crypto.randomUUID();
      if (!validId(id)) throw new Error("That schedule id is not valid.");
      if (rows.has(id)) throw new Error("A schedule with this id already exists.");
      const prompt = input.prompt.trim();
      if (!validPrompt(input.prompt) || !prompt) throw new Error("Write a prompt first.");
      if (!input.target || !validTarget(input.target)) throw new Error("Choose a chat or a project.");
      const runAt = instantFromLocalInput(input.localText);
      if (runAt == null) throw new Error("That time is not a real date.");
      if (!(runAt > now)) throw new Error("Choose a time in the future.");
      const row: OneTimeSchedule = {
        id,
        target: input.target.kind === "chat"
          ? { kind: "chat", sessionId: input.target.sessionId }
          : { kind: "project", projectId: input.target.projectId },
        prompt,
        runAt,
        localText: input.localText,
        status: "scheduled",
        createdAt: now,
        updatedAt: now,
      };
      rows.set(id, row);
      publish();
      return copy(row);
    },
    async cancel(id, now) {
      const row = requireRow(id);
      if (row.status !== "scheduled") return copy(row);
      const next: OneTimeSchedule = {
        ...row,
        status: "cancelled",
        updatedAt: now,
      };
      delete next.claim;
      rows.set(id, next);
      publish();
      return copy(next);
    },
    async missClosed(now) {
      if (!reconciled) {
        reconciled = true;
        for (const row of rows.values()) {
          if (row.status === "scheduled" && row.runAt <= now) {
            const next: OneTimeSchedule = { ...row, status: "missed", updatedAt: now };
            delete next.claim;
            rows.set(row.id, next);
          }
        }
        publish();
      }
      return [...rows.values()]
        .filter((row) => row.status === "missed" && row.notedAt == null)
        .map(copy);
    },
    async claim(id, expectedUpdatedAt, token, until, now) {
      const row = rows.get(id);
      if (!row || row.status !== "scheduled" || row.updatedAt !== expectedUpdatedAt) return null;
      if (!validId(token) || !Number.isSafeInteger(until) || until <= now) return null;
      if (row.runAt > now) return null;
      if (row.claim && row.claim.until > now) return null;
      const next: OneTimeSchedule = {
        ...row,
        updatedAt: now,
        claim: { token, until },
      };
      rows.set(id, next);
      publish();
      return copy(next);
    },
    async rememberSession(id, token, sessionId, now) {
      const row = rows.get(id);
      if (!row || row.status !== "scheduled" || row.claim?.token !== token) return null;
      if (!validId(sessionId)) return null;
      if (row.startedSessionId && row.startedSessionId !== sessionId) return null;
      const next = { ...row, startedSessionId: sessionId, updatedAt: now };
      rows.set(id, next);
      publish();
      return copy(next);
    },
    async ackFired(id, token, now) {
      const row = rows.get(id);
      if (!row || row.status !== "scheduled" || row.claim?.token !== token) return null;
      if (row.runAt > now) return null;
      const next: OneTimeSchedule = { ...row, status: "fired", updatedAt: now };
      delete next.claim;
      rows.set(id, next);
      publish();
      return copy(next);
    },
    async release(id, token, now) {
      const row = rows.get(id);
      if (!row || row.status !== "scheduled" || row.claim?.token !== token) return null;
      const next: OneTimeSchedule = { ...row, updatedAt: now };
      delete next.claim;
      rows.set(id, next);
      publish();
      return copy(next);
    },
    async note(id, now) {
      const row = rows.get(id);
      if (!row || row.status !== "missed" || row.notedAt != null) return;
      rows.set(id, { ...row, notedAt: now, updatedAt: now });
      publish();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dump() {
      return JSON.stringify([...rows.values()]);
    },
  };
}

export async function tickOneTimeSchedules(options: {
  mode: "launch" | "open";
  now: number;
  store: OneTimeScheduleStore;
  send: (schedule: OneTimeSchedule) => Promise<void>;
  tokens?: string[];
  claimHoldMs?: number;
}): Promise<{ notices: OneTimeNotice[] }> {
  if (options.mode === "launch") {
    const missed = await options.store.missClosed(options.now);
    return { notices: missed.map((row) => ({ id: row.id, text: missedScheduleNotice(row) })) };
  }
  const hold = options.claimHoldMs ?? DEFAULT_CLAIM_HOLD_MS;
  const rows = await options.store.list();
  let tokenIndex = 0;
  for (const row of rows) {
    if (row.status !== "scheduled" || row.runAt > options.now) continue;
    if (row.claim && row.claim.until > options.now) continue;
    // A fresh token per claim: a stale runner's ack or release must not land on a later claim.
    const token = options.tokens?.[tokenIndex] ?? crypto.randomUUID();
    tokenIndex += 1;
    let claimed: OneTimeSchedule | null;
    try {
      claimed = await options.store.claim(
        row.id,
        row.updatedAt,
        token,
        options.now + hold,
        options.now,
      );
    } catch (error) {
      if (error instanceof SchedulesPausedError) throw error;
      continue;
    }
    if (!claimed) continue;
    try {
      await options.send(claimed);
      let acked = await options.store.ackFired(claimed.id, token, options.now);
      if (!acked) {
        const current = (await options.store.list()).find((item) => item.id === claimed!.id);
        if (current?.status === "scheduled" && current.claim?.token === token) {
          acked = await options.store.ackFired(claimed.id, token, options.now);
        }
      }
    } catch (error) {
      if (error instanceof SchedulesPausedError) throw error;
      await options.store.release(claimed.id, token, options.now);
    }
  }
  return { notices: [] };
}

export type OneTimeDelivery = {
  findChat: (sessionId: string) => { id: string; busy: boolean } | null;
  findProject: (projectId: string) => { folder: string } | null;
  createChat: (folder: string) => Promise<string>;
  rememberSession: (
    schedule: OneTimeSchedule,
    sessionId: string,
  ) => Promise<OneTimeSchedule | null>;
  submit: (sessionId: string, prompt: string) => Promise<boolean>;
};

/** Start the prompt. A timeout or a busy chat throws {@link RetryableScheduleError} and stays scheduled. */
export async function deliverOneTimeSchedule(
  schedule: OneTimeSchedule,
  delivery: OneTimeDelivery,
): Promise<void> {
  if (schedule.target.kind === "chat") {
    const chat = delivery.findChat(schedule.target.sessionId);
    if (!chat) throw new RetryableScheduleError("That chat is not here yet.");
    if (chat.busy) throw new RetryableScheduleError("That chat is busy.");
    const accepted = await delivery.submit(chat.id, schedule.prompt);
    if (!accepted) throw new RetryableScheduleError("The chat did not take the prompt.");
    return;
  }
  let sessionId = schedule.startedSessionId;
  if (!sessionId) {
    const project = delivery.findProject(schedule.target.projectId);
    if (!project) throw new RetryableScheduleError("That project is not here yet.");
    sessionId = await delivery.createChat(project.folder);
    const saved = await delivery.rememberSession(schedule, sessionId);
    if (!saved) {
      throw new RetryableScheduleError("The schedule changed while the chat was created.");
    }
  }
  const chat = delivery.findChat(sessionId);
  if (!chat) throw new RetryableScheduleError("That chat is not here yet.");
  if (chat.busy) throw new RetryableScheduleError("That chat is busy.");
  const accepted = await delivery.submit(chat.id, schedule.prompt);
  if (!accepted) throw new RetryableScheduleError("The chat did not take the prompt.");
}
