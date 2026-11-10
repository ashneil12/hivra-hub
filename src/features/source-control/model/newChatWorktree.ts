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

export type NewChatWorktreeOpen = {
  setting: NewChatWorktree;
  /**
   * False for a chat that continues one, a worker (one the app started for a
   * Lead), an inbox ask, or an automation. `newChatWorktreeOpenFor` decides it.
   */
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

/**
 * A chat the app started for a Lead or another chat (`app-<chat>-<request>`).
 * Its brief says where it works, so a default worktree never moves it.
 */
function startedThroughApp(sessionId: string): boolean {
  return sessionId.startsWith("app-");
}

/** The person chose this folder for this chat. The choice is held on the chat and saved with the open tabs. */
export function newChatStaysHere(session: Pick<Session, "worktreeDeclined">): boolean {
  return session.worktreeDeclined === true;
}

/** Hold a switch between this folder and a new worktree on the chat. Choosing a worktree takes it back. */
export function withNewChatFolderChoice(session: Session, mode: WorkspaceMode): Session {
  if (mode === "current") {
    return newChatStaysHere(session) ? session : { ...session, worktreeDeclined: true };
  }
  return withoutNewChatFolderChoice(session);
}

/** The folder changed, so the old choice does not apply. */
export function withoutNewChatFolderChoice(session: Session): Session {
  if (session.worktreeDeclined === undefined) return session;
  const { worktreeDeclined: _gone, ...rest } = session;
  return rest;
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
  if (!localFolder(cwd) || startedThroughApp(sessionId)) return null;
  const session = sessions.find((entry) => entry.id === sessionId);
  if (!session || newChatStaysHere(session) || !canOffer(session, cwd)) return null;
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
 * Take the offer back when it is still the one we made: git says this is not a
 * repository, or it did not answer. Nothing is stored about the folder.
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
  if (newChatStaysHere(session)) return null;
  return sessions.map((entry) =>
    entry.id === sessionId
      ? { ...entry, workspaceMode: undefined, worktreeBase: undefined }
      : entry,
  );
}

/**
 * Ask git, then keep or clear the offer. A throw (git timed out or could not
 * be reached) skips this chat: the offer is taken back and nothing is stored,
 * so the next new chat asks again.
 */
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
    // Git did not answer: git stays false, so this chat is skipped below.
  }
  port.commit((sessions) => {
    const setting = port.setting();
    if (git && setting !== "off") return null;
    return clearUnconfirmedNewChatWorktree(sessions, sessionId, cwd);
  });
}

/** How long a new chat waits for git before it skips the worktree default. */
export const NEW_CHAT_GIT_WAIT_MS = 5000;

/** Rejects when `work` has not settled in `waitMs`, so a git that never answers cannot hold a send. */
function answeredWithin<T>(work: Promise<T>, waitMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("git did not answer in time")), waitMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * True when `git_branches` can see a repository. An empty answer means this
 * folder is not one. A throw, or no answer within `NEW_CHAT_GIT_WAIT_MS`, is
 * left to the caller, so a timeout is not "not a repo".
 */
export async function gitRepositoryOnThisComputer(
  cwd: string,
  waitMs: number = NEW_CHAT_GIT_WAIT_MS,
): Promise<boolean> {
  if (!localFolder(cwd)) return false;
  const listed = await answeredWithin(gitBranches(cwd), waitMs);
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

/**
 * What a send asks `openNewChatWorktree`. The chat decides whether this is a
 * first turn the default may act on: not one that continues a chat, not a
 * Lead, an inbox ask, an automation, a worker the app started, or a chat that
 * already has or lost a worktree. A person who chose this folder is `declined`.
 */
export function newChatWorktreeOpenFor(
  session: Session,
  send: { setting: NewChatWorktree; isFirstTurn: boolean; toggleOn: boolean },
): NewChatWorktreeOpen {
  return {
    setting: send.setting,
    firstTurn:
      send.isFirstTurn &&
      !session.worktreeCwd &&
      !session.providerSessionId &&
      !session.orchestrationLeadId &&
      !session.inboxAsk &&
      !session.worktreeRemoved &&
      !session.automationId &&
      !session.ephemeral &&
      !startedThroughApp(session.id),
    toggleOn: send.toggleOn,
    declined: newChatStaysHere(session),
    cwd: session.cwd,
    base: session.worktreeBase || "HEAD",
  };
}

/** The palette moves between off and ask. Always becomes ask, and is never written. */
export function flippedNewChatWorktree(value: NewChatWorktree): NewChatWorktree {
  return value === "ask" ? "off" : "ask";
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
