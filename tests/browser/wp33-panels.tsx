import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { PageSpec } from "../../src/features/pages/model/pageSpec";
import { PanelTabs, type CatalogPanel } from "../../src/features/panels/ui/PanelTabs";
import "../../src/styles/index.css";

// WP-33 proof fixture (browser preview, not Ash's Mac; made-up data labelled Example:). One panel from My panels,
// granted only tasks.read. Turning the plugin off drops its tab. No app window is launched.

const spec: PageSpec = {
  kind: "bespoke",
  title: "Example: board",
  html: "<p>Example: board</p>",
  permissions: ["tasks.read"],
};

const offer: CatalogPanel = { plugin: "my-panels", panelId: "board", title: spec.title, spec };

function Fixture() {
  const [on, setOn] = useState(true);
  const [rev, setRev] = useState(1);
  return (
    <PanelTabs
      catalog={on ? [offer] : []}
      rev={rev}
      onTurnOff={() => {
        setOn(false);
        setRev(2);
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
