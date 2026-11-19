import { createRoot } from "react-dom/client";
import { inboxItems } from "../../src/features/crew/model/inbox";
import { crewRows } from "../../src/features/crew/model/rows";
import { CrewTab } from "../../src/features/crew/ui/CrewTab";
import { FirstMateInbox } from "../../src/features/crew/ui/FirstMateInbox";
import "../../src/styles/index.css";

// The real crew card and inbox. The page only names a reason the gates already stored.
const PROJECT = "/work/proj";
const NOW = 1_700_000_000_000;
const REASON = "Sent back: tests went stale after the last edit.";

const rows = crewRows({
  project: PROJECT,
  now: NOW,
  rows: [
    {
      id: "fixing",
      project: PROJECT,
      title: "Add the crew row",
      status: "working",
      statusNotice: REASON,
      createdAt: NOW - 60_000,
    },
    {
      id: "failed-row",
      project: PROJECT,
      title: "Add the crew row",
      status: "failed",
      statusNotice: REASON,
      error: `${REASON} Still failed after 2 tries.`,
      createdAt: NOW - 120_000,
      settledAt: NOW,
    },
  ],
});

const items = inboxItems({
  project: PROJECT,
  rows: [
    {
      id: "failed-row",
      project: PROJECT,
      title: "Add the crew row",
      status: "failed",
      statusNotice: REASON,
      error: `${REASON} Still failed after 2 tries.`,
      updatedAt: NOW,
    },
  ],
});

const root = document.getElementById("root");
if (!root) throw new Error("missing root");
createRoot(root).render(
  <>
    <CrewTab rows={rows} />
    <FirstMateInbox items={items} now={NOW} />
  </>,
);
