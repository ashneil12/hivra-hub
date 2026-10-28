// The models a Claude Code chat can run on Ash's subscription bridges (claudeGrokBridge.ts): Grok 4.7 and DeepSeek,
// nothing else (Ash, 27 Oct: no Claude subscription anywhere). The launchers turn these names into the gateway's own
// aliases: `claude-grok` maps grok-4.7 to Grok and deepseek-v4.1-flash to DeepSeek; `claude-deepseek` holds every call
// to DeepSeek. A name the launcher doesn't know goes to the gateway as it is, and the gateway may route it to another
// provider (14 Oct: claude-sonnet-5 went to a third party), so the app only ever passes one of these two names on a
// bridge, and refuses with a visible error any model it can't place (bridgeLaunchModel).

/** The launcher's name for Grok 4.7. */
export const GROK_BRIDGE_NATIVE = "grok-4.7";
/** The launcher's name for DeepSeek. */
export const DEEPSEEK_BRIDGE_NATIVE = "deepseek-v4.1-flash";

/** The app's ids for them: what a Mono, a Lead or a worker names when it runs on a bridge. */
export const GROK_BRIDGE_MODEL_ID = `claude:${GROK_BRIDGE_NATIVE}`;
export const DEEPSEEK_BRIDGE_MODEL_ID = `claude:${DEEPSEEK_BRIDGE_NATIVE}`;

export const GROK_BRIDGE_NAME = "Grok 4.7";
export const DEEPSEEK_BRIDGE_NAME = "DeepSeek V4.1 Flash";

/** Monos and Leads run on Grok 4.7; workers on DeepSeek. */
export const MONO_BRIDGE_MODEL_ID = GROK_BRIDGE_MODEL_ID;
export const WORKER_BRIDGE_MODEL_ID = DEEPSEEK_BRIDGE_MODEL_ID;

/** The catalog entries for the two ids, by id. */
export const BRIDGE_MODEL_NAMES: Readonly<Record<string, { name: string; nativeId: string }>> = {
  [GROK_BRIDGE_MODEL_ID]: { name: GROK_BRIDGE_NAME, nativeId: GROK_BRIDGE_NATIVE },
  [DEEPSEEK_BRIDGE_MODEL_ID]: { name: DEEPSEEK_BRIDGE_NAME, nativeId: DEEPSEEK_BRIDGE_NATIVE },
};

/**
 * r61 (Alfred): a Claude Code model kept from before the bridges (the real app still stored `claude:sonnet-5` as its
 * default) is read as Grok 4.7, so no stored value can name an Anthropic model. Any other harness or name is as it was.
 */
export function bridgeSafeModel(harness: string | undefined, model: string): string {
  return harness === "claude" && bridgeFamily(model) === "claude" ? GROK_BRIDGE_MODEL_ID : model;
}

/** Which bridge Claude Code runs through. */
export type BridgeKind = "grok" | "deepseek";

/** A model a bridge can't run. Its message is plain words for the chat. */
export class BridgeModelError extends Error {
  constructor(
    readonly requested: string,
    readonly bridge: BridgeKind,
  ) {
    super(
      `"${requested}" can't run here: Claude Code runs through the ${bridge === "grok" ? "Grok" : "DeepSeek"} bridge, which only runs ${
        bridge === "grok" ? `${GROK_BRIDGE_NAME} and DeepSeek` : "DeepSeek"
      }. Pick ${bridge === "grok" ? `${GROK_BRIDGE_NAME} or DeepSeek` : "DeepSeek"} for this chat. Nothing was sent.`,
    );
    this.name = "BridgeModelError";
  }
}

/** The bare name, without the app's `claude:` prefix or a `[1m]`-style context suffix, lower case. */
function bare(model: string): string {
  return model
    .trim()
    .replace(/^claude:/i, "")
    .replace(/\[[^\]]*\]$/, "")
    .trim()
    .toLowerCase();
}

/**
 * Which family a requested model is, as the bridge sees it: any Claude name (sonnet, opus, haiku, fable, with or
 * without a version or the `claude-` prefix, or a provider path ending in one) is a Claude alias; grok and deepseek
 * names are their own; anything else is unknown. Empty means no model was named.
 */
export function bridgeFamily(model: string | undefined): "none" | "claude" | "grok" | "deepseek" | "unknown" {
  const name = bare(model ?? "");
  if (!name || name === "default") return "none";
  const last = name.split("/").pop() ?? name;
  // The app's native-id step puts `claude-` in front of any versioned slug (claude:grok-4.7 -> claude-grok-4-7).
  const own = last.replace(/^claude-/, "");
  if (/^grok(?:[-.]|$)/.test(own)) return "grok";
  if (/^deepseek(?:[-.]|$)/.test(own)) return "deepseek";
  if (last === "claude" || /^claude-/.test(last) || /^(?:sonnet|opus|haiku|fable)(?:$|[-.\d])/.test(last)) return "claude";
  // Anthropic's older ids put the family after the version: claude-3-5-sonnet-latest is caught above by its prefix.
  return "unknown";
}

/**
 * The `--model` a Claude Code process on a bridge is started with. Every Claude alias runs as the bridge's own model
 * (Grok 4.7 on the Grok bridge, DeepSeek on the DeepSeek one), a Grok name as Grok 4.7, a DeepSeek name as DeepSeek.
 * The DeepSeek launcher holds every call to DeepSeek, so a Grok name there runs as DeepSeek too. Anything else throws
 * BridgeModelError: it is never passed through, so the gateway can't route it to another provider.
 */
export function bridgeLaunchModel(requested: string | undefined, bridge: BridgeKind): string {
  const family = bridgeFamily(requested);
  if (family === "unknown") throw new BridgeModelError((requested ?? "").trim(), bridge);
  if (bridge === "deepseek") return DEEPSEEK_BRIDGE_NATIVE;
  return family === "deepseek" ? DEEPSEEK_BRIDGE_NATIVE : GROK_BRIDGE_NATIVE;
}

/** The name the app shows for what a bridge chat really runs (the label every model line reads). */
export function bridgeModelName(requested: string | undefined, bridge: BridgeKind): string | undefined {
  try {
    return bridgeLaunchModel(requested, bridge) === DEEPSEEK_BRIDGE_NATIVE ? DEEPSEEK_BRIDGE_NAME : GROK_BRIDGE_NAME;
  } catch {
    return undefined;
  }
}

/** True for a model a Mono or worker would name only out of habit: a Claude alias, or none. Never Ash's own models. */
export function isClaudeAliasModel(model: string | undefined): boolean {
  if (model && /^custom:/i.test(model.trim())) return false;
  const family = bridgeFamily(model);
  return family === "claude" || family === "none";
}
