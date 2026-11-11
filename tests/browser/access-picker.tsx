import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AccessPicker } from "../../src/features/sessions/ui/AccessPicker";
import type { RuntimeMode } from "../../src/features/sessions/model/session";
import "../../src/styles/index.css";

// WP-175 review 2: the desktop mode picker as each CLI names its modes. fx chat on Supervised (offers Full access
// only, with the honest name); an Antigravity chat on Auto (its default, named for what it runs).
function Fixture({ harness, initial }: { harness: string; initial: RuntimeMode }) {
  const [mode, setMode] = useState<RuntimeMode>(initial);
  return (
    <div data-fixture={harness}>
      <AccessPicker harness={harness} value={mode} onChange={setMode} side="bottom" variant="plain" />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <>
    <Fixture harness="fx" initial="supervised" />
    <Fixture harness="antigravity" initial="auto" />
  </>,
);
