// WP-110: a new chat can start in its own worktree. Creation goes through the
// existing worktree function, so a refusal keeps that function's message.
// This module never removes a worktree.
import { gitBranches } from "../../../platform/tauri/fs";
import { isBlankSession } from "../../projects/model/projectReturn";
import { isLocalProject, sameProjectPath } from "../../projects/model/recents";
import {
  loadNewChatWorktree,
  type NewChatWorktree,
} from "../../settings/model/settings";
import type { Session, WorkspaceMode } from "../../sessions/model/session";
import { temporaryWorktreeBranchName, type Worktree } from "./worktrees";

export const NEW_CHAT_WORKTREE_ASK =
  "This new chat will start in its own worktree. Switch to this folder if you want to stay here.";

/** Chats whose person switched back to this folder. In memory, per window. */
const staysHere = new Set<string>();

export type NewChatWorktreeOpen = {
  setting: NewChatWorktree;
  /** False for a chat that continues one, a worker, an inbox ask, or an automation. */
  firstTurn: boolean;
  /** The composer toggle is already on "New worktree". */
  toggleOn: boolean;
  /** The person chose this folder for this chat. */
  declined: boolean;
  cwd: string;
  base: string;
};

export type NewChatWorktreePort = {
  gitOnThisComputer: (cwd: string) => Promise<boolean>;
  createWorktree: (
    cwd: string,
    branch: string,
    base: string,
    existing: boolean,
  ) => Promise<Worktree>;
};

export type NewChatWorktreeConfirmPort = {
  setting: () => NewChatWorktree;
  gitOnThisComputer: (cwd: string) => Promise<boolean>;
  commit: (update: (sessions: Session[]) => Session[] | null) => void;
};

function localFolder(cwd: string): boolean {
  return typeof cwd === "string" && isLocalProject(cwd);
}

function readable(session: Session | undefined): session is Session {
  return !!session && typeof session.cwd === "string" && Array.isArray(session.blocks);
}

/** Remember a switch between this folder and a new worktree for one chat. */
export function noteNewChatFolderChoice(sessionId: string, mode: WorkspaceMode) {
  if (!sessionId) return;
  if (mode === "current") staysHere.add(sessionId);
  else staysHere.delete(sessionId);
}

export function newChatStaysHere(sessionId: string): boolean {
  return staysHere.has(sessionId);
}

/** The folder changed, so the old choice does not apply. */
export function forgetNewChatFolderChoice(sessionId: string) {
  staysHere.delete(sessionId);
}

/** Test hook. A window starts with no remembered choices. */
export function resetNewChatFolderChoices() {
  staysHere.clear();
}

function canOffer(session: Session, cwd: string): boolean {
  if (!readable(session) || !isBlankSession(session)) return false;
  if (session.worktreeCwd || session.worktreeRemoved) return false;
  if (session.providerSessionId) return false;
  if (session.workspaceMode) return false;
  if (session.inboxAsk || session.orchestrationLeadId) return false;
  return sameProjectPath(session.cwd, cwd);
}

/**
 * Switch a new blank chat onto a worktree before the git check returns, so the
 * composer shows that choice at once. Returns null when nothing should change.
 */
export function beginNewChatWorktreeOffer(
  sessions: readonly Session[],
  sessionId: string,
  cwd: string,
  setting: NewChatWorktree,
): Session[] | null {
  if (setting !== "ask" && setting !== "always") return null;
  if (!localFolder(cwd) || newChatStaysHere(sessionId)) return null;
  const session = sessions.find((entry) => entry.id === sessionId);
  if (!session || !canOffer(session, cwd)) return null;
  return sessions.map((entry) =>
    entry.id === sessionId
      ? {
          ...entry,
          workspaceMode: "worktree",
          worktreeBase: entry.worktreeBase || "HEAD",
        }
      : entry,
  );
}

/**
 * Take the offer back when it is still the one we made. A timeout does not
 * come through here: the caller leaves the offer in place when git does not answer.
 */
export function clearUnconfirmedNewChatWorktree(
  sessions: readonly Session[],
  sessionId: string,
  cwd: string,
): Session[] | null {
  const session = sessions.find((entry) => entry.id === sessionId);
  if (!session || session.workspaceMode !== "worktree") return null;
  if (session.worktreeCwd || session.worktreeRemoved) return null;
  if (session.worktreeBase && session.worktreeBase !== "HEAD") return null;
  if (!readable(session) || !isBlankSession(session)) return null;
  if (!sameProjectPath(session.cwd, cwd)) return null;
  if (newChatStaysHere(sessionId)) return null;
  return sessions.map((entry) =>
    entry.id === sessionId
      ? { ...entry, workspaceMode: undefined, worktreeBase: undefined }
      : entry,
  );
}

/** Ask git, then keep or clear the offer. A throw skips this chat and stores nothing. */
export async function confirmNewChatWorktreeOffer(
  sessionId: string,
  cwd: string,
  port: NewChatWorktreeConfirmPort,
): Promise<void> {
  if (!localFolder(cwd)) return;
  if (port.setting() === "off") {
    port.commit((sessions) => clearUnconfirmedNewChatWorktree(sessions, sessionId, cwd));
    return;
  }
  let git = false;
  try {
    git = await port.gitOnThisComputer(cwd);
  } catch {
    return;
  }
  port.commit((sessions) => {
    const setting = port.setting();
    if (git && setting !== "off") return null;
    return clearUnconfirmedNewChatWorktree(sessions, sessionId, cwd);
  });
}

/**
 * True when `git_branches` can see a repository. An empty answer means this
 * folder is not one. A throw is left to the caller, so a timeout is not "not a repo".
 */
export async function gitRepositoryOnThisComputer(cwd: string): Promise<boolean> {
  if (!localFolder(cwd)) return false;
  const listed = await gitBranches(cwd);
  return listed.detached || listed.current !== null || listed.branches.length > 0;
}

/** Apply the setting to a chat that is already in the list. */
export function attachNewChatWorktree(
  sessionId: string,
  cwd: string,
  setSessions: (update: (prev: Session[]) => Session[]) => void,
): void {
  const setting = loadNewChatWorktree();
  setSessions(
    (prev) => beginNewChatWorktreeOffer(prev, sessionId, cwd, setting) ?? prev,
  );
  void confirmNewChatWorktreeOffer(sessionId, cwd, {
    setting: loadNewChatWorktree,
    gitOnThisComputer: gitRepositoryOnThisComputer,
    commit: (update) => {
      setSessions((prev) => update(prev) ?? prev);
    },
  });
}

/**
 * The worktree for this send, or null when this chat stays in its folder.
 * Ask creates only when the composer toggle is on. Always also creates on a
 * first turn in a git repo unless the person chose this folder.
 * Does not catch: a refusal from createWorktree keeps its message.
 */
export async function openNewChatWorktree(
  input: NewChatWorktreeOpen,
  port: NewChatWorktreePort,
): Promise<Worktree | null> {
  const auto =
    input.setting === "always" && input.firstTurn && !input.declined && !input.toggleOn;
  if (!input.toggleOn && !auto) return null;
  if (!input.toggleOn) {
    if (!localFolder(input.cwd)) return null;
    let git = false;
    try {
      git = await port.gitOnThisComputer(input.cwd);
    } catch {
      return null;
    }
    if (!git) return null;
  }
  return port.createWorktree(
    input.cwd,
    temporaryWorktreeBranchName(),
    input.base || "HEAD",
    false,
  );
}

export function newChatWorktreeAskLine(
  session: Session,
  setting: NewChatWorktree,
): string | null {
  if (setting !== "ask") return null;
  if (session.workspaceMode !== "worktree" || session.worktreeCwd || session.worktreeRemoved) {
    return null;
  }
  if (!readable(session) || !isBlankSession(session)) return null;
  if (session.providerSessionId || session.inboxAsk || session.orchestrationLeadId) return null;
  return NEW_CHAT_WORKTREE_ASK;
}
