// The engine has its agents name another conversation by a link of its own (`[EXO lead](t3-thread://v2/<environment>/
// <thread>)`). This app's chat does not open that scheme and showed it as "EXO lead [blocked]". A link to a
// conversation that is a chat here becomes this app's own link to that chat; any other keeps only its name.
import { chatLink } from "../../../../features/sessions/model/threadLinks";

const LINK = /\[([^\]\n]*)\]\(t3-thread:\/\/[^)\s]*\)/g;
const SCHEME = "t3-thread://";

let chatOf: (threadId: string) => string | undefined = () => undefined;

/** Who knows which chat a conversation of the engine belongs to (the engine's watch). */
export function setT3ThreadChats(lookup: (threadId: string) => string | undefined): void {
  chatOf = lookup;
}

function threadOf(link: string): string {
  const last = link.slice(link.lastIndexOf("/") + 1, -1);
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * Where a link that may still be being written starts at the end of the text, or the text's length: "[EXO lead",
 * "[EXO lead](", "[EXO lead](t3-thr". A bracket that has already turned out to be something else is not held.
 */
function unfinishedFrom(text: string): number {
  const open = text.lastIndexOf("[");
  if (open < 0) return text.length;
  const tail = text.slice(open);
  if (tail.includes("\n")) return text.length;
  const close = tail.indexOf("]");
  if (close < 0) return open;
  if (close === tail.length - 1) return open;
  if (tail[close + 1] !== "(") return text.length;
  const url = tail.slice(close + 2);
  if (/[)\s]/.test(url)) return text.length;
  return SCHEME.startsWith(url) || url.startsWith(SCHEME) ? open : text.length;
}

/**
 * An agent's text as the chat shows it. While it is still being written (`complete` false) a link that may be the
 * engine's is held back until it is whole, so what was shown never has to change.
 */
export function t3ShownText(text: string, complete: boolean): string {
  if (!text.includes("[")) return text;
  const whole = complete ? text : text.slice(0, unfinishedFrom(text));
  if (!whole.includes(SCHEME)) return whole;
  return whole.replace(LINK, (link: string, name: string) => {
    const chat = chatOf(threadOf(link));
    const href = chat ? chatLink(chat) : null;
    return href ? `[${name}](${href})` : name;
  });
}
