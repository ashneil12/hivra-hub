// SPDX-License-Identifier: Apache-2.0
// Design: HumanLayer packages/git-attribution forwarded hooks (Apache-2.0).
// The upstream tree was not in the local sources checkout, so this is a rewrite.

import path from "node:path";

export type HookFile = { exists: boolean; executable: boolean };

/**
 * Git's own rule. Windows has no executable bit, so a hook file that exists is
 * one git runs; everywhere else the executable bit decides.
 */
export function hookRunnable(hook: HookFile, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" ? hook.exists : hook.executable;
}

/**
 * The repository hook git itself would run. A worktree's hooks live in the
 * common git dir. A missing path, or a hook git would not run, is not a hook.
 */
export function repoHook(
  gitCommonDir: string | undefined,
  gitDir: string | undefined,
  hook: HookFile,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const root = gitCommonDir && gitCommonDir.trim() !== "" ? gitCommonDir : gitDir;
  if (!root || root.trim() === "") return null;
  if (!hookRunnable(hook, platform)) return null;
  return path.join(root, "hooks", "prepare-commit-msg");
}
