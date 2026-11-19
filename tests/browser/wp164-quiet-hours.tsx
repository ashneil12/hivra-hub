import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  allowsProjectNotification,
  updateNotificationPreferences,
  type NotificationCategory,
} from "../../src/features/notifications/model/notificationPreferences";
import { QUIET_HOURS_DESCRIPTION } from "../../src/features/notifications/model/quietHours";
import { QuietHoursSetting } from "../../src/features/notifications/ui/QuietHoursSetting";
import "../../src/styles/index.css";

const NIGHT = new Date(2026, 10, 10, 23, 30).getTime();
const DAY = new Date(2026, 10, 10, 12, 0).getTime();

// The page asks the gate every banner and sound asks, so the switch is tested where it bites. "muted" is a project
// that turned approvals off for itself: that stays off at any hour.
updateNotificationPreferences(["muted"], { disabled: ["agentInput"] });
// A project that turned "Agent finished" off: a failed turn there stays silent too.
updateNotificationPreferences(["mutedFinished"], { disabled: ["agentFinished"] });

function line(category: NotificationCategory, project: string, now: number, failure = false): string {
  return allowsProjectNotification({ projectId: project, category, ...(failure ? { failure } : {}) }, now)
    ? "shown"
    : "held";
}

function Fixture() {
  const [tick, setTick] = useState(0);
  return (
    <div data-tick={tick}>
      <p>Quiet hours</p>
      <p>{QUIET_HOURS_DESCRIPTION}</p>
      <QuietHoursSetting onChange={() => setTick((current) => current + 1)} />
      <output data-finished-night>{line("agentFinished", "work", NIGHT)}</output>
      <output data-approval-night>{line("agentInput", "work", NIGHT)}</output>
      <output data-approval-muted>{line("agentInput", "muted", NIGHT)}</output>
      <output data-failed-night>{line("agentFinished", "work", NIGHT, true)}</output>
      <output data-failed-muted>{line("agentFinished", "mutedFinished", NIGHT, true)}</output>
      <output data-finished-day>{line("agentFinished", "work", DAY)}</output>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
