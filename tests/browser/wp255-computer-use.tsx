// WP-255: Settings > Computer use beside the sandbox switch it sits under, with the app's answers stubbed. The stub keeps
// the settings in the page and records each call, so the spec can read what the screen asked the app to write.
import { createRoot } from "react-dom/client";
import { AgentSandboxSetting } from "../../src/features/settings/ui/AgentSandboxSetting";
import { ComputerUseSetting } from "../../src/features/computerUse/ui/ComputerUseSetting";
import "../../src/styles/index.css";

type Settings = {
  enabled: boolean;
  mode: "observe" | "control";
  allowedApps: string[];
  allowCoordinates: boolean;
  chats: Record<string, string>;
};

const calls: { command: string; args: unknown }[] = [];
const installed = new URLSearchParams(location.search).has("installed");
let settings: Settings = { enabled: false, mode: "observe", allowedApps: [], allowCoordinates: false, chats: { "chat-7f2a": "observe-only" } };
const view = () => ({
  settings,
  settingsPath: "/data/computer-use.json",
  sidecar: installed ? "/opt/homebrew/bin/open-computer-use" : null,
  supported: true,
});

Object.assign(window, {
  __wp255Calls: calls,
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (command: string, args?: unknown) => {
      if (command === "plugin:event|listen") return 0;
      calls.push({ command, args });
      if (command === "agent_sandbox_status") return { supported: true, enabled: false, setByEnvironment: false };
      if (command === "computer_use_get") return view();
      if (command === "computer_use_put") {
        settings = { ...settings, ...(args as { change: Partial<Settings> }).change };
        return view();
      }
      if (command === "computer_use_set_chat") {
        const { chat, mode } = args as { chat: string; mode: string | null };
        const chats = { ...settings.chats };
        if (mode) chats[chat] = mode;
        else delete chats[chat];
        settings = { ...settings, chats };
        return view();
      }
      if (command === "computer_use_activity")
        return [
          { at: Date.UTC(2026, 10, 12, 13, 4), chat: "chat-7f2a", tool: "computer_get_app_state", app: "Notes", detail: "get app state", allowed: true },
          { at: Date.UTC(2026, 10, 12, 13, 3), chat: "chat-7f2a", tool: "computer_get_app_state", app: "1Password", detail: "get app state", allowed: false },
        ];
      if (command === "computer_use_check") return { ok: true, output: "Accessibility: granted\nScreen Recording: granted" };
      return null;
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <div className="rounded-lg border border-content/10">
    <AgentSandboxSetting />
    <ComputerUseSetting />
  </div>,
);
