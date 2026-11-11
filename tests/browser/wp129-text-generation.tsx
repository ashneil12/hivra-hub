// WP-129: the real short text setting, on its own. `?others` also shows the Other models list (its saved addresses).
import { createRoot } from "react-dom/client";
import { TextGenerationSetting } from "../../src/features/settings/ui/TextGenerationSetting";
import { OtherModelsSection } from "../../src/features/sessions/ui/CustomModels";
import {
  createDevModelKeyStore,
  listCustomModels,
  setModelKeyStore,
} from "../../src/features/sessions/model/customModels";
import "../../src/styles/index.css";

const others = new URLSearchParams(location.search).has("others");

async function main() {
  if (others) {
    // A saved key keeps the address it was saved with (Rust, in the Keychain). The browser stand-in store starts empty,
    // so each saved model's key is saved here with its address, the way the app saves one.
    const store = createDevModelKeyStore();
    setModelKeyStore(store);
    for (const m of listCustomModels()) {
      await store.saveModelKey(m.id, "sk-fixture-key-0001", {
        provider: m.provider,
        modelId: m.modelId,
        baseUrl: m.baseUrl,
      });
    }
  }
  createRoot(document.getElementById("root")!).render(
    others ? (
      <OtherModelsSection query="" currentModel="" onPick={() => undefined} onAdd={() => undefined} />
    ) : (
      <TextGenerationSetting />
    ),
  );
}

void main();
