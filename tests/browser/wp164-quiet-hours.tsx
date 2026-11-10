import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { allowsProgrammeNotification, loadQuietHours } from "../../src/features/notifications/model/quietHours";
import { QuietHoursSetting } from "../../src/features/notifications/ui/QuietHoursSetting";
import "../../src/styles/index.css";

const NIGHT = new Date(2026, 10, 10, 23, 30).getTime();
const DAY = new Date(2026, 10, 10, 12, 0).getTime();

function line(category: "agentFinished" | "agentInput", muted: boolean, now: number): string {
  return allowsProgrammeNotification({
    category,
    categoryMuted: muted,
    quiet: loadQuietHours(),
    now,
  })
    ? "shown"
    : "held";
}

function Fixture() {
  const [tick, setTick] = useState(0);
  return (
    <div data-tick={tick}>
      <p>Quiet hours</p>
      <p>Routine programme notices wait. Approvals and questions still come through unless you muted them.</p>
      <QuietHoursSetting onChange={() => setTick((current) => current + 1)} />
      <output data-finished-night>{line("agentFinished", false, NIGHT)}</output>
      <output data-approval-night>{line("agentInput", false, NIGHT)}</output>
      <output data-approval-muted>{line("agentInput", true, NIGHT)}</output>
      <output data-finished-day>{line("agentFinished", false, DAY)}</output>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
