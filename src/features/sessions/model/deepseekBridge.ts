// The model a Claude Code chat runs on the DeepSeek launcher (claudeDeepseekBridge.ts).
// The launcher holds every call to DeepSeek. A name it can't place is refused
// here, so it never reaches the gateway for another provider to take.

/** The launcher's name for DeepSeek. */
export const DEEPSEEK_BRIDGE_NATIVE = "deepseek-v4.1-flash";

/** The app's id for it: what a worker names when it runs on the launcher. */
export const DEEPSEEK_BRIDGE_MODEL_ID = `claude:${DEEPSEEK_BRIDGE_NATIVE}`;

export const DEEPSEEK_BRIDGE_NAME = "DeepSeek V4.1 Flash";

/** Workers on the DeepSeek launcher run on DeepSeek. */
export const WORKER_BRIDGE_MODEL_ID = DEEPSEEK_BRIDGE_MODEL_ID;

/** The catalog entry for that id. */
export const BRIDGE_MODEL_NAMES: Readonly<Record<string, { name: string; nativeId: string }>> = {
  [DEEPSEEK_BRIDGE_MODEL_ID]: { name: DEEPSEEK_BRIDGE_NAME, nativeId: DEEPSEEK_BRIDGE_NATIVE },
};

/** Which launcher Claude Code runs through. Only DeepSeek remains. */
export type BridgeKind = "deepseek";

/** A model the launcher can't run. Its message is plain words for the chat. */
export class BridgeModelError extends Error {
  constructor(
    readonly requested: string,
    readonly bridge: BridgeKind,
  ) {
    super(
      `"${requested}" can't run here: Claude Code runs through the DeepSeek launcher, which only runs DeepSeek. Pick DeepSeek for this chat. Nothing was sent.`,
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
 * Which family a requested model is: a Claude name (sonnet, opus, haiku, fable,
 * with or without a version) is a Claude alias; grok and deepseek names are
 * their own; anything else is unknown. Empty means no model was named.
 */
export function bridgeFamily(model: string | undefined): "none" | "claude" | "grok" | "deepseek" | "unknown" {
  const name = bare(model ?? "");
  if (!name || name === "default") return "none";
  const last = name.split("/").pop() ?? name;
  const own = last.replace(/^claude-/, "");
  if (/^grok(?:[-.]|$)/.test(own)) return "grok";
  if (/^deepseek(?:[-.]|$)/.test(own)) return "deepseek";
  if (last === "claude" || /^claude-/.test(last) || /^(?:sonnet|opus|haiku|fable)(?:$|[-.\d])/.test(last)) return "claude";
  return "unknown";
}

/**
 * The `--model` a Claude Code process on the DeepSeek launcher is started with.
 * Every name it understands runs as DeepSeek, including a Grok-family name.
 * Anything else throws BridgeModelError and is never passed through.
 */
export function bridgeLaunchModel(requested: string | undefined, bridge: BridgeKind): string {
  const family = bridgeFamily(requested);
  if (family === "unknown") throw new BridgeModelError((requested ?? "").trim(), bridge);
  return DEEPSEEK_BRIDGE_NATIVE;
}

/** The name the app shows for what a launcher chat really runs. */
export function bridgeModelName(requested: string | undefined, bridge: BridgeKind): string | undefined {
  try {
    return bridgeLaunchModel(requested, bridge) === DEEPSEEK_BRIDGE_NATIVE ? DEEPSEEK_BRIDGE_NAME : undefined;
  } catch {
    return undefined;
  }
}

/** True for a model a worker would name only out of habit: a Claude alias, or none. Never a custom model. */
export function isClaudeAliasModel(model: string | undefined): boolean {
  if (model && /^custom:/i.test(model.trim())) return false;
  const family = bridgeFamily(model);
  return family === "claude" || family === "none";
}
