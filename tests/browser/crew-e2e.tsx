import { createRoot } from "react-dom/client";
import { CrewE2eLinks } from "../../src/features/firstmate/ui/CrewE2eLinks";
import "../../src/styles/index.css";

// WP-42. The proof a worker left under .e2e, and nothing else from the report.
const report = JSON.stringify({
  summary: "proved the button",
  filesChanged: ["src/a.ts"],
  checks: [],
  evidence: [
    ".e2e/report.json",
    ".e2e/results/home/trace.md",
    ".e2e\\shot.png",
    "https://example.com/run",
    "../secret.png",
    ".e2e/../../etc/passwd",
  ],
  openQuestions: [],
  selfAssessment: [],
  missing: [],
});

createRoot(document.getElementById("root")!).render(<CrewE2eLinks report={report} />);
