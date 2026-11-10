// Browser proof for Settings → Work log (WP-157). The seeded list is the
// WorkLogPanel Settings renders, not a copy of its markup.
import { createRoot } from "react-dom/client";
import { WorkLogPanel } from "../../src/features/workLog/ui/WorkLogPanel";
import type { PendingEdit } from "../../src/features/workLog/model/retro";
import type { WorkLogLine } from "../../src/features/workLog/model/workLog";
import "../../src/styles/index.css";

function line(day: string, kind: WorkLogLine["kind"], text: string, project = "hivra"): WorkLogLine {
  return { project, day, kind, taskId: "", line: text };
}

const seed: WorkLogLine[] = [
  line("2026-11-09", "outcome", "Done: Wrote the log."),
  line("2026-11-10", "decision", "Decided: Ship it. Answer: yes."),
  line("2026-11-10", "outcome", "Done: Shipped the panel."),
  line("2026-11-10", "outcome", "Done: Other project.", "other"),
  line("2026-11-03", "outcome", "Done: Too old for the week."),
  line("2026-11-09", "outcome", "Sent back: The brief was wrong."),
  line("2026-11-09", "outcome", "Failed: The build broke."),
  line("2026-11-10", "feedback", "Keep the work log line short."),
];

// The page has no app behind it, so the summary's queue is a stand-in that records what it was given.
async function stage(edits: PendingEdit[]) {
  const holder = window as unknown as { __queued?: string[] };
  holder.__queued = [...(holder.__queued ?? []), ...edits.map((edit) => edit.text)];
  return { staged: edits.length, waiting: edits.length, declined: 0, present: 0, full: 0 };
}

createRoot(document.getElementById("log")!).render(<WorkLogPanel lines={seed} today="2026-11-10" stage={stage} />);
createRoot(document.getElementById("empty")!).render(<WorkLogPanel lines={[]} today="2026-11-10" />);
