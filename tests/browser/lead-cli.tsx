import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { LeadCliNotice } from "../../src/features/firstmate/ui/LeadCliNotice";
import { type HarnessId } from "../../src/features/sessions/model/session";
import "../../src/styles/index.css";
import { installLeadStripHarnesses } from "./leadCliFixtureSetup";

installLeadStripHarnesses();

function Fixture() {
  const [harness, setHarness] = useState<HarnessId>("opencode");
  return (
    <div>
      <LeadCliNotice harness={harness} sessionId="lead-chat" onSwitch={setHarness} />
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
