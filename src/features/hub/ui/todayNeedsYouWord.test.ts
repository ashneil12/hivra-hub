// @vitest-environment happy-dom
// One word for one job (PM's real-app check of r35, 22 Oct): Today called a job its Lead gave up on "Stuck" while Being
// built called the same job "Needs you". Today now uses Being built's word. No job logic changes: the same job, the
// same state, only the label (the old red "Stuck" stays behind the `monocode:hub-gaveup-style=stuck` dev flag).
import http from "node:http";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startStub, type Stub } from "../../../../scripts/hub-stub-server.mjs";
import { HubStore } from "../model/hubStore";
import { HubCallError, type HubTransport } from "../model/hubTransport";
import { setHubDataSource } from "../model/hubData";
import { createLiveHubData } from "../model/liveHubData";
import { HubSurface } from "./HubSurface";
import { BeingBuiltView } from "./BeingBuiltView";

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
  stub = await startStub({ jobs: true });
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

/** The job's word on Today's Being built list ("Hivra · its Lead · <word>") and on the project's Being built row. */
async function words() {
  act(() => root.render(createElement("div", null,
    createElement(HubSurface, { selection: { project: "today", item: "inbox" } }),
    createElement("div", { "data-project-being-built": "" }, createElement(BeingBuiltView, { projectId: "hivra" })))));
  await until(() => container.querySelector('[data-hub-today-job="j_sender"]') && container.querySelector('[data-hub-worker="j_sender"]'), "both lists");
  const today = container.querySelector('[data-hub-today-job="j_sender"] [data-hub-chip]')?.textContent;
  const built = container.querySelector('[data-hub-worker="j_sender"] [data-hub-job-state] [data-hub-chip]')?.textContent;
  return { today, built };
}

it("a job its Lead gave up on reads 'Needs you' on Today, the same as Being built", async () => {
  const { today, built } = await words();
  expect(built).toBe("Needs you");
  expect(today).toBe("Needs you");
  expect(container.querySelector('[data-hub-today-job="j_sender"]')!.textContent).not.toMatch(/Stuck/);
  // A job sent to its Lead names the Lead (r27).
  expect(container.querySelector('[data-hub-today-job="j_backup"]')!.textContent).toMatch(/· With Hivra lead$/);
});

it("with the old-style dev flag both places still agree", async () => {
  localStorage.setItem("monocode:hub-gaveup-style", "stuck");
  const { today, built } = await words();
  expect(today).toBe("Stuck");
  expect(built).toBe("Stuck");
});
