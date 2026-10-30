import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LiveAgentsPreview } from "../../src/features/sessions/ui/LiveAgentsPreview";
import type { LiveAgent } from "../../src/features/sessions/model/liveAgents";
import "../../src/styles/index.css";

// r94 (Critiquito b): the project rail's column as ProjectRail builds it (a fixed top, the rail that scrolls, the
// working-agents card, Settings), with the real card and four working agents, at whatever height the window is.
const agents: LiveAgent[] = ["GET /health alive endpoint", "UI uses shared tally type", "README notes GET /health", "Update tally API and board"].map(
  (title, i) => ({ id: `a${i}`, cwd: "/p/tally", title, harness: "claude", activity: "Editing stats.ts", startedAt: Date.now() - 20_000, needsApproval: false, done: false }),
);

function Fixture() {
  return (
    <div className="flex text-content" style={{ height: "100vh" }}>
      <nav className="sidebar-glass relative flex min-h-0 w-[240px] shrink-0 flex-col border-r border-stroke">
        <div className="flex h-10 shrink-0 items-center px-3 text-[13px]">Search</div>
        <div data-rail className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-none pb-2">
          {Array.from({ length: 30 }, (_, i) => (
            <div key={i} data-rail-row className="shrink-0 px-4 py-1.5 text-[13px]">Rail row {i + 1}</div>
          ))}
        </div>
        <LiveAgentsPreview agents={agents} groupLabels={{}} groupColors={{}} groupCustomColors={{}} groupMascots={{}} />
        <div data-settings className="flex shrink-0 flex-col gap-px p-2 text-[13px]">Settings</div>
      </nav>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
