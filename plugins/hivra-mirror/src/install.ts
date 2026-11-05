// WP-85. Turning the mirror on installs the plugin with `claude plugin install`, once.
// The command's environment is an allow-list. A dev copy's config is the dev folder, never ~/.claude.

import { devConfigDir, insidePersonClaude } from "./paths.ts";

export type MirrorSetting = { enabled: boolean; installed: boolean; version: number };

export type MirrorCommand = { program: "claude"; args: string[]; env: Record<string, string> };

export type InstallPlan = {
  stale: boolean;
  command: MirrorCommand | null;
  next: MirrorSetting;
  preview: readonly string[];
  retry: boolean;
};

export const INSTALL_PREVIEW = [
  "Plugin hivra-mirror",
  "Hooks: SessionStart, UserPromptSubmit, PostToolUse, PermissionRequest, Stop",
  "Connects only to this Hivra on this Mac",
  "No login and no token",
  "Stays off in sessions Hivra started",
] as const;

const ENV_ALLOW = new Set(["PATH", "Path", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "PATHEXT"]);

export function defaultSetting(): MirrorSetting {
  return { enabled: false, installed: false, version: 0 };
}

export function commandEnv(
  kind: "daily" | "dev",
  home: string,
  platform: NodeJS.Platform,
  inherited: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (typeof value !== "string") continue;
    if (!ENV_ALLOW.has(key)) continue;
    env[key] = value;
  }
  if (!env.HOME && !env.USERPROFILE) env.HOME = home;
  if (kind === "dev") env.CLAUDE_CONFIG_DIR = devConfigDir(home, platform);
  return env;
}

/** True when a command environment would touch the person's Claude config or settings.json. */
export function touchesPersonClaude(
  home: string,
  env: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): boolean {
  return Object.entries(env).some(([key, value]) => {
    if (key === "HOME" || key === "USERPROFILE" || key === "PATH" || key === "Path") return false;
    if (value.endsWith("settings.json")) return true;
    return insidePersonClaude(home, value, platform);
  });
}

/**
 * The plan describes the command. The caller runs it and only then keeps `next`.
 * A failed command is not final: pass the same setting again.
 */
export function planChange(
  state: MirrorSetting,
  enabled: boolean,
  expectedVersion: number,
  ctx: {
    home: string;
    kind: "daily" | "dev";
    platform: NodeJS.Platform;
    pluginDir: string;
    inherited: Readonly<Record<string, string | undefined>>;
  },
): InstallPlan {
  const preview = INSTALL_PREVIEW;
  if (expectedVersion !== state.version) {
    return { stale: true, command: null, next: state, preview, retry: true };
  }
  if (enabled && state.enabled && state.installed) {
    return { stale: false, command: null, next: state, preview, retry: false };
  }
  if (!enabled && !state.enabled && !state.installed) {
    return { stale: false, command: null, next: state, preview, retry: false };
  }
  const env = commandEnv(ctx.kind, ctx.home, ctx.platform, ctx.inherited);
  if (enabled && state.installed) {
    return {
      stale: false,
      command: null,
      next: { enabled: true, installed: true, version: state.version + 1 },
      preview,
      retry: false,
    };
  }
  if (enabled) {
    return {
      stale: false,
      command: { program: "claude", args: ["plugin", "install", ctx.pluginDir], env },
      next: { enabled: true, installed: true, version: state.version + 1 },
      preview,
      retry: false,
    };
  }
  return {
    stale: false,
    command: { program: "claude", args: ["plugin", "uninstall", "hivra-mirror"], env },
    next: { enabled: false, installed: false, version: state.version + 1 },
    preview,
    retry: false,
  };
}

/** Keep the planned setting only when the command finished. A failure leaves the old one, so it can be tried again. */
export function commitPlan(state: MirrorSetting, plan: InstallPlan, ok: boolean): MirrorSetting {
  if (plan.stale || !ok) return state;
  return plan.next;
}
