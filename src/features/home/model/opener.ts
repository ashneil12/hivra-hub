// How a line on Home opens. The app lends the way. Without it, a task or a doc still selects the screen it belongs to.

import { openDocsMode } from "../../docs/docsMode";
import { openCodingTeam, projectHasCodeFolder, setHubSelection } from "../../hub/model/hubNav";
import type { SettingsSectionId } from "../../settings/model/settings";
import { queueHomeDecision, queueHomeDoc, queueHomeTask } from "./pending";

export type HomeOpenTarget =
  | { kind: "inbox"; projectId: string; decisionKey: string }
  | { kind: "task"; projectId: string; id: string }
  | { kind: "doc"; id: string }
  | { kind: "chat"; id: string; projectId: string }
  | { kind: "coding"; projectId: string }
  | { kind: "settings"; section: SettingsSectionId; anchor: string };

/** The Clean up card on Settings > Worktrees (`data-setting-id` in WorktreeCleanup.tsx). */
export const WORKTREE_CLEANUP = "worktree-cleanup";

export type HomeProjectRef = { id: string; folder?: string | null };

/** What the workspace lends, so a line can leave Home. */
export type HomeOpenHands = {
  closeChrome: () => void;
  openInbox: () => void;
  openNotes: () => void;
  openSession: (sessionId: string) => void;
  openTeam: (projectId: string) => void;
  /** Settings, on a page and on the card to land on (the same call the app's own Settings links use). */
  openSettings: (section: SettingsSectionId, anchor?: string) => void;
  projects: () => readonly HomeProjectRef[];
};

function decisionProject(projectId: string, projects: readonly HomeProjectRef[]): string {
  const project = projects.find((item) => item.id === projectId);
  if (project && projectHasCodeFolder(project.folder)) return project.folder;
  return projectId;
}

/**
 * Open the place a line names. A chat steps the hub aside first, or the workspace stays hidden behind Home.
 * A project with no folder has no workspace, so the chat still opens and Home is left as it is.
 */
export function applyHomeOpen(target: HomeOpenTarget, hands: HomeOpenHands): void {
  if (target.kind === "inbox") {
    hands.closeChrome();
    queueHomeDecision(decisionProject(target.projectId, hands.projects()), target.decisionKey);
    hands.openInbox();
    return;
  }
  if (target.kind === "task") {
    hands.closeChrome();
    queueHomeTask(target.id);
    hands.openTeam(target.projectId);
    return;
  }
  if (target.kind === "doc") {
    queueHomeDoc(target.id);
    openDocsMode();
    hands.openNotes();
    return;
  }
  if (target.kind === "chat") {
    hands.closeChrome();
    const project = hands.projects().find((item) => item.id === target.projectId && projectHasCodeFolder(item.folder));
    if (project) setHubSelection({ project: project.id, item: "coding-team" });
    hands.openSession(target.id);
    return;
  }
  if (target.kind === "settings") {
    hands.closeChrome();
    hands.openSettings(target.section, target.anchor);
    return;
  }
  hands.closeChrome();
  hands.openTeam(target.projectId);
}

let opener: ((target: HomeOpenTarget) => void) | undefined;

export function setHomeOpener(open: (target: HomeOpenTarget) => void): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = undefined;
  };
}

export function openFromHome(target: HomeOpenTarget): void {
  if (opener) {
    opener(target);
    return;
  }
  if (target.kind === "task") {
    queueHomeTask(target.id);
    openCodingTeam(target.projectId);
    return;
  }
  if (target.kind === "coding") {
    openCodingTeam(target.projectId);
    return;
  }
  if (target.kind === "doc") {
    queueHomeDoc(target.id);
    openDocsMode();
    window.dispatchEvent(new CustomEvent("monocode:home-open", { detail: "notes" }));
  }
  // A settings line needs the workspace's hands. Without them there is nowhere to open it, so it does nothing.
}

export function targetFor(line: { kind: string; projectId: string; target: string }): HomeOpenTarget {
  if (line.kind === "decision") return { kind: "inbox", projectId: line.projectId, decisionKey: line.target };
  if (line.kind === "doc") return { kind: "doc", id: line.target };
  if (line.kind === "chat") return { kind: "chat", id: line.target, projectId: line.projectId };
  if (line.kind === "coding" || line.kind === "project") return { kind: "coding", projectId: line.projectId };
  if (line.kind === "builders") return { kind: "settings", section: "worktrees", anchor: WORKTREE_CLEANUP };
  return { kind: "task", projectId: line.projectId, id: line.target };
}
