import { invoke } from "@tauri-apps/api/core";
import { appIdentity } from "../../../../app/model/appIdentity";
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

/**
 * True when Claude Code runs on Grok 4.7: its CLI path (as this run of the app uses it) is the bridge launcher, or
 * this is the real bench on the bridge (its plan's `grok`, verify_live.rs), whose wrapper has to be named claude.
 */
export function claudeRunsOnGrok(
  path: string | null = runtimeProviderBinaryPath("claude"),
  bench: boolean = appIdentity()?.verify?.grok === true,
): boolean {
  return bench || (!!path && baseName(path.trim()) === CLAUDE_GROK_BRIDGE_NAME);
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

/** What the model pill says for a Claude Code chat on Grok: every Claude Code chat runs on Grok 4.7 then. */
export const GROK_BRIDGE_LABEL = "Grok 4.7";

/**
 * A Claude Code model's name in the composer's pill. On Grok it is Grok 4.7, whatever model the chat had saved (S14 on
 * Grok showed the gateway's own label for claude-sonnet-5, "Gemini 4 Argon", though the chat ran on grok-4.7).
 */
export function claudePillName(name: string, onGrok: boolean = claudeRunsOnGrok()): string {
  return onGrok ? GROK_BRIDGE_LABEL : name.replace(/^Claude /, "");
}
