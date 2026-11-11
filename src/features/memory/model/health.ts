// WP-100: how memory is going, in plain numbers for the Memory screen. Every count is read from the doc's own record,
// so a person can see what the curator has been doing and whether anything is waiting for them.

import type { CuratorOutcome } from "./curator";
import { bump, type MemoryDoc, type MemoryHealth } from "./doc";
import { ASK_BELOW, fadeOf } from "./fade";
import { dueForAsk } from "./ask";

/** A health record with every count at zero. */
export function emptyHealth(): MemoryHealth {
  return { turns: 0, stored: 0, deferred: 0, dropped: { late: 0, secret: 0, ungrounded: 0, invalid: 0, orders: 0, forgotten: 0 } };
}

/**
 * The doc with one curator outcome counted. Every turn counts, whichever way it went, so the card can say when the
 * curator last looked even in a week with no facts in it.
 */
export function noteOutcome(doc: MemoryDoc, outcome: CuratorOutcome, at: number): MemoryDoc {
  const health = doc.health ?? emptyHealth();
  const next: MemoryHealth = { ...health, turns: health.turns + 1, dropped: { ...health.dropped }, lastRunAt: at };
  if (outcome.status === "stored") next.stored = health.stored + 1;
  else if (outcome.status === "deferred") next.deferred = health.deferred + 1;
  else if (outcome.status === "dropped") next.dropped[outcome.reason] = health.dropped[outcome.reason] + 1;
  return bump({ ...doc, health: next });
}

/**
 * WP-240: one batch counted: every message it read is a looked-at turn, and each change it proposed is stored or
 * dropped like a turn's.
 */
export function noteBatch(doc: MemoryDoc, read: number, outcomes: readonly CuratorOutcome[], at: number): MemoryDoc {
  const health = doc.health ?? emptyHealth();
  const next: MemoryHealth = { ...health, turns: health.turns + read, dropped: { ...health.dropped }, lastRunAt: at };
  for (const outcome of outcomes) {
    if (outcome.status === "stored") next.stored += 1;
    else if (outcome.status === "dropped") next.dropped[outcome.reason] += 1;
  }
  return bump({ ...doc, health: next });
}

/**
 * WP-103: one turn left for later, counted once. It is not a looked-at turn: the same turn is tried again and, when it
 * goes through, noteOutcome counts it then. So this moves `deferred` only.
 */
export function noteDeferred(doc: MemoryDoc, at: number): MemoryDoc {
  const health = doc.health ?? emptyHealth();
  return bump({ ...doc, health: { ...health, deferred: health.deferred + 1, dropped: { ...health.dropped }, lastRunAt: at } });
}

export type MemoryHealthView = MemoryHealth & {
  /** Facts under the ask line right now, whether or not they can still be asked. */
  fading: number;
  /** Questions the person can still act on: fading facts that have not been asked their three times. */
  asksWaiting: number;
};

/**
 * The card's numbers: what the curator has done, when it last looked, how many facts are fading, and how many
 * questions are waiting. A fact the person wrote does not fade, so it is neither.
 */
export function healthOf(doc: MemoryDoc, at: number): MemoryHealthView {
  const health = doc.health ?? emptyHealth();
  const fading = doc.items.filter((item) => fadeOf(doc, item, at) < ASK_BELOW).length;
  const asksWaiting = doc.items.filter((item) => dueForAsk(doc, item, at)).length;
  return { ...health, dropped: { ...health.dropped }, fading, asksWaiting };
}
