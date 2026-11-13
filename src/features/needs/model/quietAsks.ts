// A quiet ask as a Needs you row (gap A7, asks/model/askQuiet.ts): "You asked: <the ask's words>", "Still open since
// Tuesday. Mia hasn't moved it." and three answers: Answer it (the chat that asked, on the message), Let it go (the
// person's own drop) and Remind <first mate> (one app message to the first mate). The ledger decides which asks are
// rows (`raisedAsks`); this only words them and wires what each answer does, through functions the caller hands in so
// a test needs no app.
import { chaseOf } from "../../asks/model/askQuiet";
import type { Ask } from "../../asks/model/asks";
import type { AskFact } from "./needsYou";

export const ANSWER_IT = "Answer it";
export const LET_IT_GO = "Let it go";
export const remindLabel = (name: string): string => `Remind ${name}`;

/** The first mate that has the ask, by the name a person calls it. Absent when it was removed. */
export type QuietAskMate = { name?: string; projectId?: string };

export type QuietAskDeps = {
  mate: (ask: Ask) => QuietAskMate | undefined;
  /** Open the chat that asked, on the message that asked. */
  jump: (ask: Ask) => void;
  /** Each resolves to why it was refused, or undefined when done. `raisedAt` is the row the card was drawn for. */
  letGo: (ask: Ask, raisedAt: number) => Promise<string | undefined>;
  remind: (ask: Ask, raisedAt: number) => Promise<string | undefined>;
  /** The person's own words, sent to the chat that asked. */
  reply: (ask: Ask, raisedAt: number, words: string) => Promise<string | undefined>;
  now: number;
};

const DAY = 24 * 60 * 60 * 1000;
const QUOTE_MAX = 90;
const FALLBACK_NAME = "The first mate";

/** The ask's own words, cut on a word with a mark that it was cut. */
function shortQuote(quote: string): string {
  const flat = quote.replace(/\s+/g, " ").trim();
  if (flat.length <= QUOTE_MAX) return flat;
  const cut = flat.slice(0, QUOTE_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > 50 ? cut.slice(0, space) : cut).trimEnd().replace(/[.,;:!?]+$/, "")}…`;
}

/** "Tuesday" for the last week, else "5 Nov" (with the year when it is not this one). */
export function sinceWhen(at: number, now: number): string {
  const day = new Date(at);
  if (Number.isNaN(day.getTime())) return "a while ago";
  if (Math.abs(now - at) < 7 * DAY) return day.toLocaleDateString("en-GB", { weekday: "long" });
  const sameYear = day.getFullYear() === new Date(now).getFullYear();
  return day.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

export function quietAskFacts(asks: readonly Ask[], deps: QuietAskDeps): AskFact[] {
  const facts: AskFact[] = [];
  for (const ask of asks) {
    const raisedAt = chaseOf(ask)?.raisedAt;
    if (raisedAt === undefined) continue;
    const mate = deps.mate(ask);
    const name = mate?.name?.trim() || FALLBACK_NAME;
    const remind = remindLabel(name);
    const choices = [ANSWER_IT, LET_IT_GO, ...(mate ? [remind] : [])];
    facts.push({
      id: ask.id,
      projectId: mate?.projectId,
      monoId: mate ? ask.mateId : undefined,
      who: name,
      at: ask.createdAt,
      sentence: `You asked: ${shortQuote(ask.quote)}`,
      detail: `Still open since ${sinceWhen(ask.createdAt, deps.now)}. ${name} ${ask.status === "waiting" ? "is waiting on you." : "hasn't moved it."}`,
      open: { where: "chat", id: ask.sessionId },
      onOpen: () => deps.jump(ask),
      choices,
      outcomes: {
        [ANSWER_IT]: null,
        [LET_IT_GO]: "Let go. It is off your list.",
        ...(mate ? { [remind]: `Reminded ${name}.` } : {}),
      },
      // The three answers are the card's choices; anything else typed in the box is the person's own words to the chat.
      answer: async (words: string) => {
        if (words === ANSWER_IT) {
          deps.jump(ask);
          return undefined;
        }
        if (words === LET_IT_GO) return deps.letGo(ask, raisedAt);
        if (mate && words === remind) return deps.remind(ask, raisedAt);
        return deps.reply(ask, raisedAt, words);
      },
    });
  }
  return facts;
}
