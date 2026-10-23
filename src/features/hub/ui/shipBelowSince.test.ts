// @vitest-environment happy-dom
// r28 (PM's r44 check): the "MonoCode Hub was updated · Show the log" card sat above the Since paragraph on Today. The
// Since paragraph is always first; the update card comes right below it.
import http from "node:http";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const ship = vi.hoisted(() => ({ status: null as unknown }));
vi.mock("../../../app/model/ship", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useShipStatus: () => ship.status,
  markShipSeen: vi.fn().mockResolvedValue(undefined),
}));
import { readShipStatus } from "../../../app/model/ship";
import { startStub, type Stub } from "../../../../scripts/hub-stub-server.mjs";
import { HubStore } from "../model/hubStore";
import { HubCallError, type HubTransport } from "../model/hubTransport";
import { setHubDataSource } from "../model/hubData";
import { createLiveHubData } from "../model/liveHubData";
import { HubSurface } from "./HubSurface";

function httpTransport(baseUrl: () => string, token: () => string): HubTransport {
  return {
    call: (action, payload = {}) =>
      new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const req = http.request(
          `${baseUrl()}/api/${action}`,
          { method: "POST", headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
          (res) => {
            let raw = "";
            res.on("data", (c) => (raw += c));
            res.on("end", () => {
              const json = JSON.parse(raw);
              if (json.ok) resolve(json.result);
              else reject(new HubCallError("error", json.error));
            });
          },
        );
        req.on("error", () => reject(new HubCallError("unreachable", "Ash OS isn't running.")));
        req.end(body);
      }),
    openFeed: (_after, handlers) => {
      handlers.onState({ connected: false, message: "polling in this test" });
      return () => undefined;
    },
  };
}

let stub: Stub;
let store: HubStore;
let root: Root;
let container: HTMLElement;
async function until(read: () => unknown, what: string, ms = 4000) {
  const end = Date.now() + ms;
  while (!read()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${container.textContent}`);
    await act(async () => void (await new Promise((r) => setTimeout(r, 15))));
  }
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  stub = await startStub({});
  stub.setSince(
    "Example: EXO's new level is in and plays well. 102 things are waiting on you. Merged PRs: #412 and #415. " +
      "Hivra's waitlist email went out to 40 people.",
    {},
  );
  store = new HubStore({ transport: httpTransport(() => stub.url, () => stub.token), coalesceMs: 5, healthMs: 20, pollMs: 40, retryMs: [40], stopGraceMs: 5 });
  setHubDataSource(createLiveHubData(store), store);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await new Promise((r) => setTimeout(r, 20));
  store.stop();
  setHubDataSource(undefined);
  await stub.close();
});


it("the update card sits below the Since paragraph, which stays first on Today", async () => {
  const ID = "20261022-131313-ccccccc";
  ship.status = readShipStatus({
    enabled: true,
    current: { id: ID, phase: "committed", accepted: true, acceptance: { state: "yes" }, committed: true, seen: false, log: "/ship/runner.log",
      from: { sha: "a".repeat(40), branch: "hub/next" }, to: { sha: "b".repeat(40), branch: "hub/next" } },
  });
  act(() => root.render(createElement(HubSurface, { selection: { project: "today", item: "inbox" } })));
  await until(() => container.querySelector("[data-hub-since]")?.textContent?.includes("Example:") && container.querySelector("[data-hub-ship]"), "Today with the update card");
  const body = container.querySelector("[data-hub-surface-body]")!;
  const order = [...body.children].map((el) => el.getAttribute("data-hub-today-section") ?? (el.hasAttribute("data-hub-ship") ? "ship" : el.hasAttribute("data-hub-home-tools") ? "tools" : el.tagName));
  expect(order[0]).toBe("since");
  expect(order[1]).toBe("ship");
  expect(container.querySelector("[data-hub-ship]")!.textContent).toContain("MonoCode Hub was updated.");
  // Nothing of it above the body.
  const surface = container.querySelector("[data-hub-surface]")!;
  expect(surface.querySelectorAll("[data-hub-ship]")).toHaveLength(1);
  expect(body.contains(surface.querySelector("[data-hub-ship]"))).toBe(true);
});
