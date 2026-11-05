// WP-85. Paths for the mirror plugin. Separators come from node:path, never a hard-coded slash.

import path from "node:path";

export const DAILY_ID = "com.ash.monocode-hub";
export const DEV_CONFIG = [".monocode-hub-dev", "claude-config"] as const;
export const TARGET_FILE = "hivra-mirror.json";
export const RUNNING_FILE = "running.json";

function lib(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

export function dailyDataDir(home: string, platform: NodeJS.Platform): string {
  const p = lib(platform);
  if (platform === "win32") return p.join(home, "AppData", "Roaming", DAILY_ID);
  if (platform === "darwin") return p.join(home, "Library", "Application Support", DAILY_ID);
  return p.join(home, ".local", "share", DAILY_ID);
}

export function devConfigDir(home: string, platform: NodeJS.Platform): string {
  const p = lib(platform);
  return p.join(home, ...DEV_CONFIG);
}

export function personClaudeDir(home: string, platform: NodeJS.Platform): string {
  return lib(platform).join(home, ".claude");
}

/** A path is inside the person's Claude config when it is that folder or a child of it. */
export function insidePersonClaude(home: string, file: string, platform: NodeJS.Platform): boolean {
  const p = lib(platform);
  const root = p.normalize(personClaudeDir(home, platform));
  const target = p.normalize(file);
  const folded = platform === "win32" ? (value: string) => value.toLowerCase() : (value: string) => value;
  const rootKey = folded(root);
  const targetKey = folded(target);
  return targetKey === rootKey || targetKey.startsWith(rootKey + p.sep);
}

export function isDevConfigDir(home: string, dir: string, platform: NodeJS.Platform): boolean {
  const p = lib(platform);
  return p.normalize(dir) === p.normalize(devConfigDir(home, platform));
}

export function targetFile(configDir: string, platform: NodeJS.Platform): string {
  return lib(platform).join(configDir, TARGET_FILE);
}

/** `..` is never a segment we will read or write. Empty input is not a path. */
export function pathAllowed(file: string): boolean {
  if (!file.trim()) return false;
  const parts = file.split(/[/\\]/).filter((part) => part.length > 0);
  return parts.length > 0 && !parts.includes("..");
}
