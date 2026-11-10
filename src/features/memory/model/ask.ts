// WP-100: a memory that has faded far enough is asked about once, in the Memory screen, and the person says what is
// true now. The answer decides, never the words: typed words only replace the text of an item the person says changed.

import { bump, mentionsSecret, normalizeFact, type MemoryDoc, type MemoryItem } from "./doc";
import { ASK_BELOW, clockDaysFor, fadeNow, livedClockOf, touch } from "./fade";

/** How old a fact must be before the screen may ask whether it is still true. */
const ASK_AFTER_MS = 86_400_000;
/** How many times one question may be shown before it is left alone. */
export const ASK_SHOWN_MAX = 3;
/** At most one question is on the screen at a time. */
const ASK_VISIBLE_MAX = 1;

/** What the person said about a fact. */
export type AskAnswer =
  | { kind: "still-true" }
  | { kind: "changed"; text: string }
  | { kind: "no-longer" }
  | { kind: "unsure" };

const KINDS = new Set<AskAnswer["kind"]>(["still-true", "changed", "no-longer", "unsure"]);

/** How many times this question has been shown. A missing or unreadable count is none. */
export function askedOf(item: MemoryItem): number {
  const asked = item.asked;
  if (typeof asked !== "number" || !Number.isFinite(asked) || asked < 0) return 0;
  return Math.floor(asked);
}

/** A fact that can be questioned at all: one of the person's own, confirmed or edited, not a skill or a removal. */
function questionOf(item: MemoryItem): boolean {
  // WP-111: a parked fact is waiting on the person's choice, so the ask card stays quiet.
  if (item.dispute) return false;
  return item.action === "add" && (item.state === "confirmed" || item.state === "edited");
}

function nowFade(doc: MemoryDoc, item: MemoryItem, at: number): number {
  return fadeNow(item, livedClockOf(doc), at);
}

/**
 * Whether the screen should ask about this fact now: it has faded under the line, it is at least a day old, it can be
 * questioned, and it has not been shown the full three times. A fact the person wrote does not fade, so it is never
 * asked. A fact that is not in the doc is not asked about.
 */
export function dueForAsk(doc: MemoryDoc, item: MemoryItem, at: number): boolean {
  if (!doc.items.some((have) => have.id === item.id)) return false;
  if (!questionOf(item)) return false;
  if (clockDaysFor(item) === undefined) return false;
  if (askedOf(item) >= ASK_SHOWN_MAX) return false;
  if (nowFade(doc, item, at) >= ASK_BELOW) return false;
  return at - Math.min(item.createdAt, item.updatedAt) >= ASK_AFTER_MS;
}

/**
 * The id the screen shows a question for: at most ASK_VISIBLE_MAX, the faintest first, then the oldest. The caller
 * then counts the showing with `askedNow`, so one question is not shown again and again.
 */
export function shownToday(doc: MemoryDoc, at: number): string[] {
  return doc.items
    .filter((item) => dueForAsk(doc, item, at))
    .map((item) => ({ item, fade: nowFade(doc, item, at) }))
    .sort((a, b) => a.fade - b.fade || a.item.createdAt - b.item.createdAt)
    .slice(0, ASK_VISIBLE_MAX)
    .map((row) => row.item.id);
}

/** The doc with one showing counted, and the sitting it happened in. Nothing changes for an id it does not hold. */
export function askedNow(doc: MemoryDoc, id: string, at: number): MemoryDoc {
  if (!doc.items.some((item) => item.id === id)) return doc;
  return bump({
    ...doc,
    items: doc.items.map((item) => (item.id === id ? { ...item, asked: askedOf(item) + 1 } : item)),
    askSession: { id, at },
  });
}

/**
 * The one question to put on screen now, or undefined. No question while one from this sitting is still open, so the
 * person answers one at a time. The caller counts the showing with `askedNow`.
 */
export function nextAsk(doc: MemoryDoc, at: number): MemoryItem | undefined {
  if (sittingAsk(doc, at) !== undefined) return undefined;
  const [id] = shownToday(doc, at);
  return id ? doc.items.find((item) => item.id === id) : undefined;
}

function answerOf(value: unknown): AskAnswer | undefined {
  if (!value || typeof value !== "object") return undefined;
  const answer = value as Partial<AskAnswer>;
  if (typeof answer.kind !== "string" || !KINDS.has(answer.kind as AskAnswer["kind"])) return undefined;
  if (answer.kind === "changed") return { kind: "changed", text: typeof answer.text === "string" ? answer.text : "" };
  return { kind: answer.kind as "still-true" | "no-longer" | "unsure" };
}

/** One sitting lasts this long. Within it, the screen shows the person one question at most. */
const SESSION_MS = 30 * 60_000;

/**
 * Whether a sitting is already open for one question: a question shown or answered within the last SESSION_MS. The
 * screen shows at most one question per sitting, so two people's worth of answers never arrive at once.
 */
export function sittingAsk(doc: MemoryDoc, at: number): string | undefined {
  const sitting = doc.askSession;
  if (!sitting || !Number.isFinite(sitting.at) || at < sitting.at || at - sitting.at >= SESSION_MS) return undefined;
  return sitting.id;
}

/**
 * Applies what the person said. There is one ask per fact: once it is answered, it is never asked again, whatever the
 * answer was. Still true and changed both count as a use, so the fact starts its clock again. No longer true removes
 * it. Unsure leaves the fact exactly as it is: it must not keep a fact alive by itself. An answer about a fact that is
 * not fading changes nothing, so no answer moves a fact the screen was not asking about.
 */
export function askAnswer(doc: MemoryDoc, id: string, answer: AskAnswer, at: number): MemoryDoc {
  const said = answerOf(answer);
  const item = doc.items.find((have) => have.id === id);
  if (!said || !item) return doc;
  if (!questionOf(item)) return doc;
  if (nowFade(doc, item, at) >= ASK_BELOW) return doc;
  const answered = { ...item, asked: ASK_SHOWN_MAX };

  if (said.kind === "no-longer") {
    return bump({ ...doc, items: doc.items.filter((have) => have.id !== id) });
  }

  if (said.kind === "unsure") {
    return bump({ ...doc, items: doc.items.map((have) => (have.id === id ? answered : have)) });
  }

  if (said.kind === "still-true") {
    const used = touch({ ...answered, support: item.support + 1 }, at);
    return bump({ ...doc, items: doc.items.map((have) => (have.id === id ? used : have)) });
  }

  // Changed: the wording the person typed replaces the fact, keeps its id and its history, and the fact is theirs now.
  const clean = normalizeFact(said.text);
  const used = touch({ ...answered, support: item.support + 1 }, at);
  const replaced =
    clean && !mentionsSecret(clean) ? { ...used, text: clean, state: "edited" as const, updatedAt: at } : used;
  return bump({ ...doc, items: doc.items.map((have) => (have.id === id ? replaced : have)) });
}
