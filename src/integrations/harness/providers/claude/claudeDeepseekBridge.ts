import { appIdentity } from "../../../../app/model/appIdentity";
import { runtimeProviderBinaryPath } from "../../../../features/providers/model/providerBinaryPaths";
import type { BridgeKind } from "../../../../features/sessions/model/deepseekBridge";

/**
 * The DeepSeek launcher, `claude-deepseek`: the normal Claude Code against a local
 * gateway, holding every call (helpers and subagents too) to DeepSeek. The launcher
 * keeps its key to itself.
 */
export const CLAUDE_DEEPSEEK_BRIDGE_NAME = "claude-deepseek";

function baseName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

type VerifyFlags = { deepseek?: boolean };

/**
 * True when Claude Code runs on the DeepSeek launcher: its CLI path's file name
 * is `claude-deepseek`, or this is the real bench on that launcher (plan
 * `deepseek`). A Claude account's sign-in then says nothing about whether a
 * worker can start, because no Claude Code process uses it.
 */
export function claudeRunsOnSubscriptionBridge(
  path: string | null = runtimeProviderBinaryPath("claude"),
  bench: VerifyFlags | undefined = appIdentity()?.verify,
): boolean {
  if (bench?.deepseek === true) return true;
  return !!path && baseName(path.trim()) === CLAUDE_DEEPSEEK_BRIDGE_NAME;
}

/** The DeepSeek launcher, or undefined on plain Claude Code. */
export function claudeBridgeKind(
  path: string | null = runtimeProviderBinaryPath("claude"),
  bench: VerifyFlags | undefined = appIdentity()?.verify,
): BridgeKind | undefined {
  return claudeRunsOnSubscriptionBridge(path, bench) ? "deepseek" : undefined;
}
