// SPDX-License-Identifier: Apache-2.0
// Translated from github.com/coollabsio/orbit apps/web/src/features/docs/pageTree.ts (WP-72).
// The upstream file does not carry a separate copyright line.
// Teamspaces and private spaces are not ported: Hivra has one page tree per project.

export type TreePage = {
  id: string;
  parentId: string | null;
  sortOrder: number;
};

export type DropZone = "before" | "after" | "inside";

export type MoveTarget = {
  parentId: string | null;
  /** Index among the new siblings, not counting the moved page. */
  index: number;
};

function byOrder(a: TreePage, b: TreePage): number {
  return a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Direct children of `parentId`, ordered. `null` is the roots. */
export function childrenOf<T extends TreePage>(pages: readonly T[], parentId: string | null): T[] {
  return pages.filter((page) => page.parentId === parentId).sort(byOrder);
}

/** Every page below `pageId`. A cycle in the stored tree does not loop forever. */
export function descendantsOf<T extends TreePage>(pages: readonly T[], pageId: string): T[] {
  const out: T[] = [];
  const queue = [pageId];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const parent = queue.shift();
    if (!parent) break;
    for (const child of childrenOf(pages, parent)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      queue.push(child.id);
    }
  }
  return out;
}

/** Ancestors, root first, excluding the page. Stops on a missing parent or a cycle. */
export function ancestorsOf<T extends TreePage>(pages: readonly T[], pageId: string | null): T[] {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const chain: T[] = [];
  const seen = new Set<string>();
  let current = pageId ? byId.get(pageId) : undefined;
  while (current?.parentId && !seen.has(current.parentId)) {
    seen.add(current.parentId);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    chain.unshift(parent);
    current = parent;
  }
  return chain;
}

/** A page cannot move onto itself or into its own subtree. */
export function canMove(pages: readonly TreePage[], dragId: string, parentId: string | null): boolean {
  if (!pages.some((page) => page.id === dragId)) return false;
  if (parentId === null) return true;
  if (dragId === parentId) return false;
  if (!pages.some((page) => page.id === parentId)) return false;
  return !descendantsOf(pages, dragId).some((page) => page.id === parentId);
}

/**
 * `inside` appends as the target's last child. `before` / `after` sit next to the target.
 * The index counts siblings with the dragged page removed. Null for a cycle, an unknown id,
 * or a drop that changes nothing.
 */
export function dropToMove(
  pages: readonly TreePage[],
  dragId: string,
  targetId: string,
  zone: DropZone,
): MoveTarget | null {
  const dragged = pages.find((page) => page.id === dragId);
  const target = pages.find((page) => page.id === targetId);
  if (!dragged || !target) return null;
  const parentId = zone === "inside" ? target.id : target.parentId;
  if (!canMove(pages, dragId, parentId)) return null;
  const siblings = childrenOf(pages, parentId).filter((page) => page.id !== dragId);
  let index = zone === "inside" ? siblings.length : siblings.findIndex((page) => page.id === targetId);
  if (zone === "after") index += 1;
  if (index < 0) return null;
  if (dragged.parentId === parentId) {
    const current = childrenOf(pages, parentId).findIndex((page) => page.id === dragId);
    const nextIndex = current < index ? index - 1 : index;
    if (current === nextIndex) return null;
  }
  return { parentId, index };
}

/** Sibling order after a move. The moved page takes `index`; everyone else keeps relative order. */
export function reorder(siblings: readonly string[], dragId: string, index: number): string[] {
  const rest = siblings.filter((id) => id !== dragId);
  const at = Math.max(0, Math.min(index, rest.length));
  return [...rest.slice(0, at), dragId, ...rest.slice(at)];
}
