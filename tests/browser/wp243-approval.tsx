// WP-243: the approval card shows the exact command an Allow runs; a card Ash's own words covered says which words; a
// call a restart cut while it may have been running says it won't run again. Example data only.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Block } from "../../src/features/sessions/model/session";
import { AgentTranscript } from "../../src/features/sessions/ui/AgentTranscript";
import { saveTranscriptAnchor, saveTranscriptLayout } from "../../src/features/settings/model/appearance";
import "../../src/styles/index.css";

saveTranscriptAnchor(false);
saveTranscriptLayout("chat");

const LONG =
  "npm run build --workspace example-app && node scripts/example-check.mjs --strict --report target/example-report.json --since 2026-11-01";

const blocks: Block[] = [
  { id: "u1", role: "user", text: "Example: install lodash and run the tests", byOwner: true },
  {
    id: "covered",
    role: "tool",
    text: "Install lodash",
    tool: { title: "Bash", kind: "execute", status: "completed", command: "npm install lodash" },
    approval: {
      requestId: 1,
      decided: "allow",
      call: { tool: "Bash", command: "npm install lodash" },
      actionHash: "a".repeat(64),
      coveredBy: { source: "message", quote: "install lodash and run the tests" },
    },
  },
  {
    id: "cut",
    role: "tool",
    text: "Run the tests",
    tool: { title: "Bash", kind: "execute", status: "cancelled", command: "npm test", uncertain: true },
  },
  {
    id: "open",
    role: "tool",
    text: "Build and check",
    tool: { title: "Bash", kind: "execute", status: "pending", command: LONG },
    approval: { requestId: 2, call: { tool: "Bash", command: LONG }, callComplete: true, actionHash: "b".repeat(64) },
  },
];

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AgentTranscript blocks={blocks} busy onApproval={() => undefined} />
  </StrictMode>,
);
