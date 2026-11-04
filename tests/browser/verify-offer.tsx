import { createRoot } from "react-dom/client";
import { SOURCES_KEY } from "../../src/features/plugins/model/discover";
import { PluginsPage } from "../../src/features/plugins/ui/DiscoverPage";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

// WP-42. The real Plugins page, offered Verify for one project folder. Nothing installs until Install is pressed.
const FOLDER = "/code/sample web";
const calls: { command: string; args: Record<string, unknown> }[] = [];

installFakeTauri("verify-offer", (command, args) => {
  calls.push({ command, args });
  if (command === "plugins_discover") return [];
  if (command === "plugins_verify_offer") {
    return {
      surfaces: ["web"],
      installed: false,
      declined: false,
      revision: 2,
      source: { kind: "npm", package: "e2e", version: "0.22.0" },
    };
  }
  if (command === "plugins_install") return { status: "waiting", request: { steps: [] } };
  if (command === "plugins_verify_decline") {
    return {
      applied: true,
      offer: {
        surfaces: ["web"],
        installed: false,
        declined: true,
        revision: 3,
        source: { kind: "npm", package: "e2e", version: "0.22.0" },
      },
    };
  }
  throw new Error(`Verify fixture refused ${command}`);
});

Object.assign(window, { verifyCalls: () => calls });
localStorage.setItem(SOURCES_KEY, JSON.stringify({ revision: 1, sources: [{ kind: "bundled" }] }));

createRoot(document.getElementById("root")!).render(<PluginsPage projectFolder={FOLDER} />);
