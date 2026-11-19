// The orchestration list as it is, before the Agents board replaces it.
import { createRoot } from "react-dom/client";
import { OrchestrationSidebarAgents } from "../../src/features/orchestration/ui/OrchestrationSidebarAgents";
import "../../src/styles/index.css";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <div style={{ width: 280, padding: 12 }}>
      <OrchestrationSidebarAgents
        leadId="example-lead"
        variant="tree"
        summary={{
          status: "running",
          live: true,
          tasks: [
            {
              sessionId: "example-worker",
              title: "Example: Fix the build",
              harness: "claude",
              model: "example",
              status: "running",
            },
          ],
        }}
      />
    </div>,
  );
}
