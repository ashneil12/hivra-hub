import { invoke } from "@tauri-apps/api/core";
import { appIdentity } from "../../../../app/model/appIdentity";
import { runtimeProviderBinaryPath } from "../../../../features/providers/model/providerBinaryPaths";
import { customModelRoute } from "../../../../features/sessions/model/customModels";
import { bridgeFamily, GROK_BRIDGE_NATIVE, unavailableNote, type BridgeKind } from "../../../../features/sessions/model/bridgeModels";

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
export const GROK_BRIDGE_MODEL = GROK_BRIDGE_NATIVE;

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

/**
 * The DeepSeek launcher, `~/.local/bin/claude-deepseek`: the normal Claude Code against Ash's local gateway, holding
 * every call (helpers and subagents too) to DeepSeek. Like the Grok one it keeps its key to itself.
 */
export const CLAUDE_DEEPSEEK_BRIDGE_NAME = "claude-deepseek";

/**
 * True when Claude Code runs on a subscription bridge of any kind (Grok or DeepSeek): its CLI path is one of the
 * bridge launchers, or this is the real bench on one (plan `grok` or `deepseek`). Then a Claude account's sign-in and
 * limits say nothing about whether a worker can start, because no Claude Code process uses them (27 Oct: the blind
 * run on DeepSeek left every delegated worker waiting on "Claude isn't signed in"). Names and labels still follow
 * claudeRunsOnGrok: a DeepSeek chat is not Grok 4.7.
 */
export function claudeRunsOnSubscriptionBridge(
  path: string | null = runtimeProviderBinaryPath("claude"),
  bench: VerifyFlags | undefined = appIdentity()?.verify,
): boolean {
  if (claudeRunsOnGrok(path, bench?.grok === true)) return true;
  if (bench?.deepseek === true) return true;
  return !!path && baseName(path.trim()) === CLAUDE_DEEPSEEK_BRIDGE_NAME;
}

type VerifyFlags = { grok?: boolean; deepseek?: boolean };

/** Which bridge Claude Code runs through, or undefined on the plain Claude Code (bridgeModels.ts bridgeLaunchModel). */
export function claudeBridgeKind(
  path: string | null = runtimeProviderBinaryPath("claude"),
  bench: VerifyFlags | undefined = appIdentity()?.verify,
): BridgeKind | undefined {
  if (claudeRunsOnGrok(path, bench?.grok === true)) return "grok";
  return claudeRunsOnSubscriptionBridge(path, bench) ? "deepseek" : undefined;
}

/** What a Claude Code chat on the bridge really runs, as the hub names it (GROK_BRIDGE_MODEL). */
export const GROK_BRIDGE_LABEL = "Grok 4.7";

/**
 * A chat that leaves the bridge (Ash, 21 Oct 21:03: "both things"): one set explicitly to a non-Grok model under Other
 * models (DeepSeek, OpenRouter's non-Grok models, Ollama, a custom one). It starts on the plain Claude Code with the
 * hub's router and that model's own key, so the provider choice is honoured (E7's DeepSeek default included). Every
 * other Claude Code chat (Claude models, which are only labels on the bridge, and a Grok model of any provider) stays on
 * the bridge's forced grok-4.7. Never reads or holds a key: the route is metadata, the key stays in the Keychain.
 */
export function routedOffBridge(target: { model?: string; modelSettings?: Record<string, string> }): boolean {
  const route = customModelRoute({ model: target.model ?? "", modelSettings: target.modelSettings ?? {} });
  return !!route && route.provider !== "xai" && !/grok/i.test(route.modelId);
}

/**
 * Whether this chat (by its model) runs on the bridge's Grok 4.7: Claude Code is on the bridge, it isn't routed off,
 * and it doesn't name DeepSeek.
 */
export function chatOnGrokBridge(target: { model?: string; modelSettings?: Record<string, string> } = {}): boolean {
  // A DeepSeek name stays on the bridge but runs as DeepSeek there (bridgeLaunchModel), so it isn't shown as Grok 4.7.
  return claudeRunsOnGrok() && !routedOffBridge(target) && bridgeFamily(target.model) !== "deepseek";
}

/**
 * True when a chat on this harness runs on the bridge (so its Claude model name and mark aren't what runs). Given the
 * chat's model, a non-Grok Other model is not on the bridge (routedOffBridge).
 */
export function onGrokBridge(harness: string | undefined, model?: string): boolean {
  return harness === "claude" && chatOnGrokBridge({ model });
}

/**
 * The model a chat really runs, by name: Grok 4.7 for a Claude Code chat on the bridge, whatever Claude model it names;
 * otherwise the name given. The one source the model line and the transcript's turn header both read.
 */
export function modelInUseLabel(harness: string | undefined, name: string | undefined, model?: string): string | undefined {
  return name && onGrokBridge(harness, model) ? GROK_BRIDGE_LABEL : name;
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

/** A chat's model name wherever the app shows it (session rows, cards, tabs): Grok 4.7 for Claude Code on Grok. */
export function shownModelName(harness: string, name: string, onGrok: boolean = claudeRunsOnGrok()): string {
  return harness === "claude" && onGrok ? GROK_BRIDGE_LABEL : name;
}

/**
 * A Claude Code model's name in the composer's pill. On Grok it is Grok 4.7, whatever model the chat had saved (S14 on
 * Grok showed the gateway's own label for claude-sonnet-5, "Gemini 4 Argon", though the chat ran on grok-4.7).
 */
export function claudePillName(name: string, onGrok: boolean = claudeRunsOnGrok()): string {
  // A worker on the bridge's DeepSeek says so (bridgeModels.ts); anything else there runs as Grok 4.7.
  if (onGrok) return /deepseek/i.test(name) ? name : GROK_BRIDGE_LABEL;
  return name.replace(/^Claude /, "");
}

/** The model a chat really ran, and (when it asked for another) the quiet reason shown after it. */
export type RanModel = { name: string; note?: string };

/**
 * r90 (Ash, Critiquito): every place that names a worker's model (the Lead's text, the worker card, the sub-chat row)
 * shows what actually ran, from the hub's own record of the chat's model and how this app runs Claude Code. On the
 * Grok bench every Claude Code call runs on Grok 4.7, so a chat recorded as DeepSeek reads "Grok 4.7" with
 * "DeepSeek wasn't available" after it. `shown` is the name the surface would show from the record alone.
 */
export function ranModel(
  harness: string,
  shown: string,
  bench: boolean = appIdentity()?.verify?.grok === true,
): RanModel {
  if (harness === "claude" && bench && shown !== GROK_BRIDGE_LABEL) return { name: GROK_BRIDGE_LABEL, note: unavailableNote(shown) };
  return { name: shown };
}

/** A RanModel as one line of text ("Grok 4.7 · DeepSeek wasn't available"). */
export function ranModelText(ran: RanModel): string {
  return ran.note ? `${ran.name} · ${ran.note}` : ran.name;
}
