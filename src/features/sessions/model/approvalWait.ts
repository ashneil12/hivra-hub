// Ash writes to a chat that is held on a permission card ("anything stuck?", S14 on Grok): the agent can't read his
// message until he decides, so it sat unanswered for 10 minutes. The app answers for it at once, in one plain line
// that names what it is waiting to run and where to say yes or no.
import type { Block } from "./session";
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
  return "go on";
}

/** The line the app adds when Ash writes to a chat held on his OK; null when nothing waits on him. */
export function waitingOnYouLine(blocks: readonly Block[]): string | null {
  const held = blocks.filter(needsApproval);
  if (!held.length) return null;
  const first = heldCall(held[held.length - 1]!);
  const more = held.length > 1 ? ` (and ${held.length - 1} more)` : "";
  return `Waiting for approval to ${first}${more}. Your message waits until you allow or deny it.`;
}
