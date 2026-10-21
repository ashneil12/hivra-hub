import { invoke } from "@tauri-apps/api/core";
import { runtimeProviderBinaryPath } from "../../../../features/providers/model/providerBinaryPaths";

/**
 * Claude Code on Grok 4.7 through Ash's Grok (SuperGrok / X Premium+) subscription.
 *
 * The Mac has a launcher, `~/.local/bin/claude-grok`, that starts the normal Claude Code against a local gateway
 * which signs in to Grok with the subscription (no API key, no per-token bill). The hub only points Claude Code's
 * CLI path at that launcher and asks every Claude Code process for Grok 4.7. It never reads the gateway's key or
 * the Grok sign-in: the launcher keeps both to itself.
 */
export const CLAUDE_GROK_BRIDGE_NAME = "claude-grok";
/** The model every Claude Code process asks for on the bridge; the launcher maps it to the gateway's Grok 4.7. */
export const GROK_BRIDGE_MODEL = "grok-4.7";

function baseName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

/** True when Claude Code runs on Grok 4.7: its CLI path (as this run of the app uses it) is the bridge launcher. */
export function claudeRunsOnGrok(path: string | null = runtimeProviderBinaryPath("claude")): boolean {
  return !!path && baseName(path.trim()) === CLAUDE_GROK_BRIDGE_NAME;
}

/** Grok 4.7 takes low, medium, high or xhigh. Claude-only levels step down to the nearest one Grok has. */
export function grokBridgeEffort(effort: string | undefined): string | undefined {
  if (!effort) return undefined;
  if (effort === "max" || effort === "ultracode") return "xhigh";
  if (effort === "minimal" || effort === "none") return "low";
  return effort;
}

/** The launcher's path on this Mac, or null when it isn't installed. Presence only. */
export async function findClaudeGrokBridge(): Promise<string | null> {
  try {
    const path = await invoke<string | null>("harness_claude_grok_bridge");
    return typeof path === "string" && path.trim() ? path.trim() : null;
  } catch {
    return null;
  }
}
