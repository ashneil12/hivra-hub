// WP-135: a compare's worktrees leave through the app's usual removal, never a private delete and never with force.
import { pathKey } from "../../../shared/lib/paths";
import { listProjectActions, runProjectAction } from "../../projects/model/projectActions";
import { listWorktrees, type RemoveWorktree, type Worktree } from "../../source-control/model/worktrees";
import type { FanOutCleanupPort } from "./fanOutDecide";

/** What the app says about one worktree: the fields the compare needs, as `git_worktrees` reports them. */
export type OwnWorktreeFacts = Pick<Worktree, "head" | "dirty" | "locked" | "missing" | "isMain">;

/**
 * Whether a worktree the compare made can be taken back. Only a worktree that is clean and still at the commit it was
 * made at holds nothing of anyone's, so only that one goes. This is not the clean-up's merged-and-idle-a-day rule:
 * a worktree made a minute ago always fails that one, so it would never remove anything here.
 *
 * - `undefined`: git lists no such worktree, so there is nothing left to remove ("gone").
 * - a throw: git did not say whether it has local changes, so nothing is decided.
 */
export function ownWorktreeVerdict(
  facts: OwnWorktreeFacts | undefined,
  madeAt: string | null,
): "remove" | "keep" | "gone" {
  if (!facts) return "gone";
  if (facts.isMain || facts.locked || facts.missing) return "keep";
  if (facts.dirty === null) throw new Error("status unknown");
  if (facts.dirty) return "keep";
  if (!madeAt || facts.head !== madeAt) return "keep";
  return "remove";
}

/** The folder worktrees are made in for one project. A throw, or an empty list, means git has not answered. */
export async function defaultWorktreeRoots(cwd: string): Promise<string[]> {
  const listed = await listWorktrees(cwd);
  const root = typeof listed.defaultRoot === "string" ? listed.defaultRoot.trim() : "";
  return root ? [root] : [];
}

/**
 * Roots and verdicts for one project, and the stop a discard needs. A throw means git has not answered (or, for
 * `stop`, that the chat may still be running). Removal is the app's own, without force, so git itself refuses a
 * worktree with changes in it.
 */
export function fanOutJanitorPort(
  cwd: string,
  onRemove: RemoveWorktree,
  stop: (childId: string) => Promise<void>,
): FanOutCleanupPort {
  return {
    stop,
    allowedRoots: () => defaultWorktreeRoots(cwd),
    inspect: async (path, madeAt) => {
      const listed = await listWorktrees(cwd);
      const entry = listed.worktrees.find((item) => pathKey(item.path) === pathKey(path));
      return ownWorktreeVerdict(entry, madeAt);
    },
    remove: async (path) => {
      // keepSessions: the chat that worked there keeps its history and is told its worktree is gone.
      await onRemove(cwd, path, false, true);
    },
  };
}

/**
 * Start the project's setup in a compare worktree, once the compare is saved. It is the same action a new worktree
 * runs on its own, and nothing runs unless the project file was imported. Best effort: the chat starts either way.
 */
export async function startFanOutSetup(projectCwd: string, path: string): Promise<void> {
  try {
    const listing = await listProjectActions(projectCwd);
    const setup = listing.actions.find((action) => action.runOnWorktreeCreate);
    if (setup) await runProjectAction(path, setup.id, "app");
  } catch {
    // A setup that could not start is not a reason to stop the chat.
  }
}
