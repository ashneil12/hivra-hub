import { flattenBoard, type BoardNode } from "./tree";

export type BoardStateFilter = "needs-you" | "working" | "done-today" | null;

export type BoardFilter = {
  projectId: string | null;
  state: BoardStateFilter;
};

function sameDay(settledAt: number | null, now: number): boolean {
  if (settledAt == null || !Number.isFinite(settledAt) || !Number.isFinite(now)) return false;
  const left = new Date(settledAt);
  const right = new Date(now);
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function matches(node: BoardNode, filter: BoardFilter, now: number): boolean {
  if (filter.projectId && node.projectId !== filter.projectId) return false;
  if (filter.state === "needs-you") return node.state === "needs-you";
  if (filter.state === "working") return node.state === "working";
  if (filter.state === "done-today") return node.state === "done" && sameDay(node.settledAt, now);
  return true;
}

function prune(node: BoardNode, filter: BoardFilter, now: number): BoardNode | null {
  const children = node.children.flatMap((child) => {
    const next = prune(child, filter, now);
    return next ? [next] : [];
  });
  if (children.length || matches(node, filter, now)) return { ...node, children };
  return null;
}

/** Keep a matching row and the rows above it. A filter never invents a row. */
export function filterBoard(root: BoardNode, filter: BoardFilter, now: number): BoardNode {
  if (!filter.projectId && !filter.state) return root;
  return prune(root, filter, now) ?? { ...root, children: [] };
}

export function visibleIds(root: BoardNode): string[] {
  return flattenBoard(root).map((node) => node.id);
}
