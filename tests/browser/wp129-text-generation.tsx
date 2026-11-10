// WP-129: the real short text setting, on its own. `?others` also shows the Other models list (its saved addresses).
import { createRoot } from "react-dom/client";
import { TextGenerationSetting } from "../../src/features/settings/ui/TextGenerationSetting";
import { OtherModelsSection } from "../../src/features/sessions/ui/CustomModels";
import "../../src/styles/index.css";

const others = new URLSearchParams(location.search).has("others");
createRoot(document.getElementById("root")!).render(
  others ? (
    <OtherModelsSection query="" currentModel="" onPick={() => undefined} onAdd={() => undefined} />
  ) : (
    <TextGenerationSetting />
  ),
);
