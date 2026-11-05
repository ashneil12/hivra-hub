// SPDX-License-Identifier: Apache-2.0
// Design: HumanLayer packages/git-attribution hook scripts (Apache-2.0).
// The upstream tree was not in the local sources checkout, so this is a rewrite.
// The script itself lives in src-tauri so the app and these tests share one file.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SCRIPT = path.resolve("src-tauri/src/attribution/hook.sh");
const REAL_HOOK_LINE = "real_hook=''";
const HOOK_TEST_LINE = "hook_test='-x'";

/** One POSIX shell word. Git runs hooks with sh on every platform. */
function shellQuote(text: string, platform: NodeJS.Platform): string {
  const slashed = platform === "win32" ? text.replace(/\\/g, "/") : text;
  return `'${slashed.replace(/'/g, "'\\''")}'`;
}

/**
 * The prepare-commit-msg script. `realHook` is the repository's own hook,
 * resolved when the crew started; it is baked in so the hook itself runs no
 * git. Left out, the script only stamps the trailers.
 *
 * The generated file is LF whatever the platform. A Windows path is baked with
 * forward slashes, which Git for Windows' sh accepts, and the guard that
 * decides whether the repo hook runs matches git: the executable bit on Unix,
 * existence on Windows.
 */
export function hookScript(realHook?: string | null, platform: NodeJS.Platform = process.platform): string {
  let text = readFileSync(SCRIPT, "utf8").replace(/\r\n/g, "\n");
  if (!text.includes(REAL_HOOK_LINE) || !text.includes(HOOK_TEST_LINE)) {
    throw new Error("hook.sh lost its real_hook or hook_test line");
  }
  text = text.replace(HOOK_TEST_LINE, `hook_test='${platform === "win32" ? "-f" : "-x"}'`);
  if (!realHook) return text;
  return text.replace(REAL_HOOK_LINE, `real_hook=${shellQuote(realHook, platform)}`);
}

/** Copy the shared hook into a hooks directory and mark it executable. Bytes that already match are left in place. */
export function installHookScript(
  dir: string,
  realHook?: string | null,
  platform: NodeJS.Platform = process.platform,
): string {
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, "prepare-commit-msg");
  const text = hookScript(realHook, platform);
  let current = "";
  try {
    current = readFileSync(dest, "utf8").replace(/\r\n/g, "\n");
  } catch {
    current = "";
  }
  if (current !== text) writeFileSync(dest, text, "utf8");
  if (platform !== "win32") chmodSync(dest, 0o755);
  return dest;
}
