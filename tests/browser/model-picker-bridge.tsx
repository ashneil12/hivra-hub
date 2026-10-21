// E7 fixture (browser proof only): the real model picker on a chat whose Claude Code runs through the Grok bridge,
// with two Other models saved. Made-up entries; no keys, no network.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import "../../src/styles/index.css";

mockWindows("main");
mockIPC(() => undefined, { shouldMockEvents: true });
// Before the app's modules load: Claude Code's binary is the bridge, and two Other models are saved.
localStorage.setItem("monocode.providerBinaryPaths.v1", JSON.stringify({ claude: "/usr/local/bin/claude-grok" }));
localStorage.setItem("monocode:custom-models", JSON.stringify([
  { id: "ds", name: "DeepSeek V4", provider: "deepseek", baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4" },
  { id: "or", name: "Qwen Coder", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", modelId: "qwen/qwen-coder" },
]));

const [{ useState }, { createRoot }, { ModelPicker }, { setHarnessModels }] = await Promise.all([
  import("react"),
  import("react-dom/client"),
  import("../../src/features/sessions/ui/ModelPicker"),
  import("../../src/features/sessions/model/models"),
]);
setHarnessModels("claude", [{ id: "claude:opus-5-5", harness: "claude", name: "Claude Opus 5.5", nativeId: "claude-opus-5-5" }]);

function Fixture() {
  const [model, setModel] = useState(new URLSearchParams(location.search).get("model") ?? "claude:opus-5-5");
  return (
    <div data-fixture-model={model}>
      <ModelPicker harness="claude" model={model} values={{}} hideSettings onChange={(_h: string, m: string) => setModel(m)} onSettingsChange={() => {}} />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
