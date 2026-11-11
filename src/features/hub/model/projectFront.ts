// Dropwave (Ash, 11 Nov): a project's chat area is one layout for anybody, the old coding team's: the chat list on the
// left with one chat pinned on top. Who is pinned is who Ash opened last there: the Chief of Staff's own chat for the
// project (the default) or the project's Lead. Kept for this run of the app only.
import { useSyncExternalStore } from "react";

export type ProjectFront = "captain" | "lead";

const fronts = new Map<string, ProjectFront>();
let version = 0;
const listeners = new Set<() => void>();

export function projectFront(projectId: string): ProjectFront {
  return fronts.get(projectId) ?? "captain";
}

export function setProjectFront(projectId: string, front: ProjectFront): void {
  if (projectFront(projectId) === front) return;
  fronts.set(projectId, front);
  version += 1;
  listeners.forEach((listener) => listener());
}

export function useProjectFrontVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
    () => version,
  );
}

/** Tests: forget every front. */
export function resetProjectFronts(): void {
  fronts.clear();
  version += 1;
}
