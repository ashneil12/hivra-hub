// WP-84: a phase document stays inside the task's folder. A bad name is not written.

import { isEqualOrInside, joinPath } from "../../../shared/lib/paths";

const FILE_NAME = /^[0-9]{2}-[a-z0-9-]+\.md$/;

function safeId(taskId: string): boolean {
  if (!taskId || taskId === "." || taskId === "..") return false;
  if (taskId.includes("/") || taskId.includes("\\") || taskId.includes(":") || taskId.includes("..")) return false;
  return true;
}

/** The file to write, or nothing when the name could leave the task folder. */
export function documentPath(root: string, taskId: string, fileName: string): string | undefined {
  if (!root.trim() || !safeId(taskId) || !FILE_NAME.test(fileName)) return undefined;
  const dir = joinPath(root, taskId);
  const full = joinPath(dir, fileName);
  if (!isEqualOrInside(full, root) || !isEqualOrInside(full, dir)) return undefined;
  if (full.split("/").includes("..")) return undefined;
  return full;
}

export function persistDocs(
  root: string,
  taskId: string,
  docs: readonly { number: number; fileName: string; body: string }[],
  write: (path: string, body: string) => void,
): string[] {
  const seen = new Set<number>();
  const written: string[] = [];
  for (const doc of docs) {
    if (!Number.isInteger(doc.number) || seen.has(doc.number)) continue;
    const path = documentPath(root, taskId, doc.fileName);
    if (!path) continue;
    seen.add(doc.number);
    write(path, doc.body);
    written.push(path);
  }
  return written;
}
