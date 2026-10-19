import { leafIds, newTab, type WorkspaceTab } from "../../workspace/model/layout";
import type { DockSide, ProjectTerminalDock } from "../../projects/model/projectTerminal";
import { sessionNeedsInput, type Session } from "./session";
import { stopStreaming } from "../../../integrations/harness/core/apply";
import type { ProjectReturnMemory } from "../../projects/model/projectReturn";

export const INTERRUPT_MESSAGE =
  "Turn interrupted when MonoCode quit.";

/** The note on a turn cut by a quit for update (a ship, src-tauri/src/ship.rs). */
export const UPDATE_INTERRUPT_MESSAGE =
  "Turn interrupted when MonoCode Hub restarted for an update.";

export const CONTINUE_PROMPT = "Continue from where you left off.";

export type InFlightRef = {
  sessionId: string;
  cwd: string;
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

/** A turn or approval that would be lost if this webview died. */
export function isInFlightSession(session: Session): boolean {
  return (
    !session.worktreeRemoved && (!!session.busy || sessionNeedsInput(session))
  );
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
    refs.push({ sessionId: session.id, cwd: session.cwd });
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
        text: shipUpdate ? UPDATE_INTERRUPT_MESSAGE : INTERRUPT_MESSAGE,
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
    !!session.providerSessionId &&
    !session.busy &&
    lastBlockIsInterrupt(session)
  );
}

function lastBlockIsInterrupt(session: Session): boolean {
  const last = session.blocks[session.blocks.length - 1];
  return (
    last?.role === "system" &&
    (last.text === INTERRUPT_MESSAGE || last.text === UPDATE_INTERRUPT_MESSAGE)
  );
}

export function inFlightSnapshotKey(refs: InFlightRef[]): string {
  return refs.map((ref) => ref.sessionId).join("\n");
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
