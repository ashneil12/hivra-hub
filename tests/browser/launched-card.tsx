import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LaunchedSessionCard } from "../../src/features/monos/ui/LaunchedSessionCard";
import "../../src/styles/index.css";

// r94 (item 3, s15 SCRIPTED 8c60): the worker card as DelegationBatchRow lays it out under a Lead's reply (card, then
// "Stalled" and "Stop" beside it), at the chat width the URL asks for, on the Grok bridge as in the live run.
const width = Number(new URLSearchParams(location.search).get("w") ?? "640");
const launch = { sessionId: "w1", cwd: "/repo/tally", title: "Show tally count on the board", harness: "claude" as const, model: "claude:grok-4.7", effort: "High" };

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="text-content" style={{ width, padding: 16 }}>
      <div className="flex min-w-0 items-center gap-1.5">
        <LaunchedSessionCard launch={launch} view={{ state: "stuck", title: launch.title }} onOpen={() => undefined} />
        <span data-stalled className="flex shrink-0 items-center gap-1 font-sans text-[12px] text-content/55">Stalled</span>
        <span data-stop className="flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 font-sans text-[12px] text-content/55">Stop</span>
      </div>
    </div>
  </StrictMode>,
);
