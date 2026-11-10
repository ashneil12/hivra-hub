// WP-126: the skills panel, with a fixed report so the browser does not need disk or Tauri.
import { createRoot } from "react-dom/client";
import { CliParityPanel } from "../../src/features/skills/ui/CliParityPanel";
import type { ParityReport } from "../../src/features/skills/model/cliParity";
import "../../src/styles/index.css";

const report: ParityReport = {
  skills: [
    {
      name: "review",
      path: ".claude/skills/review/SKILL.md",
      scope: "project",
      place: "claude",
      readers: ["claude"],
      sharedFile: false,
    },
    {
      name: "shared",
      path: ".agents/skills/shared/SKILL.md",
      scope: "project",
      place: "agents",
      readers: ["codex", "cursor"],
      sharedFile: true,
    },
  ],
  mcp: [{ cli: "claude", name: "docs", scope: "project", path: ".mcp.json" }],
  rules: [
    { path: "AGENTS.md", readers: ["claude", "codex", "cursor"], pointer: false },
    { path: "CLAUDE.md", readers: ["claude"], pointer: true },
  ],
};

createRoot(document.getElementById("root")!).render(
  <CliParityPanel report={report} notice={null} />,
);
