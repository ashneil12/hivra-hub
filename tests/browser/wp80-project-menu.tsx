// WP-80: the project menu's "Share with my team" item on its own. There is no app store in a browser, so a share
// cannot go through and the menu must show why, in the menu, not only in the console.
import { createRoot } from "react-dom/client";
import { ProjectMenu } from "../../src/features/hub/ui/ProjectMenu";
import "../../src/styles/index.css";

Object.assign(window, {
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (command: string) => {
      if (command === "plugin:event|listen") return 0;
      if (command === "plugin:event|unlisten") return;
      return undefined;
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <ProjectMenu
    project={{ id: "exo", name: "EXO game", shortName: "EXO", iconShape: "gamepad", folder: null }}
    anchor={{ x: 20, y: 20 }}
    onClose={() => undefined}
  />,
);
