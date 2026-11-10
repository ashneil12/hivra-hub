// Browser proof for Settings → Work log (WP-157). The seeded list is the
// WorkLogPanel Settings renders, not a copy of its markup.
import { createRoot } from "react-dom/client";
import { WorkLogPanel } from "../../src/features/workLog/ui/WorkLogPanel";
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
  line("2026-11-10", "feedback", "Keep the work log line short."),
];

createRoot(document.getElementById("log")!).render(<WorkLogPanel lines={seed} today="2026-11-10" />);
createRoot(document.getElementById("empty")!).render(<WorkLogPanel lines={[]} today="2026-11-10" />);
