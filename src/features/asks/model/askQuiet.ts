// A quiet ask reaches the person (gap A7, formal/asks/README.md; the spec's "after two nudges, in red, in Needs you").
// An open ask that two daily checks found with nothing moved becomes one Needs you row, once. The count lives on the ask
// (`Ask.chase`) and is only good while the ask is exactly as it was: any change to it (a status, a note, a reopen) moves
// its `updatedAt` on, so the count stops being live, the row goes, and a later quiet spell counts from nothing. Pure: the
// store applies these in its revision-checked write, and the Needs you list reads `raisedAsks`.
//
// What "the daily check" counts is what it already names (askNotes.ts `staleAsks`: heard for a day, started and unmoved for
// three) plus an ask waiting on the person for the same three days, which the check to the first mate leaves alone: the
// first mate has done its part. A maybe, an idea, an untouched lone short ask and anything heard in a chat that is no first
// mate's are never counted.

import { DIGEST_EVERY_MS, DIGEST_STARTED_MS, how, line, ASK_NUDGE_PREFIX, staleAsks } from "./askNotes";
import { HUB_MATE, isOpen, isQuiet, withChange, withDigestMark, type Ask, type AskDoc, type Chase } from "./asks";
import type { QueuedMessage } from "../../sessions/model/session";

/** Daily checks with nothing moved before the ask is put in front of the person. */
export const QUIET_CHECKS = 2;

export type QuietChange = { doc: AskDoc } | { problem: string };

const GONE = "That ask is not on the list any more.";
const MOVED = "That one moved while you were looking.";

/** The count, while it is still about this ask as it stands now. */
export function chaseOf(ask: Ask): Chase | undefined {
  return ask.chase && ask.chase.at === ask.updatedAt && isOpen(ask) ? ask.chase : undefined;
}

/** The asks one first mate's daily check counts, oldest first. */
export function quietAsks(doc: AskDoc, mateId: string, now: number): Ask[] {
  if (mateId === HUB_MATE) return [];
  const waiting = doc.asks.filter((ask) => ask.mateId === mateId && ask.status === "waiting" && now - ask.updatedAt >= DIGEST_STARTED_MS);
  return [...staleAsks(doc, mateId, now), ...waiting].filter((ask) => ask.kind !== "idea" && !isQuiet(ask)).sort((a, b) => a.n - b.n);
}

/**
 * A check is due for a first mate that has nothing to be told but has an ask waiting on the person: the daily check to
 * the first mate does not name it, and its count must still move. Once a day, and not once every such ask is raised.
 */
export function quietCheckOnlyDue(doc: AskDoc, mateId: string, now: number): boolean {
  if (now - (doc.nudged[mateId] ?? 0) < DIGEST_EVERY_MS) return false;
  if (staleAsks(doc, mateId, now).length) return false;
  return quietAsks(doc, mateId, now).some((ask) => chaseOf(ask)?.raisedAt === undefined);
}

function counted(ask: Ask, now: number): Ask {
  const live = chaseOf(ask);
  if (live?.raisedAt !== undefined) return ask;
  const checks = (live?.checks ?? 0) + 1;
  const chase: Chase = {
    at: ask.updatedAt,
    checks,
    ...(live?.remindAt !== undefined ? { remindAt: live.remindAt } : {}),
    ...(checks >= QUIET_CHECKS ? { raisedAt: now } : {}),
  };
  return { ...ask, chase };
}

/**
 * The daily check for a first mate was made: its time is kept (as `withDigestMark` always did) and every ask it counts has one
 * more check with nothing moved; the second raises it. A check made again inside a day (a second window, a retried write)
 * keeps the time and counts nothing, so one check is one.
 */
export function withDailyCheck(doc: AskDoc, mateId: string, now: number): AskDoc {
  const fresh = now - (doc.nudged[mateId] ?? 0) >= DIGEST_EVERY_MS;
  const marked = withDigestMark(doc, mateId, now);
  if (!fresh) return marked;
  const ids = new Set(quietAsks(doc, mateId, now).map((ask) => ask.id));
  if (!ids.size) return marked;
  return { ...marked, asks: marked.asks.map((ask) => (ids.has(ask.id) ? counted(ask, now) : ask)) };
}

/** The asks that are Needs you rows now: open, raised, and exactly as they were when raised. */
export function raisedAsks(doc: AskDoc): Ask[] {
  return doc.asks.filter((ask) => ask.mateId !== HUB_MATE && ask.status !== "maybe" && chaseOf(ask)?.raisedAt !== undefined).sort((a, b) => a.n - b.n);
}

/** The asks the person asked to be reminded of and whose reminder is not sent yet. */
export function pendingReminders(doc: AskDoc): Ask[] {
  return doc.asks.filter((ask) => chaseOf(ask)?.remindAt !== undefined).sort((a, b) => a.n - b.n);
}

/** The ask a card is about, only while it is still the row that card was drawn for. */
function raisedFor(doc: AskDoc, id: string, raisedAt: number): Ask | string {
  const ask = doc.asks.find((item) => item.id === id);
  if (!ask || !isOpen(ask)) return GONE;
  return chaseOf(ask)?.raisedAt === raisedAt ? ask : MOVED;
}

function withChase(doc: AskDoc, ask: Ask, chase: Chase | undefined): AskDoc {
  const { chase: _old, ...rest } = ask;
  return { ...doc, asks: doc.asks.map((item) => (item.id === ask.id ? (chase ? { ...rest, chase } : rest) : item)) };
}

/**
 * The person asked for a reminder: one is queued for the first mate (the app sends it), the row goes and the count starts
 * again, so an ask the first mate still leaves quiet comes back after two more checks. Refused when the ask moved or closed
 * since the card was drawn.
 */
export function withRemind(doc: AskDoc, id: string, raisedAt: number, now: number): QuietChange {
  const ask = raisedFor(doc, id, raisedAt);
  if (typeof ask === "string") return { problem: ask };
  return { doc: withChase(doc, ask, { at: ask.updatedAt, checks: 0, remindAt: now }) };
}

/** The reminder was sent. Only the one that was sent: a newer one queued since stays. */
export function withReminderSent(doc: AskDoc, id: string, remindAt: number): AskDoc {
  const ask = doc.asks.find((item) => item.id === id);
  const live = ask ? chaseOf(ask) : undefined;
  if (!ask || !live || live.remindAt !== remindAt) return doc;
  return withChase(doc, ask, live.checks > 0 ? { at: live.at, checks: live.checks, ...(live.raisedAt !== undefined ? { raisedAt: live.raisedAt } : {}) } : undefined);
}

/** The person answered (the card's box, or a message in the chat): the row goes and the count starts again. */
export function withAnswered(doc: AskDoc, id: string, raisedAt: number): QuietChange {
  const ask = raisedFor(doc, id, raisedAt);
  if (typeof ask === "string") return { problem: ask };
  const live = chaseOf(ask);
  return { doc: withChase(doc, ask, { at: ask.updatedAt, checks: 0, ...(live?.remindAt !== undefined ? { remindAt: live.remindAt } : {}) }) };
}

/** "Let it go": the person's own drop, through the same path a tap on "Drop this ask" takes, and only for the row the card was drawn for. */
export function withLetGo(doc: AskDoc, id: string, raisedAt: number, now: number): QuietChange {
  const ask = raisedFor(doc, id, raisedAt);
  if (typeof ask === "string") return { problem: ask };
  const out = withChange(doc, id, { status: "dropped" }, "ash", now);
  return "problem" in out ? { problem: out.problem } : { doc: out.doc };
}

/** The app message that reminds a first mate of an ask the person asked about. Its id is the same for the same reminder, so a resend is a no-op. */
export function remindMessage(ask: Ask, cli: string, remindAt: number): QueuedMessage {
  const since = new Date(ask.createdAt).toISOString().slice(0, 10);
  return {
    id: `asks-remind-${ask.id}-${remindAt}`,
    attachments: [],
    waitForIdle: true,
    text: `${ASK_NUDGE_PREFIX} From the app: Ash saw that this ask has been open since ${since} with no word from you, and asked you to pick it up:\n${line(ask)}\nDo it now if it is small, otherwise start it or hand it to a worker, or mark it waiting with what you need from Ash. ${how(cli)} Then tell Ash in a line where it stands. This is an app notification, not a new message from Ash.`,
  };
}
