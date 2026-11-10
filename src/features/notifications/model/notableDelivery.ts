// WP-164: the part that acts on the notable-event buffer (notableEvents.ts). Something records an event, this decides
// whether a ping is due and sends it. A tick of the app calls `flushNotableDue` too, so a held notice leaves when the
// quiet window ends and a second failure inside an interval leaves when the interval does.

import { announceNotablePing, type PingResult } from "./notifications";
import {
  commitFlush,
  commitNotable,
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
  send: (ping: NotablePing) => Promise<PingResult>;
};

export function liveNotableDeps(): NotableDeps {
  return {
    read: readNotableBuffer,
    save: saveNotableBuffer,
    now: Date.now,
    quiet: loadQuietHours,
    send: announceNotablePing,
  };
}

/**
 * Sends the one ping that is due, if any. The buffer is cleared first and stays cleared when the ping was shown, or
 * when notifications are off (a person who turned banners off is owed none). A ping the system refused goes back into
 * the buffer, so the next look tries again. Resolves null when nothing was due.
 */
export async function flushNotableDue(deps: NotableDeps = liveNotableDeps()): Promise<PingResult | null> {
  const flushed = commitFlush(deps.read, deps.save, deps.now(), { quiet: deps.quiet() });
  if (!flushed.ping) return null;
  let result: PingResult;
  try {
    result = await deps.send(flushed.ping);
  } catch {
    result = "failed";
  }
  if (result === "failed") {
    for (const event of flushed.released) commitNotable(deps.read, deps.save, event);
  }
  return result;
}

/** Records one event, then sends a ping at once if one is due. A bad event is dropped without a ping. */
export async function noteNotable(raw: unknown, deps: NotableDeps = liveNotableDeps()): Promise<void> {
  commitNotable(deps.read, deps.save, raw);
  await flushNotableDue(deps);
}
