// r101 (2, B5 842b: "2 waiting on you" while his Inbox card showed 3 decisions; 8: the recap pasted the decisions
// again). When Ash asks a Lead how things stand, the app adds, on the wire only, the live count of this chat's asks on
// his Inbox with their short names, so the count line's "waiting on you" is that number and the recap points to them
// in one line instead of relisting options or picks.
import { asksHowThingsStand } from "./statusAsk";
import { openRows, waitingChats, type WaitingChat } from "./waitingChats";

export const INBOX_COUNT_PREFIX = "[MonoCode inbox count]";

export { asksHowThingsStand };

/** A decision's short name: its first few words, without the asking ("May Hivra publish a privacy page" → "Hivra publish a privacy page"). */
export function shortName(question: string): string {
  const words = question
    .replace(/[?.!]+$/, "")
    .replace(/^(?:may|can|should|shall|do you want(?: me)? to|would you like(?: me)? to|which|what|is it ok(?:ay)? to)\s+/i, "")
    .split(/\s+/);
  return words.length > 6 ? `${words.slice(0, 6).join(" ")}…` : words.join(" ");
}

/** The asks from this chat on his Inbox right now, one per open decision row. */
export function inboxAsksOf(sessionId: string, chats: readonly WaitingChat[] = waitingChats()): string[] {
  return asksIn(chats.filter((chat) => chat.sessionId === sessionId));
}

/**
 * r102 (8, 05bc: the recap relisted "Your call, not started: a refunds FAQ, a privacy page …" because those were Chief
 * of Staff's asks, which the r101 note never named): the other open asks on his Inbox, so the Lead points to them too.
 */
export function otherInboxAsks(sessionId: string, chats: readonly WaitingChat[] = waitingChats()): string[] {
  return asksIn(chats.filter((chat) => chat.sessionId !== sessionId));
}

function asksIn(chats: readonly WaitingChat[]): string[] {
  return chats.flatMap((chat) => {
    const rows = openRows(chat);
    return rows.length ? rows.map((row) => row.question) : [chat.question];
  });
}

/**
 * r102 (4, 9, 12): the shape of the answer, sent with every status question so it holds in code, not only in the soul:
 * the count line first, "already there" folded into done, one Inbox line, then short grouped lines, under 15 lines.
 */
export const STATUS_SHAPE =
  'Answer in this shape: the count line first ("Of N: X done, Y running, Z waiting on you, W blocked by your answers, V parked", leaving out an empty bucket; anything that was already there counts as done), worked out from the same groups you list below it; then the one Inbox line; then one short line per group (what it is, in a few words, and why it is parked or held), under 15 lines in all. Plain words only: no internal names for parts of the app, no "the same hold", no ids.';

export function inboxCountLine(asks: readonly string[], others: readonly string[] = []): string {
  const n = asks.length;
  const names = asks.map(shortName).join("; ");
  const theirs = others.length
    ? ` Also on his Inbox from other chats (not yours to count as "waiting on you"): ${others.map(shortName).join("; ")}. Name these in that same Inbox line too.`
    : "";
  const never = " Never relist any of these decisions anywhere else in the reply, not as a group, a list or a sentence.";
  const count = n
    ? `${INBOX_COUNT_PREFIX} From the app, not Ash: his Inbox's Waiting on you holds ${n} ask${n === 1 ? "" : "s"} from you right now: ${names}. In your count line, "waiting on you" is exactly ${n}. Point to them in one line with short names only ("${n} decision${n === 1 ? " is" : "s are"} waiting for you in the Inbox: …"); never list their options or picks again.`
    : `${INBOX_COUNT_PREFIX} From the app, not Ash: his Inbox holds no asks from you right now, so leave "waiting on you" out of your count line.`;
  return `${count}${theirs}${n || others.length ? never : ""} ${STATUS_SHAPE}`;
}

/** The wire text for one turn: Ash's status question gets the live Inbox count after it; anything else is unchanged. */
export function withInboxCount(sessionId: string, text: string, isLead: (sessionId: string) => boolean, chats?: readonly WaitingChat[]): string {
  if (!isLead(sessionId) || !asksHowThingsStand(text)) return text;
  return `${text}\n\n${inboxCountLine(inboxAsksOf(sessionId, chats), otherInboxAsks(sessionId, chats))}`;
}
