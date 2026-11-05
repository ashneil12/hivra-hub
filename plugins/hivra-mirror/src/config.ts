// WP-85. Where this copy keeps its data. A dev copy never falls back to the daily folder.

import { dailyDataDir, isDevConfigDir, pathAllowed } from "./paths.ts";

export type DataDir =
  | { ok: true; dir: string }
  | { ok: false; retry: true; reason: string };

export function resolveDataDir(opts: {
  home: string;
  platform: NodeJS.Platform;
  kind: "daily" | "dev";
  configDir?: string;
  target: unknown;
}): DataDir {
  if (opts.kind === "daily") return { ok: true, dir: dailyDataDir(opts.home, opts.platform) };
  if (!opts.configDir || !isDevConfigDir(opts.home, opts.configDir, opts.platform)) {
    return { ok: false, retry: true, reason: "no dev config" };
  }
  if (!opts.target || typeof opts.target !== "object" || Array.isArray(opts.target)) {
    return { ok: false, retry: true, reason: "no dev target" };
  }
  const dataDir = (opts.target as { dataDir?: unknown }).dataDir;
  if (typeof dataDir !== "string" || !dataDir.trim() || !pathAllowed(dataDir)) {
    return { ok: false, retry: true, reason: "no dev target" };
  }
  return { ok: true, dir: dataDir };
}

export function kindFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  platform: NodeJS.Platform,
): "daily" | "dev" {
  const dir = env.CLAUDE_CONFIG_DIR;
  if (typeof dir !== "string" || !dir.trim()) return "daily";
  return isDevConfigDir(home, dir, platform) ? "dev" : "daily";
}
