// WP-164: notable programme events leave as one ping, not one each. Leftovers wait for the morning habit.

import { MORNING_HABIT_ID } from "../../chief/model/habit";

export const NOTABLE_BUFFER_KEY = "monocode.notableEvents.v1";
export const NOTABLE_FLUSH_MS = 30 * 60 * 1000;
export const NOTABLE_PING_LIMIT = 8;
export const MORNING_NOTE_LIMIT = 40;
const TEXT_MAX = 160;
const ID_MAX = 200;

export const NOTABLE_KINDS = ["park-needed", "ci-red", "tick-failed"] as const;
export type NotableKind = (typeof NOTABLE_KINDS)[number];

export type NotableEvent = {
  id: string;
  kind: NotableKind;
  text: string;
  at: number;
};

export type NotableBuffer = {
  revision: number;
  /** 0 means a flush has never happened, so the first one is due. */
  lastFlushAt: number;
  pending: NotableEvent[];
};

export type NotablePing = { title: string; body: string };

const LABELS: Record<NotableKind, string> = {
  "park-needed": "Security park needed",
  "ci-red": "CI failed",
  "tick-failed": "A tick failed",
};

export function emptyNotableBuffer(): NotableBuffer {
  return { revision: 0, lastFlushAt: 0, pending: [] };
}

function isKind(value: unknown): value is NotableKind {
  return NOTABLE_KINDS.some((kind) => kind === value);
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[<>]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) : text;
}

function parseEvent(raw: unknown): NotableEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string") return null;
  const id = value.id.trim();
  if (!id || id.length > ID_MAX) return null;
  if (!isKind(value.kind)) return null;
  const text = cleanText(value.text);
  if (!text) return null;
  if (typeof value.at !== "number" || !Number.isFinite(value.at) || value.at < 0) return null;
  return { id, kind: value.kind, text, at: value.at };
}

function ordered(events: readonly NotableEvent[]): NotableEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.at - b.event.at || a.index - b.index)
    .map((item) => item.event);
}

function whole(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Disk is untrusted. Bad events are dropped; a bad shell becomes an empty buffer. */
export function parseNotableBuffer(raw: unknown): NotableBuffer {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyNotableBuffer();
  const value = raw as Record<string, unknown>;
  const revision = whole(value.revision);
  const lastFlushAt = whole(value.lastFlushAt);
  if (revision === null || lastFlushAt === null) return emptyNotableBuffer();
  const pending: NotableEvent[] = [];
  const seen = new Set<string>();
  if (Array.isArray(value.pending)) {
    for (const item of value.pending) {
      const event = parseEvent(item);
      if (!event || seen.has(event.id)) continue;
      seen.add(event.id);
      pending.push(event);
    }
  }
  return { revision, lastFlushAt, pending: ordered(pending) };
}

/** Same buffer back when the event is not kept, so a caller can see that nothing changed. */
export function recordNotable(buffer: NotableBuffer, raw: unknown): NotableBuffer {
  const event = parseEvent(raw);
  if (!event || buffer.pending.some((item) => item.id === event.id)) return buffer;
  return {
    revision: buffer.revision + 1,
    lastFlushAt: buffer.lastFlushAt,
    pending: ordered([...buffer.pending, event]),
  };
}

function lines(events: readonly NotableEvent[], limit: number): string {
  const all = events.map((event) => `${LABELS[event.kind]}: ${event.text}`);
  const shown = all.slice(0, limit);
  const rest = all.length - shown.length;
  return rest > 0 ? `${shown.join("\n")}\nAnd ${rest} more.` : shown.join("\n");
}

export function notablePing(events: readonly NotableEvent[]): NotablePing | null {
  if (!events.length) return null;
  return {
    title: events.length === 1 ? LABELS[events[0].kind] : `${events.length} programme notices`,
    body: lines(events, NOTABLE_PING_LIMIT),
  };
}

/**
 * One ping when the interval has passed. Nothing due comes back as the same
 * buffer, so a caller does not write. A bad clock does not flush and does not throw.
 */
export function flushNotable(
  buffer: NotableBuffer,
  now: number,
  intervalMs = NOTABLE_FLUSH_MS,
): { buffer: NotableBuffer; ping: NotablePing | null } {
  if (!buffer.pending.length || !Number.isFinite(now)) return { buffer, ping: null };
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : NOTABLE_FLUSH_MS;
  const due =
    buffer.lastFlushAt === 0 ||
    (now >= buffer.lastFlushAt && now - buffer.lastFlushAt >= interval);
  if (!due) return { buffer, ping: null };
  return {
    buffer: { revision: buffer.revision + 1, lastFlushAt: now, pending: [] },
    ping: notablePing(buffer.pending),
  };
}

/** Unflushed events, oldest first. Empty when there is nothing to add to the morning run. */
export function morningNotableNote(buffer: NotableBuffer): string {
  if (!buffer.pending.length) return "";
  return `Notable events still waiting:\n${lines(buffer.pending, MORNING_NOTE_LIMIT)}`;
}

export function readNotableBuffer(): NotableBuffer {
  try {
    const raw = localStorage.getItem(NOTABLE_BUFFER_KEY);
    if (raw == null) return emptyNotableBuffer();
    return parseNotableBuffer(JSON.parse(raw));
  } catch {
    return emptyNotableBuffer();
  }
}

/**
 * Writes only when the stored revision is still `expectedRevision` and `next`
 * is the next revision. A read that throws does not write.
 */
export function saveNotableBuffer(expectedRevision: number, next: NotableBuffer): boolean {
  let raw: string | null;
  try {
    raw = localStorage.getItem(NOTABLE_BUFFER_KEY);
  } catch {
    return false;
  }
  let current = emptyNotableBuffer();
  if (raw != null) {
    try {
      current = parseNotableBuffer(JSON.parse(raw));
    } catch {
      current = emptyNotableBuffer();
    }
  }
  if (current.revision !== expectedRevision || next.revision !== expectedRevision + 1) return false;
  localStorage.setItem(NOTABLE_BUFFER_KEY, JSON.stringify(next));
  return true;
}

/** In-memory store with the same revision check as the disk store. */
export function notableMemory(initial?: NotableBuffer): {
  read: () => NotableBuffer;
  save: (expectedRevision: number, next: NotableBuffer) => boolean;
} {
  let current = initial ?? emptyNotableBuffer();
  return {
    read: () => current,
    save: (expectedRevision, next) => {
      if (current.revision !== expectedRevision || next.revision !== expectedRevision + 1) return false;
      current = next;
      return true;
    },
  };
}

type ReadBuffer = () => NotableBuffer;
type SaveBuffer = (expectedRevision: number, next: NotableBuffer) => boolean;

/** One attempt. `saved` is false when another writer won or the write threw. */
export function rememberNotable(
  read: ReadBuffer,
  save: SaveBuffer,
  raw: unknown,
): { buffer: NotableBuffer; saved: boolean } {
  const current = read();
  const next = recordNotable(current, raw);
  if (next === current) return { buffer: current, saved: true };
  try {
    if (save(current.revision, next)) return { buffer: next, saved: true };
  } catch {
    // quota or a locked store: the event is still with the caller
  }
  return { buffer: read(), saved: false };
}

/** Retries a lost race. Still false after `attempts` means the event is not stored. */
export function commitNotable(
  read: ReadBuffer,
  save: SaveBuffer,
  raw: unknown,
  attempts = 3,
): { buffer: NotableBuffer; saved: boolean } {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = rememberNotable(read, save, raw);
    if (result.saved) return result;
  }
  return { buffer: read(), saved: false };
}

/**
 * Flushes when due. A ping is returned only after the clear is stored, so a
 * lost race cannot send a list that was never kept. Not due does not write.
 */
export function commitFlush(
  read: ReadBuffer,
  save: SaveBuffer,
  now: number,
  intervalMs = NOTABLE_FLUSH_MS,
  attempts = 3,
): { buffer: NotableBuffer; ping: NotablePing | null; saved: boolean } {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = read();
    const flushed = flushNotable(current, now, intervalMs);
    if (!flushed.ping) return { buffer: current, ping: null, saved: true };
    try {
      if (save(current.revision, flushed.buffer)) {
        return { buffer: flushed.buffer, ping: flushed.ping, saved: true };
      }
    } catch {
      // try again on the next pass; the events are still pending
    }
  }
  return { buffer: read(), ping: null, saved: false };
}

/** The morning habit's extra note. Any other habit, or a read that throws, adds nothing. */
export function morningHabitExtra(habitId: string, read: ReadBuffer = readNotableBuffer): string {
  if (habitId !== MORNING_HABIT_ID) return "";
  try {
    return morningNotableNote(read());
  } catch {
    return "";
  }
}
