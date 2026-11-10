// Ash writes to a chat that is held on a permission card ("anything stuck?", S14 on Grok): the agent can't read his
// message until he decides, so it sat unanswered for 10 minutes. The app answers for it at once, in one plain line
// that names what it is waiting to run and where to say yes or no.
import { parksForApproval, sinceLastUserMessage } from "./approvalCarry";
import type { Block, Session } from "./session";
import { needsApproval } from "./transcriptActivity";

const MAX_COMMAND = 120;

function shorten(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MAX_COMMAND ? `${line.slice(0, MAX_COMMAND - 1)}…` : line;
}

/** What the held call wants, in a few words: its command, its file, or the tool's name. */
function heldCall(block: Block): string {
  const call = block.approval?.call;
  if (call?.command) return `run \`${shorten(call.command)}\``;
  if (call?.paths?.length) return `use ${call.tool} on ${call.paths.map(shorten).join(", ")}`;
  if (call?.tool) return `use ${call.tool}`;
  if (block.tool?.title) return `do this: ${shorten(block.tool.title)}`;
  if (block.text.trim()) return `do this: ${shorten(block.text)}`;
  return "go on";
}

/** Every card still open, wherever it sits (the gate counts the same), and a record-less one since his last message. */
function heldCards(blocks: readonly Block[]): Block[] {
  const stretch = new Set(sinceLastUserMessage(blocks));
  return blocks.filter(
    (block) => needsApproval(block) || (block.role === "approval" && !block.approval && stretch.has(block)),
  );
}

/** The line the app adds when Ash writes to a chat held on his OK; null when nothing waits on him. */
export function waitingOnYouLine(blocks: readonly Block[]): string | null {
  const held = heldCards(blocks);
  if (!held.length) return null;
  const first = heldCall(held[held.length - 1]!);
  const more = held.length > 1 ? ` (and ${held.length - 1} more)` : "";
  return `Waiting for approval to ${first}${more}. Your message waits until you allow or deny it on the card above.`;
}

/** What the send path knows about who sent the message. */
export type HeldLineSender = {
  /** A CLI or app request. */
  appRequestId?: string;
  /** A room or another Mono. */
  monoNote?: unknown;
  /** The app's own completion report. */
  monoSessionCompletion?: unknown;
  /** A message already waiting in the queue. Ash's Steer button sends it again. */
  queuedMessageId?: string;
};

/**
 * The line to say when a message is sent to this busy chat, or null when the message goes in now or nothing waits.
 * Ash's own message says it, a new one or the Steer button on one already waiting (queuedMessageId does not exempt
 * it): either way he is told why it did not go in. A message the app sends for itself (an app request, a room note,
 * a completion report) does not.
 */
export function heldLineForSend(
  session: Pick<Session, "busy" | "blocks" | "backgroundTasks">,
  sender: HeldLineSender = {},
): string | null {
  if (sender.appRequestId || sender.monoNote || sender.monoSessionCompletion) return null;
  if (!parksForApproval(session)) return null;
  return waitingOnYouLine(session.blocks);
}
