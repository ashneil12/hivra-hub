// Browser proof for Settings → Connected apps (WP-79). Each root is the
// ConnectedApps screen Settings renders, with a fixture instead of the app.
import { createRoot } from "react-dom/client";
import { ConnectedApps } from "../../src/features/outside/ui/ConnectedApps";
import type { GrantView, OutsideApi, PendingPage } from "../../src/features/outside/model/connected";
import "../../src/styles/index.css";

const emptyPending: PendingPage = { requests: [], projects: [] };

function mount(id: string, api: OutsideApi) {
  createRoot(document.getElementById(id)!).render(<ConnectedApps api={api} />);
}

const off: OutsideApi["status"] = () => Promise.resolve({ enabled: false, url: null });

let releaseStale: (rows: GrantView[]) => void = () => {};
let grantCalls = 0;
const late: OutsideApi = {
  status: () => Promise.resolve({ enabled: true, url: "http://127.0.0.1:9/mcp" }),
  setEnabled: () => Promise.resolve({ enabled: true, url: "http://127.0.0.1:9/mcp" }),
  grants: () => {
    grantCalls += 1;
    if (grantCalls === 1) {
      return new Promise((resolve) => {
        releaseStale = resolve;
      });
    }
    return Promise.resolve([]);
  },
  disconnect: () => Promise.resolve(true),
  pending: () => Promise.resolve(emptyPending),
  approve: () => Promise.resolve({ redirectUri: "" }),
  deny: () => Promise.resolve({ redirectUri: "" }),
};
(window as unknown as { releaseStale: () => Promise<void> }).releaseStale = () =>
  new Promise((done) => {
    releaseStale([
      {
        id: "old",
        clientName: "Stale",
        projects: ["Secret"],
        write: true,
        lastUsedAt: null,
      },
    ]);
    requestAnimationFrame(() => requestAnimationFrame(() => done()));
  });

mount("late", late);

let connected = true;
const grant: OutsideApi = {
  status: () =>
    Promise.resolve(
      connected
        ? { enabled: true, url: "http://127.0.0.1:9/mcp" }
        : { enabled: true, url: "http://127.0.0.1:9/mcp" },
    ),
  setEnabled: off,
  grants: () =>
    Promise.resolve(
      connected
        ? [
            {
              id: "g1",
              clientName: "Desk",
              projects: ["Hivra"],
              write: false,
              lastUsedAt: 0,
            },
          ]
        : [],
    ),
  disconnect: () => {
    connected = false;
    return Promise.resolve(true);
  },
  pending: () => Promise.resolve(emptyPending),
  approve: () => Promise.resolve({ redirectUri: "" }),
  deny: () => Promise.resolve({ redirectUri: "" }),
};
mount("grant", grant);

let asked = true;
const ask: OutsideApi = {
  status: off,
  setEnabled: off,
  grants: () => Promise.resolve([]),
  disconnect: () => Promise.resolve(false),
  pending: () =>
    Promise.resolve(
      asked
        ? {
            requests: [{ id: "r1", clientName: "Claude" }],
            projects: [
              { id: "hivra", name: "Hivra" },
              { id: "secret", name: "Secret" },
            ],
          }
        : emptyPending,
    ),
  approve: (_requestId, projectIds, write) => {
    document.getElementById("done")!.textContent = `${projectIds.join(",")} write=${write}`;
    asked = false;
    return Promise.resolve({
      redirectUri: "http://127.0.0.1:9/cb?code=secret-code&state=s1",
    });
  },
  deny: () => {
    document.getElementById("done")!.textContent = "denied";
    asked = false;
    return Promise.resolve({ redirectUri: "http://127.0.0.1:9/cb?error=access_denied" });
  },
};
mount("ask", ask);

let missed = true;
const miss: OutsideApi = {
  status: off,
  setEnabled: off,
  grants: () => Promise.resolve([]),
  disconnect: () => Promise.resolve(false),
  pending: () =>
    Promise.resolve(
      missed
        ? {
            requests: [{ id: "r2", clientName: "Claude" }],
            projects: [{ id: "hivra", name: "Hivra" }],
          }
        : emptyPending,
    ),
  approve: () => {
    missed = false;
    return Promise.resolve({ redirectUri: "" });
  },
  deny: () => Promise.resolve({ redirectUri: "" }),
};
mount("miss", miss);
