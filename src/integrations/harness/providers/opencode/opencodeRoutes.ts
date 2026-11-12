// "Connect any model to any harness": the saved Other models in OpenCode 1.x. Rust adds one OpenCode provider per saved
// model to the `opencode serve` it starts (`OPENCODE_CONFIG_CONTENT`, src-tauri/src/pi_routes.rs), on OpenCode's own
// Anthropic SDK pointed at the app's router; the key stays in the app. OpenCode 2 runs as one shared background
// service, so it can't be handed a per-chat route and keeps its own provider settings for now.
import { piModelRoutes } from "../../../../features/sessions/model/customModels";
import type { AgentModel } from "../../../../features/sessions/model/models";
import { spawnChild } from "../../core/child";
import { routedProviderName } from "../codex/codexRoutes";

/** The saved models as entries in OpenCode's model list (its `provider/model` ids). */
export function opencodeRoutedModels(): AgentModel[] {
  return piModelRoutes().map((route) => {
    const provider = routedProviderName(route.customModelId);
    const nativeId = `${provider}/${route.modelId}`;
    return {
      id: `opencode:${nativeId}`,
      harness: "opencode",
      name: `${route.modelId} (your key)`,
      nativeId,
      provider: { id: provider, name: "Your saved models" },
    };
  });
}

/** Start `opencode serve` with the saved models offered through the router. With none saved it is the plain start. */
export function spawnOpenCodeServer(sessionId: string, command: string, args: string[], cwd: string): Promise<void> {
  const routes = piModelRoutes();
  if (routes.length === 0) return spawnChild(sessionId, command, args, cwd, undefined, "opencode");
  return spawnChild(
    sessionId,
    command,
    args,
    cwd,
    undefined,
    "opencode",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    routes,
  );
}
