// SPDX-License-Identifier: Apache-2.0
// Design: HumanLayer packages/git-attribution hook scripts (Apache-2.0).
// The upstream tree was not in the local sources checkout, so this is a rewrite.
// The script itself lives in src-tauri so the app and these tests share one file.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SCRIPT = path.resolve("src-tauri/src/attribution/prepare-commit-msg.sh");

export function hookScript(): string {
  return readFileSync(SCRIPT, "utf8").replace(/\r\n/g, "\n");
}

/** Copy the shared hook into a hooks directory and mark it executable. Bytes that already match are left in place. */
export function installHookScript(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, "prepare-commit-msg");
  const text = hookScript();
  let current = "";
  try {
    current = readFileSync(dest, "utf8").replace(/\r\n/g, "\n");
  } catch {
    current = "";
  }
  if (current !== text) writeFileSync(dest, text, "utf8");
  if (process.platform !== "win32") chmodSync(dest, 0o755);
  return dest;
}
