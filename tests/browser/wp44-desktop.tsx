// Browser proof for desktop consent (WP-44). The Tauri bridge is faked before the installed list loads.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  allowApp,
  askApp,
  emptyConsent,
  refuseApp,
  setVisible,
  type ConsentState,
} from "../../plugins/desktop-control/bin/consent.mjs";
import { DesktopConsent } from "../../src/features/plugins/ui/DesktopConsent";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

const project = "/tmp/hivra wp44/café";

installFakeTauri("wp44", (command) => {
  if (command === "plugins_list") return { version: 1, plugins: {} };
  if (command === "plugins_pending") return [];
  if (command === "desktop_control_install" || command === "desktop_control_fetch") {
    document.body.dataset.lastCommand = command;
    return command === "desktop_control_install" ? { entry: null, reports: [] } : null;
  }
  return null;
});

function Pane({ on }: { on: boolean }) {
  const [consent, setConsent] = useState<ConsentState>(() => askApp(emptyConsent(), project, "Mail"));
  return (
    <DesktopConsent
      consent={consent}
      on={on}
      onAllow={(itemProject, app) => setConsent((current) => allowApp(current, itemProject, app))}
      onRefuse={(itemProject, app) => setConsent((current) => refuseApp(current, itemProject, app))}
      onVisible={(itemProject, visible) => setConsent((current) => setVisible(current, itemProject, visible))}
    />
  );
}

createRoot(document.getElementById("on")!).render(<Pane on />);
createRoot(document.getElementById("off")!).render(
  <DesktopConsent
    consent={emptyConsent()}
    on={false}
    onAllow={() => undefined}
    onRefuse={() => undefined}
    onVisible={() => undefined}
  />,
);

void import("../../src/features/plugins/ui/InstalledPlugins").then(({ InstalledPlugins }) => {
  createRoot(document.getElementById("installed")!).render(<InstalledPlugins />);
});
