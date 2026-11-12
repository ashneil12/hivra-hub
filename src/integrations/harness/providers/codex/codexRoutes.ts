// "Connect any model to any harness": the saved Other models in Codex. Rust adds one Codex provider per saved model
// (`-c model_providers.dropwave-<id>=…`, src-tauri/src/pi_routes.rs) that speaks OpenAI Responses to the app's router;
// the key stays in the app. Here: which saved models Codex can use, how they appear in its picker, and how a picked
// one becomes Codex's provider and model.
import {
  piModelRoutes,
  type CustomModelRoute,
} from "../../../../features/sessions/model/customModels";
import type { AgentModel } from "../../../../features/sessions/model/models";

/** Providers that answer OpenAI Responses, which Codex speaks. DeepSeek has chat completions only. */
const RESPONSES_PROVIDERS = new Set(["xai", "openrouter", "ollama", "custom"]);

/** The provider name Rust gives a saved model (pi_routes.rs `provider_name`). */
export function routedProviderName(customModelId: string): string {
  return `dropwave-${customModelId.replace(/[^A-Za-z0-9]/g, "-").toLowerCase()}`;
}

/** The saved models Codex is started with. */
export function codexModelRoutes(): CustomModelRoute[] {
  return piModelRoutes().filter((route) => RESPONSES_PROVIDERS.has(route.provider));
}

/** The saved models as entries in Codex's model list. */
export function codexRoutedModels(): AgentModel[] {
  return codexModelRoutes().map((route) => {
    const nativeId = `${routedProviderName(route.customModelId)}/${route.modelId}`;
    return {
      id: `codex:${nativeId}`,
      harness: "codex",
      name: `${route.modelId} (your key)`,
      nativeId,
      provider: { id: routedProviderName(route.customModelId), name: "Your saved models" },
    };
  });
}

/** A picked model: Codex's own (`gpt-5`) passes as it is; a saved one splits into its provider and model. */
export function splitRoutedModel(native: string | undefined): {
  model: string | undefined;
  provider?: string;
} {
  const match = native?.trim().match(/^(dropwave-[a-z0-9-]+)\/(.+)$/);
  if (!match) return { model: native };
  return { provider: match[1], model: match[2] };
}
