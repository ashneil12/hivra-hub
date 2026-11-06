// SPDX-License-Identifier: Apache-2.0
// Design: HumanLayer packages/git-attribution git-env (Apache-2.0).
// The upstream tree was not in the local sources checkout, so this is a rewrite.

export type GitConfigPairs = {
  GIT_CONFIG_COUNT: string;
  key: string;
  valueName: string;
  hooksPath: string;
};

/**
 * One more `core.hooksPath` pair, appended to a count the parent already set.
 * A count that is not a non-negative integer is left alone: returning null
 * tells the caller not to touch the environment.
 */
export function gitConfigEnv(existingCount: string | undefined, hooksPath: string): GitConfigPairs | null {
  let count = 0;
  if (existingCount !== undefined) {
    if (!/^[0-9]+$/.test(existingCount)) return null;
    const parsed = Number(existingCount);
    if (!Number.isSafeInteger(parsed)) return null;
    count = parsed;
  }
  return {
    GIT_CONFIG_COUNT: String(count + 1),
    key: `GIT_CONFIG_KEY_${count}`,
    valueName: `GIT_CONFIG_VALUE_${count}`,
    hooksPath,
  };
}
