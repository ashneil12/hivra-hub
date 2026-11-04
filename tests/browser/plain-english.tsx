import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { contractForAgents } from "../../src/features/firstmate/model/contract";
import { plainEnglishEndings } from "../../src/features/firstmate/model/plainEnglish";
import { PlainEnglishSetting } from "../../src/features/firstmate/ui/PlainEnglishSetting";
import { sessionInstruction } from "../../src/features/plugins/model/pstackAutopilot";
import "../../src/styles/index.css";

function Fixture() {
  const [tick, setTick] = useState(0);
  const on = plainEnglishEndings();
  return (
    <div data-tick={tick}>
      <p>Plain-English endings</p>
      <p>Replies end with one short paragraph in plain words about what happened and what it means.</p>
      <PlainEnglishSetting onChange={() => setTick((current) => current + 1)} />
      <output data-session>{sessionInstruction({ plainEnglish: on })}</output>
      <output data-contract>{contractForAgents()}</output>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
