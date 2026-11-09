import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { setHarnessAvailability } from "../../src/integrations/harness/core/availabilityState";
import { LeadCliNotice } from "../../src/features/firstmate/ui/LeadCliNotice";
import { HARNESSES, type HarnessId } from "../../src/features/sessions/model/session";
import "../../src/styles/index.css";

const availability = Object.fromEntries(HARNESSES.map((id) => [id, false])) as Record<HarnessId, boolean>;
for (const id of ["claude", "codex", "cursor", "grok", "opencode", "pi"] as const) {
  availability[id] = true;
}
setHarnessAvailability(availability);

function Fixture() {
  const [harness, setHarness] = useState<HarnessId>("opencode");
  return (
    <div>
      <LeadCliNotice harness={harness} onSwitch={setHarness} />
      <output data-harness="">{harness}</output>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
