import {
  newDefaultSession,
  type RuntimeMode,
  type Session,
} from "../../features/sessions/model/session";
import { leafIds, type WorkspaceTab } from "../../features/workspace/model/layout";
import {
  remotePendingWorktree,
  remoteSessionFor,
} from "../../features/connections/model/connections";
import { isBlankSession } from "../../features/projects/model/projectReturn";
import { worktreeFocus } from "../../features/source-control/model/worktreeFocus";
import { sameProjectPath } from "../../features/projects/model/recents";

/** Session defaults can supply permissions, but the visible project owns cwd. */
export function newWorkspaceSession(
  project: string,
  runtimeMode?: RuntimeMode,
) {
  const focus = worktreeFocus(project);
  return {
    ...newDefaultSession(project, runtimeMode),
    ...(focus && !sameProjectPath(focus.path, project)
      ? { worktreeCwd: focus.path, branch: focus.branch ?? undefined }
      : {}),
  };
}

/** One local session leaf, no files, nothing sent yet. */
export function isBlankWorkspaceTab(
  tab: WorkspaceTab,
  sessions: readonly Session[],
): boolean {
  if (tab.editorPanes.some((pane) => pane.files.length > 0)) return false;
  if ((tab.terminalPanes ?? []).some((pane) => pane.files.length > 0))
    return false;
  const ids = leafIds(tab.layout);
  if (ids.length !== 1) return false;
  if (remoteSessionFor(ids[0]) || remotePendingWorktree(ids[0])) return false;
  return isBlankSession(sessions.find((entry) => entry.id === ids[0]));
}

/**
 * The open blank "New session" tab New session should focus instead of adding
 * another: same project and worktree as the session it would create.
 */
export function reusableBlankSessionTab(
  tabs: readonly WorkspaceTab[],
  sessions: readonly Session[],
  fresh: Pick<Session, "cwd" | "worktreeCwd">,
): { tabId: string; sessionId: string } | undefined {
  for (const tab of tabs) {
    if (tab.kind !== "session" || !isBlankWorkspaceTab(tab, sessions)) continue;
    const sessionId = leafIds(tab.layout)[0];
    const session = sessions.find((entry) => entry.id === sessionId);
    if (
      !session ||
      session.sidebarHidden ||
      session.inboxAsk ||
      session.orchestrationLeadId ||
      session.ephemeral ||
      !sameProjectPath(session.cwd, fresh.cwd)
    )
      continue;
    const tree = session.worktreeCwd ?? session.cwd;
    const wanted = fresh.worktreeCwd ?? fresh.cwd;
    if (!sameProjectPath(tree, wanted)) continue;
    return { tabId: tab.id, sessionId: session.id };
  }
  return undefined;
}
