// SPDX-License-Identifier: Apache-2.0
// Design: HumanLayer packages/git-attribution session-attribution (Apache-2.0).
// The upstream tree was not in the local sources checkout, so this is a rewrite.

const ID = /^[A-Za-z0-9._:/-]{1,200}$/;

/** A chat or task id from the environment, a commit, or the database. Anything else is ignored. */
export function validId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!ID.test(value)) return null;
  return value;
}
