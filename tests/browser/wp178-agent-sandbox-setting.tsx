// WP-178: the Settings switch for the macOS agent sandbox, with the app's answers stubbed. The stub keeps the switch
// state in the page and records each call, so the spec can read what the switch asked the app to write.
import { createRoot } from "react-dom/client";
import { AgentSandboxSetting } from "../../src/features/settings/ui/AgentSandboxSetting";
import "../../src/styles/index.css";

const calls: { command: string; args: unknown }[] = [];
let enabled = false;

Object.assign(window, {
  __wp178Calls: calls,
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (command: string, args?: unknown) => {
      if (command === "plugin:event|listen") return 0;
      calls.push({ command, args });
      if (command === "agent_sandbox_status") return { supported: true, enabled, setByEnvironment: false };
      if (command === "agent_sandbox_set") {
        enabled = Boolean((args as { enabled?: unknown }).enabled);
        return { supported: true, enabled, setByEnvironment: false };
      }
      return null;
    },
  },
});

createRoot(document.getElementById("root")!).render(<AgentSandboxSetting />);
