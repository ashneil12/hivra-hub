// WP-103: the real setting, saved to this page's own localStorage, so a reload shows what was kept. The models are
// seeded the way "Other models" writes them, metadata only.

import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { MemoryTierChoice } from "../../src/features/memory/ui/MemoryTierChoice";
import { saveMemoryTier, useMemoryTier } from "../../src/features/memory/model/tier";
import { customModelsVersion, listCustomModels, subscribeCustomModels } from "../../src/features/sessions/model/customModels";
import "../../src/styles/index.css";

if (!localStorage.getItem("monocode:custom-models")) {
  localStorage.setItem(
    "monocode:custom-models",
    JSON.stringify([
      { id: "xai-abc123", name: "Grok fast", provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: "grok-4-fast" },
      { id: "deepseek-def456", name: "DeepSeek chat", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-chat" },
    ]),
  );
}

function Harness() {
  const choice = useMemoryTier();
  useSyncExternalStore(subscribeCustomModels, customModelsVersion, customModelsVersion);
  return (
    <MemoryTierChoice
      value={choice}
      models={listCustomModels().map((model) => ({ id: model.id, name: model.name }))}
      onChange={saveMemoryTier}
      // No Keychain here: the stand-in answers the way the provider would, in the same plain words.
      test={async (modelId) =>
        modelId === "deepseek-def456"
          ? { ok: true, message: "Connected, deepseek-chat replied" }
          : { ok: false, message: "That key didn't work" }
      }
    />
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
