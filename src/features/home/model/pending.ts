// A line on Home asks another screen to open one thing. The id stays until that screen's list actually has it,
// so a pane that mounted first, or a list that failed, does not drop it.

import { pathKey } from "../../../shared/lib/paths";

let pendingTaskId: string | null = null;
let pendingDocId: string | null = null;
let pendingDecision: { projectId: string; decisionKey: string } | null = null;

export function queueHomeTask(id: string): void {
  const clean = id.trim();
  if (!clean) return;
  pendingTaskId = clean;
}

export function takeHomeTask(ids: readonly string[]): string | null {
  if (!pendingTaskId || !ids.includes(pendingTaskId)) return null;
  const id = pendingTaskId;
  pendingTaskId = null;
  return id;
}

export function queueHomeDoc(id: string): void {
  const clean = id.trim();
  if (!clean) return;
  pendingDocId = clean;
}

export function takeHomeDoc(ids: readonly string[]): string | null {
  if (!pendingDocId || !ids.includes(pendingDocId)) return null;
  const id = pendingDocId;
  pendingDocId = null;
  return id;
}

export function queueHomeDecision(projectId: string, decisionKey: string): void {
  const project = projectId.trim();
  const key = decisionKey.trim();
  if (!project || !key) return;
  pendingDecision = { projectId: project, decisionKey: key };
}

/** The decision Home named, once this inbox list actually has it. A Windows path matches either way. */
export function takeHomeDecision(shown: readonly { key: string | null; project: string }[]): string | null {
  const pending = pendingDecision;
  if (!pending) return null;
  const hit = shown.find((item) => {
    if (!item.key || item.key !== pending.decisionKey) return false;
    return item.project === pending.projectId || pathKey(item.project) === pathKey(pending.projectId);
  });
  if (!hit?.key) return null;
  pendingDecision = null;
  return hit.key;
}

/** Tests only. */
export function resetHomePending(): void {
  pendingTaskId = null;
  pendingDocId = null;
  pendingDecision = null;
}
