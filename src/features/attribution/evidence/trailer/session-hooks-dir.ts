// SPDX-License-Identifier: Apache-2.0
// Design: HumanLayer packages/git-attribution session hooks dir (Apache-2.0).
// The upstream tree was not in the local sources checkout, so this is a rewrite.

import path from "node:path";

/**
 * `<data>/attribution/hooks`. Empty, a NUL, or a `..` segment is rejected.
 * The directory stays inside the data directory after the path is resolved.
 */
export function hooksDir(dataDir: string): string | null {
  if (!dataDir || dataDir.trim() === "") return null;
  if (dataDir.includes("\0")) return null;
  const segments = dataDir.split(/[/\\]/);
  if (segments.includes("..")) return null;
  const root = path.resolve(dataDir);
  const dir = path.resolve(root, "attribution", "hooks");
  const rel = path.relative(root, dir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return dir;
}
