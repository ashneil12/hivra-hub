import { createRoot } from "react-dom/client";
import { addMono, findMono } from "../../src/features/monos/model/mono";
import type { Delegation } from "../../src/features/monos/model/delegations";
import { setDelegationActions, setDelegationRows } from "../../src/features/monos/model/delegationStore";
import { setWaitingChatsHost } from "../../src/features/hub/model/waitingChats";
import { MonoRailSection } from "../../src/app/shell/MonoRailSection";
import { StuckToday } from "../../src/features/hub/ui/StuckToday";
import "../../src/styles/index.css";

// Round 30 proof fixture (browser preview, not Ash's Mac; made-up data labelled Example:): Today's Needs-you spot and
// Being built, and the Monos rail, after the red rule. A worker its Lead has (a test fault with a file path, as on r45, and
// a stalled one) reads grey "With <Lead>" under Being built, in plain words, with "Open <Lead>'s chat" and Dismiss; only
// a worker refused for credits is red Needs you, and only that one is counted on the rail ("1 needs you", never "stuck").

Object.assign(window, {
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (command: string) => (command === "plugin:event|listen" ? 0 : null),
  },
});

const mono = (id: string, name: string, color: string) =>
  findMono(id) ?? addMono({ id, name, mascot: "robot", color, projects: [], sessionId: `${id}-chat` });
mono("ex-hivra-lead", "Example: Hivra lead", "hsl(160 60% 50%)");
mono("ex-nibbii-lead", "Example: Nibbii lead", "hsl(280 60% 65%)");

const now = Date.now();
const row = (id: string, owner: string, patch: Partial<Delegation>): Delegation => ({
  id, ownerSession: `${owner}-chat`, ownerMono: owner, batchId: null, parentId: null, rootId: id, childSession: `w-${id}`,
  requestId: id, generation: 1, project: null, title: "Example: job", brief: null, goal: null, askIds: [], state: "running",
  errorClass: null, error: null, retryable: null, resetsAt: null, result: null, pendingQuestion: null, delivery: "pending",
  deliveryMessage: null, createdAt: now - 30 * 60_000, updatedAt: now - 60_000, settledAt: null, log: [], version: 1,
  mirroredVersion: 0, mirrorError: null, ...patch,
});
setDelegationRows([
  row("t-1", "ex-hivra-lead", { title: "Example: write the onboarding email" }),
  row("t-2", "ex-hivra-lead", {
    title: "Example: tidy the README setup steps", state: "failed", settledAt: now - 9 * 60_000, delivery: "delivered",
    error: "Test fault: this worker was set to fail on purpose for a test (dev-faults/fail-next-workers)",
  }),
  row("t-3", "ex-hivra-lead", {
    title: "Example: run the signup tests", stallKind: "quiet", stallReason: "Still running npm test", stalledAt: now - 12 * 60_000,
  }),
  row("t-4", "ex-nibbii-lead", {
    title: "Example: publish the playtest page", state: "failed", settledAt: now - 3 * 60_000, errorClass: "billing",
    error: "Billing refused (402): Insufficient credits",
  }),
]);
setDelegationActions({
  openOwner: (s: string) => document.body.setAttribute("data-opened", s),
  openChild: () => {},
  stopTree: () => {},
  stopRow: async () => ({ stopped: [], cancelled: [], stopFailed: [] }),
} as never);
setWaitingChatsHost({ liveQuestion: () => undefined, respond: () => {}, send: async () => true, open: () => {} } as never);

function App() {
  return (
    <div className="flex h-full">
      <aside className="h-full w-[260px] overflow-auto border-r border-content/10 bg-background-sidebar py-2" data-proof-rail>
        <MonoRailSection states={new Map() as never} onOpen={() => {}} onCreate={() => {}} onDelete={() => {}} rank={() => 0} />
      </aside>
      <main className="flex-1 overflow-auto px-10 py-8" data-proof-today>
        <h1 className="mb-6 text-lg font-medium text-content/90">Today</h1>
        <div className="mb-6 max-w-[760px]">
          <h2 className="mb-1 text-xs text-content/60">Needs you</h2>
          <StuckToday projectId={undefined} tone="red" />
        </div>
        <div className="max-w-[760px]">
          <StuckToday projectId={undefined} tone="grey" heading="Being built" />
        </div>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
