// Browser proof for the lead tick's settings on the Crew tab (WP-160): the panel the Crew tab shows, on a store in
// memory (the app keeps it in its database).
import { createRoot } from "react-dom/client";
import { memoryDisk } from "../../src/features/hub/model/localHub/localHub";
import { createLeadTickStore } from "../../src/features/leadTick/model/store";
import { LeadTickPanel } from "../../src/features/leadTick/ui/LeadTickPanel";
import "../../src/styles/index.css";

const fresh = createLeadTickStore(memoryDisk());
(window as unknown as { leadTickStore: typeof fresh }).leadTickStore = fresh;
createRoot(document.getElementById("fresh")!).render(<LeadTickPanel project="/code/app" store={fresh} />);

// A project whose last tick was three hours ago: the app was closed.
const NOW = new Date(2026, 10, 10, 15, 0, 0).getTime();
const closed = createLeadTickStore(
  memoryDisk({
    "lead-tick": {
      settings: { "/code/web": { enabled: true, intervalMinutes: 15, shipOnGreen: false } },
      runs: { "/code/web": { lastTickAt: NOW - 3 * 60 * 60_000, lastLine: "Started WP-201.", noted: [] } },
    },
  }),
);
createRoot(document.getElementById("missed")!).render(<LeadTickPanel project="/code/web" store={closed} now={() => NOW} />);
