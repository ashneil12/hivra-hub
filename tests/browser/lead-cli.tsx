import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { setHarnessAvailability } from "../../src/integrations/harness/core/availabilityState";
import { LeadCliNotice } from "../../src/features/firstmate/ui/LeadCliNotice";
import { saveChosenClis } from "../../src/features/hub/model/codingTeamHome";
import { HARNESSES, type HarnessId } from "../../src/features/sessions/model/session";
import "../../src/styles/index.css";

// Every CLI is installed here. Ash ticked Claude Code, Cursor and Pi at first launch; Codex is installed but was not
// ticked, and Grok and OpenCode were neither. The strip must offer only Claude Code, the one ticked CLI that can lead.
const availability = Object.fromEntries(HARNESSES.map((id) => [id, true])) as Record<HarnessId, boolean>;
setHarnessAvailability(availability);
saveChosenClis(["claude", "cursor", "pi"]);

function Fixture() {
  const [harness, setHarness] = useState<HarnessId>("opencode");
  return (
    <div>
      <LeadCliNotice harness={harness} onSwitch={setHarness} />
      <output data-harness="">{harness}</output>
      {/* Lets a spec open a chat that already leads on a capable CLI. */}
      <button type="button" data-set-harness="claude" onClick={() => setHarness("claude")}>
        set claude
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
