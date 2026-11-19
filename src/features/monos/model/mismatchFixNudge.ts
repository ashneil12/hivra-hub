// r85 (c02 r84 run 3, +129s and +281s: "the README describes { ok: true, version } while the route actually returns
// { alive: true }, so that part is not done", then "Not fixed: the README still describes health as ..."): the Lead saw
// the mismatch, said so twice and handed nothing out. A Lead or coding-team turn that is over, names a mismatch or a
// Not fixed piece, and neither started a worker nor asked Ash gets one app message: hand the fix to a worker now, or, if
// it is Ash's call, ask him in one Needs Ash line with its pick. Once per reply, never on its own nudge's turn.
import { forUser } from "../../hub/model/userName";
import { delegateToolFailed, handsOutWork } from "../../sessions/model/monocodeToolCall";
import type { Block, QueuedMessage, Session } from "../../sessions/model/session";

export const FIX_MISMATCH_PREFIX = "[MonoCode fix mismatch]";

/** A sentence naming two things that disagree, or a piece left not done. */
const FLAGS =
  /^\s*Not (?:fixed|done)\s*:|\b(?:do(?:es)?(?: not|n['’]t) match|mismatch(?:es|ed)?|disagrees?|differs? from|out of (?:sync|step) with)\b|\bwhile (?:the |its |it )?\S+(?: \S+){0,3} actually\b|\b(?:so )?(?:that|this) (?:part )?is(?: still)? not (?:done|right|fixed)\b|\bnot what (?:the |it |he |Ash )?\S+ (?:returns|does|says|asked)\b/i;
/** It already says it is fixing it, or that it is fine as it is. */
const SETTLED =
  /\b(?:sent|handed|handing|sending|started|starting|delegat\w*|fixing|being fixed|now fixed|fixed it|on it|intended|on purpose|as (?:you|Ash|he) asked)\b/i;
const NEEDS_ASH = /\bNeeds? (?:Ash|you|the user)\s*:|\bWaiting on you\s*:/i;

/** The first mismatch or Not fixed line a reply names, if any. */
export function mismatchFlagged(reply: string): string | undefined {
  for (const raw of reply.split(/(?<=[.!?])\s+(?=[A-Z])|\n+|\s+\/\s+/)) {
    const line = raw.replace(/^[\s>*#-]+/, "").trim();
    if (!line || !FLAGS.test(line) || SETTLED.test(line)) continue;
    return line.length > 200 ? `${line.slice(0, 197)}…` : line;
  }
  return undefined;
}

/** The app message a Lead or coding-team chat gets now, if any. `nudged` holds the replies already nudged on. */
export function mismatchFixNudge(chat: Session, nudged: ReadonlySet<string>): QueuedMessage | undefined {
  if (chat.busy || chat.queuedMessages?.length) return undefined;
  let start = chat.blocks.length - 1;
  for (; start >= 0; start--) {
    const block = chat.blocks[start];
    // Ash's message or an app turn (a worker's report, a roll-up prompt): the turn the reply answers.
    if (block.role === "user" && !block.draft) break;
  }
  if (start < 0 || chat.blocks[start].text.trimStart().startsWith(FIX_MISMATCH_PREFIX)) return undefined;
  const turn = chat.blocks.slice(start + 1);
  const replies = turn.filter((b: Block) => b.role === "assistant" && !b.tool && !b.internal && b.text.trim());
  const last = replies[replies.length - 1];
  if (!last || nudged.has(last.id)) return undefined;
  if (turn.some((b) => handsOutWork(b) && !delegateToolFailed(b))) return undefined;
  const reply = replies.map((b) => b.text).join("\n");
  if (NEEDS_ASH.test(reply)) return undefined;
  const flagged = mismatchFlagged(reply);
  if (!flagged) return undefined;
  return {
    id: `fix-mismatch-${last.id}`,
    attachments: [],
    waitForIdle: true,
    text: forUser`${FIX_MISMATCH_PREFIX} From the app: your last reply flagged "${flagged}" and handed nothing out. For each mismatch or Not fixed piece: if the fix is clear from Ash's words, start a worker on it now (delegate_task with intent: Ash's words for it, a short brief: what to change to match what, and goal: the check that proves it). If it is Ash's call, ask him in one "Needs Ash:" line with your pick. Then one line to him on what is out. This is an app notification, not a new message from Ash.`,
  };
}
