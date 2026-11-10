// Browser proof for the programme card (WP-159). The card is the one Home shows.
import { createRoot } from "react-dom/client";
import { ProgrammePanel } from "../../src/features/programme/ui/ProgrammePanel";
import type { ProgrammePackage } from "../../src/features/programme/model/programme";
import "../../src/styles/index.css";

function row(patch: Partial<ProgrammePackage>): ProgrammePackage {
  return {
    id: "programme-1",
    projectId: "crew",
    wp: "WP-159",
    title: "Queue the programme",
    briefPath: "docs/my briefs/note.md",
    branch: "wp/159-programme-queue",
    status: "queued",
    securityPark: false,
    priority: 1,
    notes: "",
    parkReason: null,
    version: 4,
    createdAt: 10,
    updatedAt: 10,
    claimedAt: null,
    finishedAt: null,
    ...patch,
  };
}

const rows: ProgrammePackage[] = [
  row({ id: "q", title: "Write the notes", status: "queued", priority: 1 }),
  row({ id: "b", title: "Build the panel", status: "building", priority: 3 }),
  row({ id: "p", title: "Open the review", status: "pr_open", priority: 2 }),
  row({ id: "k", title: "Wait for a look", status: "parked", parkReason: "Needs a look", priority: 0, version: 4 }),
  row({ id: "s", title: "Check the diff", status: "queued", securityPark: true, priority: 5 }),
  row({ id: "f", title: "Fix the build", status: "failed", priority: 0 }),
  row({ id: "m", title: "Already merged", status: "merged", priority: 9 }),
];

createRoot(document.getElementById("board")!).render(
  <ProgrammePanel
    rows={rows}
    notice="That package changed. Read it again and retry."
    onClear={(item) => {
      document.getElementById("cleared")!.textContent = `${item.id}:${item.version}`;
    }}
  />,
);

createRoot(document.getElementById("empty")!).render(<ProgrammePanel rows={[]} />);
