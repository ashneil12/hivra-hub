// WP-164: the part that acts on the notable-event buffer (notableEvents.ts). Something records an event, this decides
// whether a ping is due and sends it. A tick of the app calls `flushNotableDue` too, so a held notice leaves when the
// quiet window ends and a second failure inside an interval leaves when the interval does.

import { announceNotablePing, notablePingsOn, type PingResult } from "./notifications";
import {
  commitFlush,
  commitNotable,
  commitUnsent,
  readNotableBuffer,
  saveNotableBuffer,
  type NotableBuffer,
  type NotablePing,
} from "./notableEvents";
import { loadQuietHours, type QuietHours } from "./quietHours";

/** How often the app looks for a ping that has become due. The buffer read is one small stored value. */
export const NOTABLE_LOOK_MS = 60_000;

export type NotableDeps = {
  read: () => NotableBuffer;
  save: (expectedRevision: number, next: NotableBuffer) => boolean;
  now: () => number;
  quiet: () => QuietHours;
  /** Whether a ping would be shown at all: banners on, and not denied by the system. */
  on: () => boolean;
  send: (ping: NotablePing) => Promise<PingResult>;
};

export function liveNotableDeps(): NotableDeps {
  return {
    read: readNotableBuffer,
    save: saveNotableBuffer,
    now: Date.now,
    quiet: loadQuietHours,
    on: notablePingsOn,
    send: announceNotablePing,
  };
}

/**
 * Sends the one ping that is due, if any. With banners off or denied nothing is sent and nothing is cleared, so the
 * morning habit still names what waited (it drops what it was shown, notableEvents.ts). Otherwise the buffer is cleared
 * first and stays cleared once the ping was shown. A ping the system refused goes back into the buffer and gives the
 * clock back, so the very next look tries again rather than waiting out an interval. Resolves null when nothing was
 * due.
 */
export async function flushNotableDue(deps: NotableDeps = liveNotableDeps()): Promise<PingResult | null> {
  if (!deps.on()) return "off";
  const flushed = commitFlush(deps.read, deps.save, deps.now(), { quiet: deps.quiet() });
  if (!flushed.ping) return null;
  let result: PingResult;
  try {
    result = await deps.send(flushed.ping);
  } catch {
    result = "failed";
  }
  if (result !== "shown") {
    commitUnsent(deps.read, deps.save, {
      released: flushed.released,
      previousFlushAt: flushed.previousFlushAt,
      flushedAt: flushed.buffer.lastFlushAt,
    });
  }
  return result;
}

/** Records one event, then sends a ping at once if one is due. A bad event is dropped without a ping. */
export async function noteNotable(raw: unknown, deps: NotableDeps = liveNotableDeps()): Promise<void> {
  commitNotable(deps.read, deps.save, raw);
  await flushNotableDue(deps);
}
