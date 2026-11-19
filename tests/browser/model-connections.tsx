import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setHarnessAvailability } from "../../src/integrations/harness/core/availabilityState";
import { ModelConnectionsSetting } from "../../src/features/settings/ui/ModelConnectionsSetting";
import "../../src/styles/index.css";

const params = new URLSearchParams(window.location.search);
const none = params.has("none");
setHarnessAvailability({
  claude: !none, codex: false, cursor: !none, grok: false, opencode: false, pi: false,
  omp: !none, fx: false, hermes: false, antigravity: false, devin: false,
});
localStorage.setItem(
  "monocode:custom-models",
  JSON.stringify([
    { id: "m1", name: "Example: Grok", provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: "grok-example" },
  ]),
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ModelConnectionsSetting />
  </StrictMode>,
);
