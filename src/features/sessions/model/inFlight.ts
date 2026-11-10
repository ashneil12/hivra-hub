import { leafIds, newTab, type WorkspaceTab } from "../../workspace/model/layout";
import type { DockSide, ProjectTerminalDock } from "../../projects/model/projectTerminal";
import { hasPendingApproval, sessionNeedsInput, type Block, type CutWork, type Session } from "./session";
import { stopStreaming } from "../../../integrations/harness/core/apply";
import type { ProjectReturnMemory } from "../../projects/model/projectReturn";

export const INTERRUPT_MESSAGE =
  "Turn interrupted when MonoCode quit.";

/** The note on a turn cut by a quit for update (a ship, src-tauri/src/ship.rs). */
export const UPDATE_INTERRUPT_MESSAGE =
  "Turn interrupted when MonoCode Hub restarted for an update.";

/** The note on a turn cut by a window reload (View > Reload, a vite full reload): the app itself kept running. */
export const RELOAD_INTERRUPT_MESSAGE = "Turn interrupted when MonoCode Hub reloaded.";

export const CONTINUE_PROMPT = "Continue from where you left off.";

/** Before a message sent again because the cut came before the agent had it (`cutBeforeAnyOutput`). */
export const RESEND_NOTE = "MonoCode Hub restarted before this message reached you, so it is sent again:";

/**
 * A turn resumes itself after a restart at most this many times in a row. One that keeps taking the app down (or is
 * cut by restart after restart) then stops and waits in Needs you instead of looping (T3's MAX_CONTINUATION_CHAIN).
 */
export const MAX_AUTO_RESUMES = 3;

/** The note a chat gets when it stopped resuming itself; it shows in Needs you. */
export const RESUME_STOPPED_MESSAGE = `MonoCode Hub restarted ${MAX_AUTO_RESUMES} times while this turn was running, so it stopped resuming it by itself. Check what it was doing, then send a message to carry on.`;

/** The "what was cut" note is bounded so it can't crowd out the turn's own context (T3's RestartBackgroundNote). */
export const CUT_NOTE_MAX_ENTRIES = 10;
export const CUT_NOTE_MAX_LABEL = 160;

export type InFlightRef = {
  sessionId: string;
  cwd: string;
  /** What the turn had running in the background when this was saved. */
  background?: CutWork[];
  /** Automatic resumes this turn has already had (`MAX_AUTO_RESUMES`). */
  resumes?: number;
};

export type ResumedWorkspace = {
  sessions: Session[];
  tabs: WorkspaceTab[];
  activeTabId: string;
  projectCwd: string;
  projectTerminals?: ProjectTerminalDock[];
  projectReturnMemory?: ProjectReturnMemory;
  lastDockSide?: DockSide;
};

/**
 * A real turn is running. A chat the app holds busy for its own background
 * compact (`idleCompacting`) is not one: nothing the person asked for would be
 * lost if it were cut.
 */
export function isTurnRunning(session: Pick<Session, "busy" | "idleCompacting">): boolean {
  return !!session.busy && !session.idleCompacting;
}

/** A turn or approval that would be lost if this webview died. */
export function isInFlightSession(session: Session): boolean {
  return (
    !session.worktreeRemoved && (isTurnRunning(session) || sessionNeedsInput(session))
  );
}

/**
 * r99 (Ash, 30 Oct: "a chat that's only waiting on Ash's answer isn't running"): work a quit would really cut. A turn
 * held open only by its own question to Ash (AskUserQuestion) is not running: Quit doesn't ask about it, and the ask
 * is kept with the in-flight row (`askCut`) and asked again when the app reopens. An approval card still counts.
 */
export function isRunningWork(session: Session): boolean {
  if (session.worktreeRemoved) return false;
  if (session.busy !== false && hasPendingApproval(session.blocks ?? [])) return true;
  return isTurnRunning(session) && session.pendingQuestion == null;
}

/** The open question as a cut-work entry (one line, with its options), so the in-flight row keeps it. */
export function askCut(session: Pick<Session, "pendingQuestion">): CutWork | null {
  const prompt = session.pendingQuestion;
  if (!prompt?.questions?.length) return null;
  const text = prompt.questions
    .map((q) => `${q.prompt.trim()}${q.options.length ? ` [${q.options.map((o) => o.label).join(" / ")}]` : ""}`)
    .join(" ; ");
  return { kind: "ask", id: `ask-${prompt.requestId}`, label: text.slice(0, 380) };
}

export function hasInFlightSessions(sessions: Session[]): boolean {
  return sessions.some(isInFlightSession);
}

/**
 * Busy chats in tab order, then parked ones still running after their tab closed.
 * Only persistable sessions can come back after a real quit.
 */
export function inFlightRefs(
  sessions: Session[],
  tabs: WorkspaceTab[],
): InFlightRef[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const seen = new Set<string>();
  const refs: InFlightRef[] = [];

  const push = (session: Session | undefined) => {
    if (!session || session.inboxAsk || seen.has(session.id)) return;
    if (!isInFlightSession(session) || !canResumeAfterQuit(session)) return;
    seen.add(session.id);
    const ask = askCut(session);
    const background = [...(isTurnRunning(session) ? (session.cutWork ?? []).filter((w) => w.kind !== "ask") : []), ...(ask ? [ask] : [])];
    refs.push({
      sessionId: session.id,
      cwd: session.cwd,
      ...(background.length ? { background } : {}),
      ...(session.autoResumes ? { resumes: session.autoResumes } : {}),
    });
  };

  for (const tab of tabs) {
    for (const id of leafIds(tab.layout)) push(byId.get(id));
  }
  for (const session of sessions) push(session);
  return refs;
}

export function quitWhileBusyMessage(count: number): string {
  if (count === 1) {
    return "1 chat is still running. Quit anyway? It will resume when you reopen MonoCode.";
  }
  return `${count} chats are still running. Quit anyway? They will resume when you reopen MonoCode.`;
}

/**
 * Seal streams/tools and record that a real quit cut the turn short.
 * Idempotent for the current turn only — a later turn after Continue still
 * gets a fresh note. Matching any interrupt in the transcript would skip
 * resume on the second quit.
 *
 * `shipUpdate` names the ship when the quit was for an update: the note says
 * so, and the resume carries that ship's receipt.
 */
export function markTurnInterrupted(
  session: Session,
  shipUpdate?: string,
  /** "reload": the window reloaded (the app kept running), so the note says so. */
  cause?: "reload",
): Session {
  const sealed = { ...sealOpenWork(stopStreaming(session)), busy: false };
  if (lastBlockIsInterrupt(sealed)) return sealed;
  return {
    ...sealed,
    blocks: [
      ...sealed.blocks,
      {
        id: crypto.randomUUID(),
        role: "system",
        text: shipUpdate
          ? UPDATE_INTERRUPT_MESSAGE
          : cause === "reload"
            ? RELOAD_INTERRUPT_MESSAGE
            : INTERRUPT_MESSAGE,
        notice: "interrupt",
        ...(shipUpdate ? { shipUpdate } : {}),
      },
    ],
  };
}

/** The ship whose restart cut this session's last turn, if that's what cut it. */
export function interruptingShip(session: Session): string | null {
  const last = session.blocks[session.blocks.length - 1];
  return lastBlockIsInterrupt(session) ? (last?.shipUpdate ?? null) : null;
}

/** What a ship's receipt says, as the app reports it (`ship_receipt`, src-tauri/src/ship.rs). */
export type ShipNote = {
  id: string;
  phase: string;
  reason?: string | null;
  from?: { sha?: string; branch?: string } | null;
  to?: { sha?: string; branch?: string } | null;
  requestedBy?: { sessionId?: string | null } | null;
  receiptPath?: string;
  log?: string;
};

const buildLabel = (build?: { sha?: string; branch?: string } | null) =>
  build?.sha ? `${build.branch ?? "?"} @ ${build.sha.slice(0, 7)}` : "an unknown build";

/**
 * The resume prompt for a turn a ship's restart cut. The session that asked
 * for the ship gets its receipt; any other just hears what's running now.
 */
export function shipResumePrompt(sessionId: string, note: ShipNote | null): string {
  if (!note) return `MonoCode Hub restarted for an update. ${CONTINUE_PROMPT}`;
  const committed = note.phase === "committed";
  const running = committed ? note.to : note.from;
  const outcome = committed
    ? `It committed: MonoCode Hub now runs ${buildLabel(note.to)} (was ${buildLabel(note.from)}).`
    : note.phase === "rolled-back"
      ? `It was rolled back${note.reason ? ` (${note.reason})` : ""}: MonoCode Hub runs ${buildLabel(running)} again.`
      : `It ended ${note.phase}${note.reason ? ` (${note.reason})` : ""}; MonoCode Hub runs ${buildLabel(running)}.`;
  if (note.requestedBy?.sessionId !== sessionId)
    return `MonoCode Hub restarted for an update. ${outcome} ${CONTINUE_PROMPT}`;
  const files = [
    note.receiptPath ? `receipt ${note.receiptPath}` : null,
    note.log ? `log ${note.log}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return `Your ship ${note.id} finished. ${outcome}${files ? ` Check the ${files}.` : ""} Then ${CONTINUE_PROMPT.charAt(0).toLowerCase()}${CONTINUE_PROMPT.slice(1)}`;
}

export function workspaceFromResumed(
  sessions: Session[],
): ResumedWorkspace | null {
  sessions = sessions.filter((session) => !session.inboxAsk);
  if (sessions.length === 0) return null;
  const tabs = sessions.map((session) => newTab(session.id));
  return {
    sessions,
    tabs,
    activeTabId: tabs[0].id,
    projectCwd: sessions[0].cwd,
  };
}

export function wasTurnInterrupted(session: Session): boolean {
  return lastBlockIsInterrupt(session);
}

/**
 * Provider thread exists and the quit note is still the last block.
 * A Continue (or any later user turn) appends after it, so this stays one-shot.
 */
export function canAutoContinue(session: Session): boolean {
  return (
    !session.worktreeRemoved &&
    // A provider thread to continue, or a message it never got, which goes again whole (a fresh chat cut a moment
    // after Ash wrote has no thread yet: the realtest baseline's Lead, cut 1 s after his message, waited for good).
    (!!session.providerSessionId || cutBeforeAnyOutput(session)) &&
    !session.busy &&
    // A question still on screen is Ash's to answer; resuming would talk over it.
    !session.pendingQuestion &&
    lastBlockIsInterrupt(session)
  );
}

/**
 * Claim one restart's resume of a chat: true the first time for this chat and resume count, false after. The
 * auto-continue effect runs again whenever another chat's resumability changes, and a chat it has just sent Continue
 * to can still read as resumable until that turn is accepted (a worker whose sibling started in a worktree of its own
 * was sent Continue twice, and the second, steered into nothing, failed it). `claimed` lives as long as the window.
 */
export function claimAutoContinue(
  claimed: Set<string>,
  session: Pick<Session, "id" | "autoResumes">,
): boolean {
  const key = `${session.id}:${session.autoResumes ?? 0}`;
  if (claimed.has(key)) return false;
  claimed.add(key);
  return true;
}

/**
 * The message of the turn a restart or reload cut, when the agent had produced nothing for it yet: it may never have
 * reached the agent (the window reloaded a moment after Ash wrote), so "continue" would continue the turn before it.
 * Only a message someone sent (Ash's, or a brief); a hidden app turn (a report, a room wake) keeps the plain continue.
 */
export function cutMessageBeforeOutput(session: Pick<Session, "blocks" | "queuedMessages">): Block | undefined {
  if (!lastBlockIsInterrupt(session)) return undefined;
  const queued = new Set((session.queuedMessages ?? []).map((message) => message.blockId ?? message.id));
  for (let i = session.blocks.length - 2; i >= 0; i -= 1) {
    const block = session.blocks[i];
    if (block.role === "system") continue;
    if (block.role !== "user") return undefined;
    // A bubble still waiting in its queue was never this turn's message.
    if (block.draft || queued.has(block.id)) continue;
    return !block.internal && block.text.trim() ? block : undefined;
  }
  return undefined;
}

export function cutBeforeAnyOutput(session: Pick<Session, "blocks" | "queuedMessages">): boolean {
  return !!cutMessageBeforeOutput(session);
}

/** This turn has resumed itself after restarts as often as it may: it stops and waits for Ash instead. */
export function resumeBlocked(session: Pick<Session, "autoResumes">): boolean {
  return (session.autoResumes ?? 0) >= MAX_AUTO_RESUMES;
}

/**
 * Stop resuming a turn that has been cut by restart after restart: its note replaces the interrupt as the last
 * block, so nothing continues it until Ash sends a message, and the chat reads Needs you.
 */
export function markResumeStopped(session: Session): Session {
  if (resumeStopped(session)) return session;
  const cut = cutWorkLines(session.cutWork ?? []);
  return {
    ...session,
    autoResumes: undefined,
    cutWork: undefined,
    blocks: [
      ...session.blocks,
      {
        id: crypto.randomUUID(),
        role: "system",
        text: cut.length
          ? `${RESUME_STOPPED_MESSAGE}\nIt had this running in the background:\n${cut.join("\n")}`
          : RESUME_STOPPED_MESSAGE,
        notice: "resume-stopped",
      },
    ],
  };
}

/** The chat stopped resuming itself after restarts and is waiting for Ash (its last block says so). */
export function resumeStopped(session: Pick<Session, "blocks">): boolean {
  const last = session.blocks[session.blocks.length - 1];
  return last?.role === "system" && last.notice === "resume-stopped";
}

function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

/** One entry, at most `CUT_NOTE_MAX_LABEL` characters, keeping its id whole whenever it fits. */
export function cutWorkLabel(work: CutWork): string {
  const id = clipText(work.id, CUT_NOTE_MAX_LABEL);
  const suffix = id ? ` (id ${id})` : "";
  const budget = CUT_NOTE_MAX_LABEL - suffix.length;
  if (budget < 2) return clipText(`${work.label}${suffix}`, CUT_NOTE_MAX_LABEL);
  return `${clipText(work.label, budget) || work.kind}${suffix}`;
}

function cutWorkLines(work: CutWork[]): string[] {
  const seen = new Set<string>();
  const unique = work.filter((entry) => {
    const key = entry.id || `${entry.kind}\u0000${entry.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const omitted = unique.length - CUT_NOTE_MAX_ENTRIES;
  return [
    ...unique
      .slice(0, CUT_NOTE_MAX_ENTRIES)
      .map((entry) => `- ${entry.kind}: ${cutWorkLabel(entry)}`),
    ...(omitted > 0 ? [`- and ${omitted} more`] : []),
  ];
}

/**
 * What a restart cut short, for the resumed turn: each subagent, backgrounded shell or monitor with the id to
 * restart it by, bounded to `CUT_NOTE_MAX_ENTRIES` lines. Null when nothing was running in the background.
 */
export function cutWorkNote(work: CutWork[]): string | null {
  // r103 (6, B5 0255: "- task: Which shortcut should open a new chat? … (id ask-1)" in the Lead's thread): Ash's own
  // question is never background work to restart by id, whatever kind it was saved as; the resume asks it again.
  const lines = cutWorkLines(work.filter((entry) => entry.kind !== "ask" && !/^ask-/.test(entry.id)));
  if (!lines.length) return null;
  return [
    "Note: MonoCode Hub restarted while this turn was running, and this background work was cut before it finished. It will not report back on its own, so restart or resume what you still need (by its id) and wait for its result:",
    ...lines,
  ].join("\n");
}

/**
 * The text of an automatic resume: what was cut (if anything), then the ship's receipt when a ship's restart cut it
 * (`shipResumePrompt`), else the plain continue.
 */
export function resumePrompt(
  session: Pick<Session, "id" | "cutWork" | "blocks" | "queuedMessages">,
  ship?: { note: ShipNote | null },
): string {
  // Cut before the agent had the message: it goes again, whole (it carries any what-was-cut note it had itself).
  const unsent = cutMessageBeforeOutput(session);
  if (unsent) {
    // A resend cut again goes once more with one note, not a note inside a note.
    const text = unsent.text.trim();
    return text.startsWith(RESEND_NOTE) ? text : `${RESEND_NOTE}\n\n${text}`;
  }
  const base = ship ? shipResumePrompt(session.id, ship.note) : CONTINUE_PROMPT;
  const note = cutWorkNote(session.cutWork ?? []);
  const asks = (session.cutWork ?? []).filter((entry) => entry.kind === "ask");
  const askNote = asks.length
    ? `Note: MonoCode Hub quit while your question to Ash was open, so its card closed unanswered. Before anything else, ask it again (AskUserQuestion), the same question and options: ${asks.map((a) => a.label).join(" ; ")}`
    : null;
  return [askNote, note, base].filter(Boolean).join("\n\n");
}

/**
 * Bring each restored chat's saved resume state back from its in-flight row: what it had running in the background
 * and how often it has resumed itself already.
 */
export function withInFlightState(
  session: Session,
  ref: InFlightRef | undefined,
): Session {
  if (!ref) return session;
  const background = ref.background ?? [];
  return {
    ...session,
    ...(background.length ? { cutWork: background } : {}),
    ...(ref.resumes ? { autoResumes: ref.resumes } : {}),
  };
}

function lastBlockIsInterrupt(session: Pick<Session, "blocks">): boolean {
  const last = session.blocks[session.blocks.length - 1];
  return (
    last?.role === "system" &&
    (last.text === INTERRUPT_MESSAGE ||
      last.text === UPDATE_INTERRUPT_MESSAGE ||
      last.text === RELOAD_INTERRUPT_MESSAGE)
  );
}

/** Changes whenever a row would be written differently: a chat, its resume count or its background work. */
export function inFlightSnapshotKey(refs: InFlightRef[]): string {
  return refs
    .map((ref) =>
      [
        ref.sessionId,
        ref.resumes ?? 0,
        ...(ref.background ?? []).map((work) => `${work.kind}:${work.id}:${work.label}`),
      ].join("\t"),
    )
    .join("\n");
}

/**
 * Skip the first idle paint after boot so a restored snapshot is not wiped
 * before the turn is marked busy again. Once this process has seen a live
 * in-flight chat, an empty list is a real "turn finished" and should clear.
 */
export function shouldWriteInFlightSnapshot(
  key: string,
  refs: InFlightRef[],
  previousKey: string | null,
  sawInFlight: boolean,
): boolean {
  if (previousKey === key) return false;
  if (refs.length === 0 && !sawInFlight) return false;
  return true;
}

function canResumeAfterQuit(session: Session): boolean {
  return (
    !session.worktreeRemoved &&
    session.cwd !== "~" &&
    session.blocks.some((block) => block.role === "user")
  );
}

function sealOpenWork(session: Session): Session {
  return {
    ...session,
    busy: false,
    blocks: session.blocks.flatMap((block) => {
      if (block.role === "approval" && !block.approval?.decided) return [];
      if (!shouldCancelTool(block)) return [block];
      const { approval, ...rest } = block;
      return [
        {
          ...rest,
          streaming: false,
          tool: block.tool
            ? { ...block.tool, status: "cancelled" }
            : block.tool,
          ...(approval?.decided ? { approval } : {}),
        },
      ];
    }),
  };
}

function shouldCancelTool(block: Session["blocks"][number]): boolean {
  if (block.approval && !block.approval.decided) return true;
  if (!block.tool) return false;
  if (block.streaming) return true;
  const status = block.tool.status?.toLowerCase() ?? "";
  return (
    status === "in_progress" || status === "pending" || status === "running"
  );
}
