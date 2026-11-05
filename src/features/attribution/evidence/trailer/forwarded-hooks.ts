// SPDX-License-Identifier: Apache-2.0
// Design: HumanLayer packages/git-attribution forwarded hooks (Apache-2.0).
// The upstream tree was not in the local sources checkout, so this is a rewrite.

import path from "node:path";

/**
 * The repository hook git itself would run. A worktree's hooks live in the
 * common git dir. A missing path, or a hook that is not executable, is not a hook.
 */
export function repoHook(gitCommonDir: string | undefined, gitDir: string | undefined, executable: boolean): string | null {
  const root = gitCommonDir && gitCommonDir.trim() !== "" ? gitCommonDir : gitDir;
  if (!root || root.trim() === "") return null;
  if (!executable) return null;
  return path.join(root, "hooks", "prepare-commit-msg");
}
