// A first mate's chat open beside the Chief of Staff's (Ash, 13 Nov: "you could be able to message the first mate from
// that side thing ... making sure that the chief of staff knows that you've messaged the first mate"). A job or a
// project's first mate opens in the panel beside the one chat, where he can read it and type to it without leaving.
// Whatever he sends there leaves a quiet line in the one chat, and the Chief of Staff reads it beside his next message,
// so it never asks the first mate the same thing again or acts as if it didn't happen.
import type { Block } from "../../sessions/model/session";

/** What a message sent beside the one chat leaves in it. Kept on its block, so it reads the same after a relaunch. */
export type BesideMessage = { chatId: string; to: string; text: string; at: number };

const BLOCK_PREFIX = "beside-";
const TEXT_MAX = 600;

let host: ((chatId: string) => boolean) | undefined;

/** The app lends the way to open a chat beside the Chief of Staff's while its chat is the one on screen. */
export function setBesideChatHost(next: ((chatId: string) => boolean) | undefined): () => void {
  host = next;
  return () => {
    if (host === next) host = undefined;
  };
}

/** Open that chat beside the Chief of Staff's. False when its chat isn't on screen, so the caller opens it the usual way. */
export function openBesideChief(chatId: string | undefined): boolean {
  if (!chatId?.trim() || !host) return false;
  try {
    return host(chatId);
  } catch {
    return false;
  }
}

function flat(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= TEXT_MAX ? one : `${one.slice(0, TEXT_MAX - 1).trimEnd()}…`;
}

/** The one chat's line: "You messaged EXO lead: …". */
export function besideLine(message: Pick<BesideMessage, "to" | "text">): string {
  return `You messaged ${message.to}: "${flat(message.text)}"`;
}

export function besideBlock(message: BesideMessage): Block {
  const kept = { ...message, text: flat(message.text) };
  return { id: `${BLOCK_PREFIX}${message.at}`, role: "system", text: besideLine(kept), besideMessage: kept } as Block;
}

/**
 * What the Chief of Staff reads beside Ash's next message: what he sent to its first mates beside this chat since its
 * last reply. Undefined when he sent nothing there.
 */
export function besideNote(blocks: readonly Pick<Block, "role" | "text" | "besideMessage">[]): string | undefined {
  const sent: string[] = [];
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.role === "assistant" && block.text?.trim()) break;
    const message = block.besideMessage;
    if (message) sent.unshift(`- To ${message.to} (chat ${message.chatId}): "${flat(message.text)}"`);
  }
  if (!sent.length) return undefined;
  return [
    "<ash_messaged_directly>",
    "Since your last reply Ash wrote these straight into a first mate's chat, from the panel beside this one. They already have his words: don't pass them on again. Take them into account, and say so if they change what you were doing.",
    ...sent,
    "</ash_messaged_directly>",
  ].join("\n");
}
