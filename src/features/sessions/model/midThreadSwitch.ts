import { buildDeterministicHandoff } from "./handoff";
import { resolveModel } from "./models";
import {
  HARNESS_TITLE,
  type Block,
  type HarnessId,
  type Session,
} from "./session";

/**
 * Portable mid-thread switch. The shape follows T3 Code's portable handoff
 * (docs/user/portable-handoffs.md at e85e009): selected messages keep their
 * full text, order and role. Reasoning, tool state and attachments stay out.
 * A harness that cannot take that transcript gets today's recap instead, and
 * a reason, so the UI does not pretend the chat resumed.
 */

export type SwitchTarget = {
  harness: HarnessId;
  model: string;
};

export type PortableMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type PortableHandoff =
  | {
      kind: "resume";
      threadId: string;
      from: SwitchTarget;
      to: SwitchTarget;
      messages: PortableMessage[];
      transcript: string;
    }
  | {
      kind: "recap";
      threadId: string;
      from: SwitchTarget;
      to: SwitchTarget;
      /** Today's deterministic recap, not a shortened copy of the transcript. */
      recap: string;
      reason: string;
    };

/**
 * fx and devin keep a provider-native session Hivra cannot seed with another
 * chat's transcript. Switching to either of them is a recap, and the UI says
 * why. Every other harness here accepts a normal text turn, so it can start
 * from the transcript inside the same thread.
 */
const CANNOT_RESUME: ReadonlySet<HarnessId> = new Set(["fx", "devin"]);

export function harnessCanResumePortable(harness: HarnessId): boolean {
  return !CANNOT_RESUME.has(harness);
}

export function refuseResumeReason(harness: HarnessId): string {
  return `${HARNESS_TITLE[harness]} cannot resume this chat.`;
}

export function continueThisChatLine(
  target: SwitchTarget,
  fromHarness?: HarnessId,
): string {
  const who =
    fromHarness && fromHarness !== target.harness
      ? HARNESS_TITLE[target.harness]
      : modelLabel(target);
  return `Continue this chat with ${who}`;
}

export function recapNewChatLine(harness: HarnessId): string {
  return `Start a new chat with a recap, because ${HARNESS_TITLE[harness]} cannot resume`;
}

export function planPortableHandoff(
  session: Session,
  target: SwitchTarget,
  messageIds?: readonly string[] | null,
  canResume: (harness: HarnessId) => boolean = harnessCanResumePortable,
): PortableHandoff {
  const from: SwitchTarget = { harness: session.harness, model: session.model };
  if (!canResume(target.harness)) {
    return {
      kind: "recap",
      threadId: session.id,
      from,
      to: target,
      recap: buildDeterministicHandoff(session),
      reason: refuseResumeReason(target.harness),
    };
  }
  const messages = selectedMessages(session.blocks, messageIds);
  return {
    kind: "resume",
    threadId: session.id,
    from,
    to: target,
    messages,
    transcript: renderTranscript(messages),
  };
}

function selectedMessages(
  blocks: readonly Block[],
  messageIds?: readonly string[] | null,
): PortableMessage[] {
  const wanted = messageIds == null ? null : new Set(messageIds);
  const seen = new Set<string>();
  const messages: PortableMessage[] = [];
  for (const block of blocks) {
    if (block.role !== "user" && block.role !== "assistant") continue;
    if (!block.text.trim()) continue;
    if (wanted && !wanted.has(block.id)) continue;
    if (seen.has(block.id)) continue;
    seen.add(block.id);
    messages.push({ id: block.id, role: block.role, text: block.text });
  }
  return messages;
}

function renderTranscript(messages: readonly PortableMessage[]): string {
  if (messages.length === 0) return "";
  return messages
    .map((message) => {
      const who = message.role === "user" ? "User" : "Assistant";
      return `${who}:\n${message.text}`;
    })
    .join("\n\n");
}

function modelLabel(target: SwitchTarget): string {
  const name = resolveModel(target.harness, target.model).name.trim();
  return name || target.model;
}
