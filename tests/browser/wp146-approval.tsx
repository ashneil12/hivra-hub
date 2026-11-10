import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { waitingOnYouLine } from "../../src/features/sessions/model/approvalWait";
import type { Block } from "../../src/features/sessions/model/session";
import { AgentTranscript } from "../../src/features/sessions/ui/AgentTranscript";
import {
  saveTranscriptAnchor,
  saveTranscriptLayout,
} from "../../src/features/settings/model/appearance";
import "../../src/styles/index.css";

saveTranscriptAnchor(false);
saveTranscriptLayout("chat");

const held: Block = {
  id: "t",
  role: "tool",
  text: "Run tests",
  tool: { title: "Bash", kind: "execute", status: "pending", command: "npm test" },
  approval: { requestId: 1, call: { tool: "Bash", command: "npm test" } },
};

const blocks: Block[] = [
  { id: "u", role: "user", text: "Run the tests" },
  held,
  {
    id: "n",
    role: "system",
    text: waitingOnYouLine([held]) ?? "",
    notice: "waiting-on-you",
  },
];

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AgentTranscript blocks={blocks} busy onApproval={() => undefined} />
  </StrictMode>,
);
