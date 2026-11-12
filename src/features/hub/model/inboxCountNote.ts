// r101 (2, B5 842b: "2 waiting on you" while his Inbox card showed 3 decisions; 8: the recap pasted the decisions
// again). When Ash asks a Lead how things stand, the app adds, on the wire only, the live count of this chat's asks on
// his Inbox with their short names, so the count line's "waiting on you" is that number and the recap points to them
// in one line instead of relisting options or picks.
import { needsCount, needsListPublished } from "../../needs/model/needsYou";
import { asksHowThingsStand } from "./statusAsk";
import { CONTINUE_PROMPT } from "../../sessions/model/inFlight";
import { openPartsOf, runningWorkers, statusTruthLine } from "./statusTruth";
import { openRows, waitingChats, type WaitingChat } from "./waitingChats";

export const INBOX_COUNT_PREFIX = "[MonoCode inbox count]";

export { asksHowThingsStand };

/** A decision's short name: its first few words, without the asking ("May Hivra publish a privacy page" → "Hivra publish a privacy page"). */
export function shortName(question: string): string {
  // r103 (B5 4aa9: "a key or secret action only" in the Lead's Inbox line): a question that names its subject before a
  // colon is named by that part, and a name is never cut inside its first ten words.
  const head = question.split(/:\s/)[0]!;
  const words = (head.trim().split(/\s+/).length >= 3 ? head : question)
    .replace(/[?.!]+$/, "")
    .replace(/^(?:may|can|should|shall|do you want(?: me)? to|would you like(?: me)? to|which|what|is it ok(?:ay)? to)\s+/i, "")
    .split(/\s+/);
  return words.length > 10 ? `${words.slice(0, 10).join(" ")}…` : words.join(" ");
}

/** The asks from this chat on his Inbox right now, one per open decision row. */
export function inboxAsksOf(sessionId: string, chats: readonly WaitingChat[] = waitingChats()): string[] {
  return asksIn(chats.filter((chat) => chat.sessionId === sessionId));
}

/**
 * r102 (8, 05bc: the recap relisted asks the count note never named): the other open asks on his Inbox, so the Lead
 * points to them too.
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
  'Answer in this shape: the count line first ("Of N: X done, Y running, Z waiting on you, W blocked by your answers, V parked", leaving out an empty bucket; anything that was already there counts as done, written "X done (2 already there)"), worked out from the same groups you list below it; then the one Inbox line; then one line per item or group, each a whole sentence that says why ("Parked: the settings scroll, because that page needs a real build from the Hub lead."), under 15 lines in all, each line under 45 words (one line per project for what it parks, naming every ask in two or three words, never "and N more"), and never a numbered list of every ask. Count as done only what a worker\'s report or your own earlier reply shows finished; a draft you never showed him is not done. A change sitting in a preview he has not applied is not done: it waits on his Apply, so count it as waiting on you and end with a `Needs Ash:` line for the Apply. "Waiting on you" and "blocked by your answers" count only what is on his Inbox. Anything that needs his yes or his pick is never parked: if it is not on his Inbox yet, end this reply with a `Needs Ash:` line for it and your pick. Never say his Inbox is empty while you count anything as waiting on him. Plain words only: no internal names for parts of the app, no "the same hold", no ids.';

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
  const across = needsListPublished() ? ` Needs you, across every project, is ${needsCount()}.` : "";
  return `${count}${theirs}${across}${n || others.length ? never : ""} ${STATUS_SHAPE}`;
}

/** The wire text for one turn: Ash's status question gets the live Inbox count after it; anything else is unchanged. */
export function withInboxCount(
  sessionId: string,
  text: string,
  isLead: (sessionId: string) => boolean,
  chats?: readonly WaitingChat[],
  /** r103 (3, 4): the Lead's chat and all chats now, so "running" and "done" come from the app. */
  look?: { blocks: Parameters<typeof openPartsOf>[0]; sessions: Parameters<typeof runningWorkers>[1] },
): string {
  if (!isLead(sessionId)) return text;
  // r103 (3): the turn a restart resumes says what runs now, so finished work isn't called "in progress".
  if (look && isRestartResume(text)) return `${text}\n\n${INBOX_COUNT_PREFIX} ${statusTruthLine(runningWorkers(look.blocks, look.sessions), [])}`;
  // r103 (2): a dump gets a short first reply before any work starts.
  if (isDump(text)) return `${text}\n\n${FIRST_REPLY_NOTE}`;
  if (!asksHowThingsStand(text)) return text;
  const truth = look ? ` ${statusTruthLine(runningWorkers(look.blocks, look.sessions), openPartsOf(look.blocks))}` : "";
  return `${text}\n\n${inboxCountLine(inboxAsksOf(sessionId, chats), otherInboxAsks(sessionId, chats))}${truth}`;
}

/** The turn the app sends after a restart cut one: the plain continue, or the cut-work note. */
export function isRestartResume(text: string): boolean {
  const t = text.trim();
  return t === CONTINUE_PROMPT || t.startsWith("Note: MonoCode Hub restarted") || t.endsWith(CONTINUE_PROMPT);
}

/** A message from Ash with four or more things in it (sentences or lines of three words or more): a dump. */
export function isDump(text: string): boolean {
  const t = text.trim();
  if (!t || t.startsWith("[MonoCode") || asksHowThingsStand(t)) return false;
  return t.split(/[.!?\n]+/).filter((part) => part.trim().split(/\s+/).length >= 3).length >= 4;
}

/**
 * r103 (2, B5 0255: Ash's last dump at +63s, the Lead's first word at +257s, then nothing until +1816s): a dump is
 * answered at once, in two short lines, before any tool call; the work and its accounting come after.
 */
export const FIRST_REPLY_NOTE = `${INBOX_COUNT_PREFIX} From the app, not Ash: before any tool call, reply in at most two short, natural lines saying what you're starting first (no count of his asks, no list, no options). Then do the work. Anything in the asks that needs his yes or his pick (posting, money, legal, customer email, a choice between options) is never parked: give it its own "Needs Ash:" line with your pick, so it is a card on his Inbox. When you report back later, talk normally: one short line per group of work, never a tally or a numbered list of his asks.`;
