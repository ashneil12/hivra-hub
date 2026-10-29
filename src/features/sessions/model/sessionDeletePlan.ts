import { pathKey } from "../../../shared/lib/paths";
import { worktreeSessionIds, type Worktree } from "../../source-control/model/worktrees";
import type { Session } from "./session";

/**
 * r69 (PM r67 step 5): a sub-chat's Delete showed no confirm and left its worktree. The confirm waited on a git
 * worktree listing and on the session being open or in the shown project's history; a slow listing kept the confirm
 * away and every later Delete click returned silently. These keep the confirm prompt, and a sub-chat's own worktree
 * is offered (ticked) with it.
 */
export const DELETE_LOOKUP_MS = 2_500;

/** The lookup's answer, or undefined once `ms` has passed or it failed: the confirm never waits longer than that. */
export function withinDeadline<T>(lookup: Promise<T>, ms = DELETE_LOOKUP_MS): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    lookup.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

type SeedLike = Pick<Session, "cwd" | "worktreeCwd">;
type OpenLike = Pick<Session, "id" | "cwd" | "worktreeCwd" | "worktreeRemoved">;

/** The session's own worktree, when nothing else uses it and it is safe to offer (not main, not locked, on a branch). */
export function unusedWorktreeOf(
  sessionId: string,
  seed: SeedLike | undefined,
  worktrees: readonly Worktree[] | undefined,
  open: readonly OpenLike[],
): string | undefined {
  if (!seed?.worktreeCwd || !worktrees) return undefined;
  const tree = worktrees.find((entry) => pathKey(entry.path) === pathKey(seed.worktreeCwd!));
  if (!tree || tree.isMain || tree.locked || !tree.branch) return undefined;
  return worktreeSessionIds(tree, open).every((id) => id === sessionId) ? tree.path : undefined;
}

/** A sub-chat's worktree is its own scratch: offered ticked. Ash's own chats keep the box unticked. */
export function worktreeTickedByDefault(subChat: boolean, unusedWorktree: string | undefined): boolean {
  return subChat && !!unusedWorktree;
}
