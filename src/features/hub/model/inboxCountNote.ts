// r101 (2, B5 842b: "2 waiting on you" while his Inbox card showed 3 decisions; 8: the recap pasted the decisions
// again). When Ash asks a Lead how things stand, the app adds, on the wire only, the live count of this chat's asks on
// his Inbox with their short names, so the count line's "waiting on you" is that number and the recap points to them
// in one line instead of relisting options or picks.
import { isStatusQuestion } from "../../monos/model/statusReply";
import { openRows, waitingChats, type WaitingChat } from "./waitingChats";

export const INBOX_COUNT_PREFIX = "[MonoCode inbox count]";

/** "wat happened to the stuff i dumped", "where are we", "hows it going": a question about how things stand. */
export function asksHowThingsStand(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 200 || t.startsWith("[MonoCode")) return false;
  return isStatusQuestion(t) || /\bw(?:h)?at\s+(?:happened|happend)\b|\bwhere\s+(?:are|r)\s+we\b|\bwhat'?s\s+(?:left|open|done)\b/i.test(t);
}

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
  return chats
    .filter((chat) => chat.sessionId === sessionId)
    .flatMap((chat) => {
      const rows = openRows(chat);
      return rows.length ? rows.map((row) => row.question) : [chat.question];
    });
}

export function inboxCountLine(asks: readonly string[]): string {
  const n = asks.length;
  const names = asks.map(shortName).join("; ");
  return n
    ? `${INBOX_COUNT_PREFIX} From the app, not Ash: his Inbox's Waiting on you holds ${n} ask${n === 1 ? "" : "s"} from you right now: ${names}. In your count line, "waiting on you" is exactly ${n}. Point to them in one line with short names only ("${n} decision${n === 1 ? " is" : "s are"} waiting for you in the Inbox: …"); never list their options or picks again.`
    : `${INBOX_COUNT_PREFIX} From the app, not Ash: his Inbox holds no asks from you right now, so leave "waiting on you" out of your count line.`;
}

/** The wire text for one turn: Ash's status question gets the live Inbox count after it; anything else is unchanged. */
export function withInboxCount(sessionId: string, text: string, isLead: (sessionId: string) => boolean, chats?: readonly WaitingChat[]): string {
  if (!isLead(sessionId) || !asksHowThingsStand(text)) return text;
  return `${text}\n\n${inboxCountLine(inboxAsksOf(sessionId, chats))}`;
}
