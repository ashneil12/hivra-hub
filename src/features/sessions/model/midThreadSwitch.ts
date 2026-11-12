import { dropContextWindow } from "./contextUsage";
import { buildDeterministicHandoff, planComposerSwitch } from "./handoff";
import { limitSection } from "../../../shared/lib/jsonText";
import { resolveModel } from "./models";
import {
  formatSessionTitle,
  HARNESS_LABEL,
  HARNESS_TITLE,
  sessionDisplayTitle,
  type Block,
  type HarnessId,
  type PendingHarnessSwitch,
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
  /** An app-written user message; `sessions.read` does not count it as a turn. */
  internal?: true;
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
    messages.push({ id: block.id, role: block.role, text: block.text, ...(block.internal ? { internal: true as const } : {}) });
  }
  return messages;
}

/** The hand-over is capped so a long chat cannot overflow the target's context. */
export const PORTABLE_TRANSCRIPT_LIMIT = 24_000;

/** At most this many left-out messages are named one by one; the rest are counted. */
export const LEFT_OUT_POINTER_LIMIT = 40;
const POINTER_PREVIEW_CHARS = 80;

/**
 * Build the hand-over at send time from the thread as it is then.
 *
 * WP-251, after Up.computer's portable handoff (docs/user/portable-handoffs.md, MIT, github.com/krl-gr/upcomputer):
 * when the thread does not fit, the person's first message is kept (cut to a quarter of the budget at most), then the
 * newest messages that fit, in their order. The messages in between are named by role, id and their first words, and
 * when the chat id is known the agent is told how to read them with `app sessions.read`. Short threads are unchanged.
 */
export function buildPortableTranscript(
  blocks: readonly Block[],
  messageIds?: readonly string[] | null,
  maxChars: number = PORTABLE_TRANSCRIPT_LIMIT,
  chatId?: string,
): string {
  const messages = selectedMessages(blocks, messageIds);
  const rendered = messages.map((message) => renderTranscript([message]));
  if (joinedLength(rendered) <= maxChars) return rendered.join("\n\n");

  const firstUser = messages.findIndex((message) => message.role === "user");
  const head = firstUser >= 0 ? limitSection(rendered[firstUser]!, Math.floor(maxChars / 4)) : "";
  const room = Math.max(0, maxChars - head.length - (head ? 2 : 0));

  // Take the newest messages that fit beside the first ask, then drop the oldest kept one until the marker naming
  // what was left out (its real length, ids and all) fits too.
  const kept: number[] = [];
  let size = 0;
  for (let index = rendered.length - 1; index > firstUser; index -= 1) {
    const entry = rendered[index]!;
    const separator = kept.length > 0 ? 2 : 0;
    if (size + separator + entry.length > room) break;
    kept.unshift(index);
    size += separator + entry.length;
  }
  const assemble = () => {
    const keptStart = kept.length > 0 ? kept[0]! : rendered.length;
    const leftOut = messages.filter((_, index) => index !== firstUser && index < keptStart);
    const body = kept.map((index) => rendered[index]!).join("\n\n");
    if (leftOut.length === 0) return joinParts(head, "", body);
    const keptMessages = kept.map((index) => messages[index]!);
    return joinParts(head, leftOutMarker(leftOut, keptMessages, chatId), body);
  };
  let text = assemble();
  while (text.length > maxChars && kept.length > 0) {
    kept.shift();
    text = assemble();
  }
  if (kept.length > 0) return text;

  // Nothing new fits beside the first ask: keep today's rule, the newest message cut to what is left.
  if (firstUser < rendered.length - 1) {
    const last = rendered.length - 1;
    const leftOut = messages.filter((_, index) => index !== firstUser && index !== last);
    const marker = leftOutMarker(leftOut, [messages[last]!], chatId);
    const tail = limitSection(rendered[last]!, Math.max(200, room - marker.length - 2));
    return joinParts(head, marker, tail);
  }
  return text;
}

function joinedLength(parts: readonly string[]): number {
  return parts.reduce((sum, part, index) => sum + part.length + (index > 0 ? 2 : 0), 0);
}

function joinParts(...parts: string[]): string {
  return parts.filter((part) => part.length > 0).join("\n\n");
}

function leftOutMarker(
  leftOut: readonly PortableMessage[],
  kept: readonly PortableMessage[],
  chatId: string | undefined,
): string {
  const count = leftOut.length;
  const lines = [`[${count} earlier message${count === 1 ? "" : "s"} left out to fit]`];
  const named = leftOut.slice(-LEFT_OUT_POINTER_LIMIT);
  if (named.length < count) lines.push(`(the ${count - named.length} oldest are not listed)`);
  for (const message of named) {
    const preview = message.text.replace(/\s+/g, " ").trim();
    const short = preview.length > POINTER_PREVIEW_CHARS ? `${preview.slice(0, POINTER_PREVIEW_CHARS - 3)}...` : preview;
    lines.push(`- ${message.role === "user" ? "User" : "Assistant"} ${message.id}: ${short}`);
  }
  if (chatId) {
    // `before` must be a turn sessions.read knows: a user message the app did not write.
    const turn = kept.find((message) => message.role === "user" && !message.internal);
    const before = turn ? `, before: "${turn.id}"` : "";
    lines.push(
      `To look further back, call the app tool sessions.read with sessionId: "${chatId}"${before}. Each call gives three exchanges, each the user's message and the last reply, cut short; pass the oldest turnId you got as before to go further back.`,
    );
  }
  return lines.join("\n");
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

export function switchMarkerLabel(from: SwitchTarget, to: SwitchTarget): string {
  if (from.harness !== to.harness) return `Switched to ${HARNESS_TITLE[to.harness]}`;
  return `Switched to ${modelLabel(to)}`;
}

/** The prompt for a harness that can start from the portable transcript. The new request stays outside it. */
export function wrapPortableResume(
  transcript: string,
  from: HarnessId,
  userText: string,
  earlierRequests: string[] = [],
): string {
  const request = userText.trim();
  const earlier = earlierRequests.map((text) => text.trim()).filter(Boolean);
  const earlierBlock =
    earlier.length > 0
      ? `\n\nAfter the switch, before this message, the user also sent:\n\n${earlier.join("\n\n")}`
      : "";
  const lead = `You are continuing this same chat. It was on ${HARNESS_TITLE[from]}. This is not a new task. Do not say you have no prior context.\n\n${request}${earlierBlock}`;
  const body = transcript.trim();
  if (!body) {
    return `${lead}\n\nThis chat has no earlier messages. Do not invent prior work.`;
  }
  return `${lead}\n\nThe thread so far, in order. Tool calls, reasoning and attachments are not included:\n\n<thread>\n${body}\n</thread>`;
}

export type ThreadSeen = {
  blocks: number;
  harness: HarnessId;
  model: string;
};

/** A session store. `compareAndPut` writes only when the thread still matches `seen`. */
export type ThreadPort = {
  get(threadId: string): Session | undefined;
  compareAndPut(session: Session, seen: ThreadSeen): boolean;
};

export type SwitchRequest = SwitchTarget & {
  modelSettings: Record<string, string>;
};

export type SwitchOutcome = {
  session: Session;
  plan: PortableHandoff;
  /** An empty thread dropped its previous harness child. The caller forgets it. */
  forget?: HarnessId;
};

export type CommitResult =
  | { kind: "missing" }
  | { kind: "conflict" }
  | { kind: "ok"; outcome: SwitchOutcome };

type Origin = {
  from: HarnessId;
  fromModel: string;
  fromSettings: Record<string, string>;
  fromProviderSessionId?: string;
  fromProviderAccountId?: string;
};

function hasUser(session: Session): boolean {
  return session.blocks.some((block) => block.role === "user");
}

function originOf(session: Session): Origin {
  if (session.portableResume) {
    const saved = session.portableResume;
    return {
      from: saved.from,
      fromModel: saved.fromModel,
      fromSettings: saved.fromSettings,
      ...(saved.fromProviderSessionId
        ? { fromProviderSessionId: saved.fromProviderSessionId }
        : {}),
      ...(saved.fromProviderAccountId
        ? { fromProviderAccountId: saved.fromProviderAccountId }
        : {}),
    };
  }
  if (session.pendingSwitch) {
    const saved = session.pendingSwitch;
    return {
      from: saved.from,
      fromModel: saved.fromModel,
      fromSettings: saved.fromSettings,
      ...(saved.fromProviderSessionId
        ? { fromProviderSessionId: saved.fromProviderSessionId }
        : {}),
      ...(saved.fromProviderAccountId
        ? { fromProviderAccountId: saved.fromProviderAccountId }
        : {}),
    };
  }
  return {
    from: session.harness,
    fromModel: session.model,
    fromSettings: session.modelSettings,
    ...(session.providerSessionId
      ? { fromProviderSessionId: session.providerSessionId }
      : {}),
    ...(session.providerAccountId
      ? { fromProviderAccountId: session.providerAccountId }
      : {}),
  };
}

function withChoice(session: Session, target: SwitchRequest): Session {
  const harnessChanged = session.harness !== target.harness;
  const modelChanged = session.model !== target.model;
  return {
    ...session,
    harness: target.harness,
    model: target.model,
    modelSettings: target.modelSettings,
    title:
      session.blocks.length === 0
        ? HARNESS_LABEL[target.harness]
        : formatSessionTitle(
            target.harness,
            sessionDisplayTitle(session.title, session.harness),
          ),
    ...(modelChanged ? { context: dropContextWindow(session.context) } : {}),
    ...(harnessChanged
      ? { providerSessionId: undefined, providerAccountId: undefined }
      : {}),
  };
}

function withoutUnsentMarker(session: Session, markerId: string | undefined): Session {
  if (!markerId) return session;
  const index = session.blocks.findIndex((block) => block.id === markerId);
  if (index < 0) return session;
  const sent = session.blocks
    .slice(index + 1)
    .some((block) => block.role === "user");
  if (sent) return session;
  return {
    ...session,
    blocks: session.blocks.filter((block) => block.id !== markerId),
  };
}

function withMarker(
  session: Session,
  from: SwitchTarget,
  to: SwitchTarget,
): { session: Session; markerId: string } {
  const markerId = crypto.randomUUID();
  const label = switchMarkerLabel(from, to);
  const block: Block = {
    id: markerId,
    role: "handoff",
    text: label,
    handoff: {
      from: from.harness,
      to: to.harness,
      status: "ready",
      switchTo: { harness: to.harness, model: to.model, label },
    },
  };
  return {
    markerId,
    session: { ...session, blocks: [...session.blocks, block] },
  };
}

function clearSwitch(session: Session): Session {
  return {
    ...session,
    pendingSwitch: undefined,
    portableResume: undefined,
    midThread: undefined,
  };
}

function restored(session: Session, origin: Origin, target: SwitchRequest): Session {
  const base = clearSwitch(
    withChoice(withoutUnsentMarker(session, session.portableResume?.markerId), {
      ...target,
      harness: origin.from,
      model: target.harness === origin.from ? target.model : origin.fromModel,
      modelSettings:
        target.harness === origin.from && target.model === origin.fromModel
          ? origin.fromSettings
          : target.modelSettings,
    }),
  );
  return {
    ...base,
    ...(origin.fromProviderSessionId
      ? { providerSessionId: origin.fromProviderSessionId }
      : { providerSessionId: undefined }),
    ...(origin.fromProviderAccountId
      ? { providerAccountId: origin.fromProviderAccountId }
      : { providerAccountId: undefined }),
  };
}

function armPending(session: Session, origin: Origin): PendingHarnessSwitch {
  return {
    from: origin.from,
    fromModel: origin.fromModel,
    fromSettings: origin.fromSettings,
    ...(session.usageLimit ? { skipOutgoingRecap: true } : {}),
    ...(origin.fromProviderSessionId
      ? { fromProviderSessionId: origin.fromProviderSessionId }
      : {}),
    ...(origin.fromProviderAccountId
      ? { fromProviderAccountId: origin.fromProviderAccountId }
      : {}),
  };
}

/**
 * The next session for a picker change. The thread id never changes. A target
 * that can resume keeps a portable transcript for the next send. A target that
 * cannot resume arms today's recap (`pendingSwitch`) and is labelled as a new chat.
 */
export function applyMidThreadSwitch(
  session: Session,
  target: SwitchRequest,
  options?: {
    messageIds?: readonly string[] | null;
    canResume?: (harness: HarnessId) => boolean;
  },
): SwitchOutcome {
  const canResume = options?.canResume ?? harnessCanResumePortable;
  const planFor = (allow: boolean) =>
    planPortableHandoff(
      session,
      target,
      options?.messageIds,
      allow ? () => true : () => false,
    );

  if (
    !hasUser(session) &&
    !session.pendingSwitch &&
    !session.portableResume
  ) {
    return {
      session: clearSwitch(withChoice(session, target)),
      plan: planPortableHandoff(session, target, options?.messageIds, canResume),
      ...(session.harness === target.harness
        ? {}
        : { forget: session.harness }),
    };
  }

  const origin = originOf(session);
  if (target.harness === origin.from && (session.pendingSwitch || session.portableResume)) {
    const back = restored(session, origin, target);
    if (target.model === origin.fromModel) {
      return { session: back, plan: planFor(true) };
    }
    const marked = withMarker(back, { harness: origin.from, model: origin.fromModel }, target);
    return {
      session: {
        ...marked.session,
        midThread: { kind: "resume", line: continueThisChatLine(target, origin.from) },
      },
      plan: planFor(true),
    };
  }

  if (
    session.harness === target.harness &&
    session.model === target.model &&
    !session.pendingSwitch &&
    !session.portableResume
  ) {
    return { session, plan: planFor(canResume(target.harness)) };
  }

  const crossProvider = target.harness !== origin.from;
  if (crossProvider && !canResume(target.harness)) {
    const composer = session.portableResume || session.pendingSwitch
      ? { kind: "arm" as const, pending: armPending(session, origin) }
      : planComposerSwitch(session, target.harness);
    let next = clearSwitch(
      withChoice(withoutUnsentMarker(session, session.portableResume?.markerId), target),
    );
    if (composer.kind === "arm") {
      next = {
        ...next,
        pendingSwitch: composer.pending,
        midThread: { kind: "recap", line: recapNewChatLine(target.harness) },
      };
    } else if (composer.kind === "revert") {
      next = {
        ...next,
        ...(composer.restoreProviderSessionId
          ? { providerSessionId: composer.restoreProviderSessionId }
          : { providerSessionId: undefined }),
        ...(composer.restoreProviderAccountId
          ? { providerAccountId: composer.restoreProviderAccountId }
          : { providerAccountId: undefined }),
      };
    }
    return {
      session: next,
      plan: planFor(false),
      ...(composer.kind === "empty" ? { forget: composer.forget } : {}),
    };
  }

  let next = clearSwitch(
    withChoice(withoutUnsentMarker(session, session.portableResume?.markerId), target),
  );
  const fromNow: SwitchTarget = { harness: session.harness, model: session.model };
  const moved = fromNow.harness !== target.harness || fromNow.model !== target.model;
  let markerId = "";
  if (hasUser(session) && moved) {
    const marked = withMarker(next, fromNow, target);
    next = marked.session;
    markerId = marked.markerId;
  }
  const nativeContinue = origin.from === target.harness && !session.pendingSwitch && !session.portableResume;
  if (!nativeContinue && origin.from !== target.harness) {
    const seeded = planPortableHandoff(
      withoutUnsentMarker(session, session.portableResume?.markerId),
      target,
      options?.messageIds,
      () => true,
    );
    next = {
      ...next,
      portableResume: {
        ...origin,
        transcript: seeded.kind === "resume" ? seeded.transcript : "",
        ...(options?.messageIds ? { messageIds: [...options.messageIds] } : {}),
        markerId,
      },
      midThread: {
        kind: "resume",
        line: continueThisChatLine(target, origin.from),
      },
    };
  } else if (moved) {
    next = {
      ...next,
      midThread: {
        kind: "resume",
        line: continueThisChatLine(target, origin.from),
      },
    };
  }
  return { session: next, plan: planFor(true) };
}

export function commitMidThreadSwitch(
  port: ThreadPort,
  threadId: string,
  target: SwitchRequest,
  options?: {
    messageIds?: readonly string[] | null;
    canResume?: (harness: HarnessId) => boolean;
  },
): CommitResult {
  const current = port.get(threadId);
  if (!current || current.id !== threadId) return { kind: "missing" };
  const seen: ThreadSeen = {
    blocks: current.blocks.length,
    harness: current.harness,
    model: current.model,
  };
  const outcome = applyMidThreadSwitch(current, target, options);
  if (outcome.session === current) return { kind: "ok", outcome };
  if (!port.compareAndPut(outcome.session, seen)) return { kind: "conflict" };
  return { kind: "ok", outcome };
}

/**
 * Put a resume back when the send that took it never reached the provider.
 * A newer switch, or a thread that has already moved on, is left alone.
 */
export function restoreUnsentPortableResume(
  session: Session,
  resume: Session["portableResume"],
  notice: Session["midThread"],
  target: SwitchTarget,
): Session {
  if (!resume) return session;
  if (session.portableResume || session.pendingSwitch) return session;
  if (session.harness !== target.harness || session.model !== target.model) return session;
  return {
    ...session,
    portableResume: resume,
    midThread: notice,
  };
}
