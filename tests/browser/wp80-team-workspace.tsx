// WP-80: the real "Share projects with my team" setting on its own. Only native IPC is fake: the switch, the address
// and the joined state live in localStorage, the way the app keeps them in its data folder. Nothing is sent anywhere.
import { createRoot } from "react-dom/client";
import { TeamWorkspaceSetting } from "../../src/features/settings/ui/TeamWorkspaceSetting";
import "../../src/styles/index.css";

const KEY = "wp80.team-workspace.fixture";

type Saved = { enabled: boolean; endpoint: string; signedIn: boolean };

function read(): Saved {
  try {
    return { enabled: false, endpoint: "", signedIn: false, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { enabled: false, endpoint: "", signedIn: false };
  }
}

function status(saved: Saved) {
  const endpointConfigured = saved.endpoint.trim() !== "";
  return {
    enabled: saved.enabled,
    endpoint: saved.endpoint,
    endpointConfigured,
    signedIn: saved.signedIn,
    active: saved.enabled && endpointConfigured && saved.signedIn,
  };
}

function refuse(endpoint: string): string | null {
  if (!endpoint) return null;
  const https = endpoint.startsWith("https://");
  const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(endpoint);
  return https || local ? null : "the endpoint must be https, or http on this machine";
}

Object.assign(window, {
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (command: string, args: Record<string, unknown> = {}) => {
      if (command === "plugin:event|listen") return 0;
      if (command === "plugin:event|unlisten") return;
      if (command === "team_workspace_status") return status(read());
      if (command === "team_workspace_presence") return [];
      if (command === "team_workspace_save") {
        const endpoint = String(args.endpoint ?? "").trim();
        const problem = refuse(endpoint);
        if (problem) throw problem;
        const next = { ...read(), enabled: Boolean(args.enabled), endpoint };
        localStorage.setItem(KEY, JSON.stringify(next));
        return status(next);
      }
      if (command === "team_workspace_accept") {
        const saved = read();
        if (!saved.enabled) throw "team workspaces are off; turn them on first";
        if (!String(args.invitation ?? "")) throw "this invitation is invalid or has expired";
        const next = { ...saved, signedIn: true };
        localStorage.setItem(KEY, JSON.stringify(next));
        return status(next);
      }
      throw new Error(`unexpected command in the fixture: ${command}`);
    },
  },
});

createRoot(document.getElementById("root")!).render(<TeamWorkspaceSetting />);
