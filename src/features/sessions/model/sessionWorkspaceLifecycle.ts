import {
  closeLeaf,
  firstLeafId,
  isSessionChangesTab,
  leafIds,
  removePane,
  type EditorPane,
  type WorkspaceTab,
} from "../../workspace/model/layout";
import type { Session } from "./session";
import {
  planWorkspaceTabClose,
  workspaceTabCwd,
  type WorkspaceTabCloseScope,
} from "../../workspace/model/workspaceTabGroups";
import { sameProjectPath } from "../../projects/model/recents";
import { NO_PROJECT, type HubSelection } from "../../hub/model/hubNav";

export type SessionWorkspaceRemoval = {
  tabs: WorkspaceTab[];
  sessions: Session[];
  activeTabId: string;
  closedTabs: WorkspaceTab[];
  /**
   * True when the window's very last tab lost its conversation (r30e). The tab keeps a fresh session underneath (a
   * window always has one), but the caller shows the window's home (Today) instead of an empty "New session".
   */
  windowEmptied: boolean;
};

export function removeSessionFromWorkspace({
  tabs,
  sessions,
  sessionId,
  activeTabId,
  scope,
  createReplacement,
  canCloseTab = () => true,
  replaceEmptyTab = true,
}: {
  tabs: WorkspaceTab[];
  sessions: Session[];
  sessionId: string;
  activeTabId: string;
  scope: WorkspaceTabCloseScope;
  createReplacement: (seed: Session | undefined) => Session;
  /** Preserve file panes changed while an asynchronous close was pending. */
  canCloseTab?: (tab: WorkspaceTab) => boolean;
  /**
   * False for a team's sub-chat (r30d): its tab closes rather than turning into an empty "New session", whenever any
   * other tab is left to show. The very last tab of the window still gets a fresh session (a window always has one).
   */
  replaceEmptyTab?: boolean;
}): SessionWorkspaceRemoval {
  const seed = sessions.find((session) => session.id === sessionId);
  let nextTabs = [...tabs];
  let nextSessions = sessions.filter((session) => session.id !== sessionId);
  const remainingSessionIds = new Set(
    nextSessions.map((session) => session.id),
  );
  let nextActiveTabId = activeTabId;
  const closedTabs: WorkspaceTab[] = [];
  let windowEmptied = false;

  for (const original of tabs) {
    const hadSession = leafIds(original.layout).includes(sessionId);
    const index = nextTabs.findIndex((tab) => tab.id === original.id);
    if (index < 0) continue;

    const cleaned = removeSessionDocuments(nextTabs[index], sessionId);
    if (!hadSession && cleaned) {
      nextTabs[index] = cleaned;
      continue;
    }
    const tab = cleaned ?? original;
    const remainingConversations = leafIds(tab.layout).some((id) =>
      remainingSessionIds.has(id),
    );

    if (remainingConversations || (cleaned && !canCloseTab(original))) {
      const next = closeLeaf(tab, sessionId);
      if (next) nextTabs[index] = next;
      if (next) continue;
    }

    closedTabs.push(original);
    const closePlan = planWorkspaceTabClose({
      tabs: nextTabs,
      sessions,
      closingTabId: tab.id,
      scope,
    });
    if (closePlan.action === "close") {
      const at = nextTabs.findIndex((entry) => entry.id === tab.id);
      nextTabs = nextTabs.filter((entry) => entry.id !== tab.id);
      // r30e: the next tab shown is one of the same project's, even when another project's tab sits beside it.
      if (tab.id === nextActiveTabId && closePlan.nextActiveTabId) {
        nextActiveTabId = neighbourTab(nextTabs, at, tab, sessions).id;
      }
      continue;
    }
    if (!replaceEmptyTab && nextTabs.length > 1) {
      const at = nextTabs.findIndex((entry) => entry.id === tab.id);
      nextTabs = nextTabs.filter((entry) => entry.id !== tab.id);
      if (tab.id === nextActiveTabId) nextActiveTabId = neighbourTab(nextTabs, at, tab, sessions).id;
      continue;
    }

    if (nextTabs.length === 1) windowEmptied = true;
    const replacement = createReplacement(seed);
    remainingSessionIds.add(replacement.id);
    nextSessions = [...nextSessions, replacement];
    nextTabs[index] = {
      ...tab,
      layout: { type: "leaf", id: replacement.id },
      focusedId: replacement.id,
      editorPanes: [],
      terminalPanes: [],
      diffOpen: false,
      diffFocused: false,
    };
  }

  return {
    tabs: nextTabs,
    sessions: nextSessions,
    activeTabId: nextActiveTabId,
    closedTabs,
    windowEmptied,
  };
}

/** The tab to show after `closed` (which sat at `at`) goes: the nearest one of its own project, else its neighbour. */
function neighbourTab(
  rest: WorkspaceTab[],
  at: number,
  closed: WorkspaceTab,
  sessions: Session[],
): WorkspaceTab {
  const cwd = workspaceTabCwd(closed, sessions);
  if (cwd) {
    const same = (tab: WorkspaceTab) => {
      const other = workspaceTabCwd(tab, sessions);
      return !!other && sameProjectPath(other, cwd);
    };
    for (let index = at - 1; index >= 0; index -= 1) if (same(rest[index]!)) return rest[index]!;
    for (let index = at; index < rest.length; index += 1) if (same(rest[index]!)) return rest[index]!;
  }
  return rest[Math.max(0, at - 1)]!;
}

function removeSessionDocuments(
  tab: WorkspaceTab,
  sessionId: string,
): WorkspaceTab | null {
  if (
    !tab.editorPanes.some((pane) =>
      pane.files.some(
        (file) =>
          file.plan?.sessionId === sessionId ||
          (isSessionChangesTab(file) &&
            file.sessionChanges.sessionId === sessionId),
      ),
    )
  )
    return tab;
  let layout = tab.layout;
  let focusedId = tab.focusedId;
  const editorPanes: EditorPane[] = [];

  for (const pane of tab.editorPanes) {
    const files = pane.files.filter(
      (file) =>
        file.plan?.sessionId !== sessionId &&
        (!isSessionChangesTab(file) ||
          file.sessionChanges.sessionId !== sessionId),
    );
    if (files.length > 0) {
      editorPanes.push({
        ...pane,
        files,
        activeFileId: files.some((file) => file.id === pane.activeFileId)
          ? pane.activeFileId
          : files[0].id,
      });
      continue;
    }
    const nextLayout = removePane(layout, pane.id);
    if (!nextLayout) return null;
    layout = nextLayout;
    if (focusedId === pane.id) focusedId = firstLeafId(nextLayout);
  }

  return { ...tab, layout, focusedId, editorPanes };
}

/**
 * The window's home: where Ash lands when a delete takes the window's last tab (r30e). With no project chosen the hub
 * opens a project's Today (the first one, or the create-a-project empty state) — there is no central board (G1).
 */
export const WINDOW_HOME: HubSelection = { project: NO_PROJECT, item: "" };

export function homeAfterRemoval(
  mode: "archive" | "delete",
  origin: RemovalOrigin,
  removal: Pick<SessionWorkspaceRemoval, "windowEmptied">,
): HubSelection | null {
  return mode === "delete" && origin === "ui" && removal.windowEmptied ? WINDOW_HOME : null;
}

/**
 * Who took a session out of the window: Ash in the app ("ui"), the CLI or phone ("cli"), or the app's own background
 * work ("app": a finished run's teardown, a group room letting go of a session).
 */
export type RemovalOrigin = "ui" | "cli" | "app";

/**
 * What a session leaving the window does to what Ash sees (r61, PM's r60 D5/C3: the app jumped from the Lead's or a
 * Mono's chat to the coding team's tabs on its own). Only Ash's own archive or delete moves him: the next tab is shown,
 * closing a Mono's chat or hub page over it. Anything else only updates which tab the hidden workspace has selected,
 * and never takes him home.
 */
export function viewAfterRemoval(
  mode: "archive" | "delete",
  origin: RemovalOrigin,
  removal: Pick<SessionWorkspaceRemoval, "windowEmptied" | "activeTabId">,
  activeTabId: string,
): { activeTabId: string | null; reveal: boolean; home: HubSelection | null } {
  return {
    activeTabId: removal.activeTabId !== activeTabId ? removal.activeTabId : null,
    reveal: origin === "ui",
    home: homeAfterRemoval(mode, origin, removal),
  };
}
