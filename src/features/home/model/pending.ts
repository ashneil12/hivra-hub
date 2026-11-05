// A line on Home asks another screen to open one thing. The id stays until that screen's list actually has it,
// so a pane that mounted first, or a list that failed, does not drop it.

let pendingTaskId: string | null = null;
let pendingDocId: string | null = null;

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

/** Tests only. */
export function resetHomePending(): void {
  pendingTaskId = null;
  pendingDocId = null;
}
