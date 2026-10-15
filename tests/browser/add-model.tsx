import { useState } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { ModelPicker } from "../../src/features/sessions/ui/ModelPicker";
import { setHarnessModels } from "../../src/features/sessions/model/models";
import "../../src/styles/index.css";

// The real model picker with the dev (in-memory) key store; no Keychain, no network.
mockWindows("main");
mockIPC(() => undefined, { shouldMockEvents: true });
setHarnessModels("claude", [{ id: "claude:opus-5-5", harness: "claude", name: "Claude Opus 5.5", nativeId: "claude-opus-5-5" }]);

function Fixture() {
  const [model, setModel] = useState("claude:opus-5-5");
  return <ModelPicker harness="claude" model={model} values={{}} hideSettings onChange={(_h: string, m: string) => setModel(m)} onSettingsChange={() => {}} />;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
