// SPDX-License-Identifier: Apache-2.0
// Design: HumanLayer packages/git-attribution hook scripts (Apache-2.0).
// The upstream tree was not in the local sources checkout, so this is a rewrite.
// The script itself lives in src-tauri so the app and these tests share one file.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SCRIPT = path.resolve("src-tauri/src/attribution/hook.sh");
const REAL_HOOK_LINE = "real_hook=''";

/** One POSIX shell word. Git runs hooks with sh on every platform. */
function shellQuote(text: string): string {
  const slashed = process.platform === "win32" ? text.replace(/\\/g, "/") : text;
  return `'${slashed.replace(/'/g, "'\\''")}'`;
}

/**
 * The prepare-commit-msg script. `realHook` is the repository's own hook,
 * resolved when the crew started; it is baked in so the hook itself runs no
 * git. Left out, the script only stamps the trailers.
 */
export function hookScript(realHook?: string | null): string {
  const text = readFileSync(SCRIPT, "utf8").replace(/\r\n/g, "\n");
  if (!realHook) return text;
  if (!text.includes(REAL_HOOK_LINE)) throw new Error("hook.sh lost its real_hook line");
  return text.replace(REAL_HOOK_LINE, `real_hook=${shellQuote(realHook)}`);
}

/** Copy the shared hook into a hooks directory and mark it executable. Bytes that already match are left in place. */
export function installHookScript(dir: string, realHook?: string | null): string {
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, "prepare-commit-msg");
  const text = hookScript(realHook);
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
