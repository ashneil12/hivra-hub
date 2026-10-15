// @vitest-environment happy-dom
// The live Today and project strip, rendered against the stub server: what Ash sees when Ash OS is there, when a
// Need ticks itself off, when it is slow to answer and when it isn't running. Never example data.
import http from "node:http";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startStub, type Stub } from "../../../../scripts/hub-stub-server.mjs";
import { HubStore } from "../model/hubStore";
import { HubCallError, type HubTransport } from "../model/hubTransport";
import { setHubDataSource } from "../model/hubData";
import { createLiveHubData } from "../model/liveHubData";
import { ProjectStrip } from "./ProjectStrip";
import { HubSurface } from "./HubSurface";

/** Calls over plain node http (happy-dom's fetch won't talk to a local server); no live feed, so the store polls. */
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

const FAST = { coalesceMs: 5, healthMs: 20, pollMs: 40, retryMs: [40], stopGraceMs: 5 };
let stub: Stub;
let url: string;
let store: HubStore;
let root: Root;
let container: HTMLElement;

async function until(read: () => unknown, what: string, ms = 4000) {
  const end = Date.now() + ms;
  while (!read()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${container.textContent}`);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}
const text = () => container.textContent ?? "";
const rows = () => [...container.querySelectorAll("[data-hub-need]")].map((r) => r.getAttribute("data-hub-need"));

function mount(el: ReturnType<typeof createElement>) {
  act(() => root.render(el));
}
const surface = () => createElement(HubSurface, { selection: { project: "today", item: "inbox" } });

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  stub = await startStub();
  url = stub.url;
  store = new HubStore({ transport: httpTransport(() => url, () => stub.token), ...FAST });
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

describe("Today, live", () => {
  it("shows a blank page, not 'No projects yet', while Ash OS is first being read", () => {
    mount(surface());
    expect(container.querySelector("[data-hub-loading]")).toBeTruthy();
    expect(text()).not.toContain("No projects yet");
  });

  it("shows Since, each project's Needs with one action each, and what is under Later", async () => {
    mount(surface());
    await until(() => rows().length >= 8, "needs");
    await until(() => text().includes("Since"), "since label");
    expect(text()).toMatch(/Since (yesterday|\d|[A-Z][a-z]+)/);
    expect(text()).toContain("Example: the game's new level is in and working");
    for (const name of ["EXO game", "Hivra", "Org"]) expect(text()).toContain(name);
    expect(text()).not.toContain("Nibbii"); // nothing waiting: no heading, no zero
    const org = container.querySelectorAll('[data-hub-need]');
    for (const row of org) expect(row.querySelectorAll("button").length).toBe(1);
    expect(text()).toContain("1 more under Later");
    expect(text()).not.toContain("renew the domain names"); // Later is a count until its list is built
  });

  it("the strip's counts are exactly the rows Ash can see, with no zero badge", async () => {
    mount(createElement("div", null, createElement(ProjectStrip, { selection: { project: "today", item: "inbox" }, onPickProject: () => undefined, onCreateProject: () => undefined }), surface()));
    await until(() => rows().length >= 8, "needs");
    const badge = (name: string) => container.querySelector(`button[aria-label^="${name}"] span.hub-count-badge`)?.textContent;
    expect(badge("EXO game")).toBe("2");
    expect(badge("Hivra")).toBe("1");
    expect(badge("Org")).toBe("5");
    expect(badge("Nibbii")).toBeUndefined();
    expect(container.querySelectorAll("[data-hub-strip] .hub-count-badge").length).toBe(3);
  });

  it("a Need answered elsewhere ticks itself off in place, stops counting, and goes when Ash leaves the page", async () => {
    mount(createElement("div", null, createElement(ProjectStrip, { selection: { project: "today", item: "inbox" }, onPickProject: () => undefined, onCreateProject: () => undefined }), surface()));
    await until(() => rows().length >= 8, "needs");
    const before = rows();
    stub.doneNeed("q3");
    await until(() => container.querySelector('[data-hub-need="q3"][data-hub-need-done]'), "tick");
    expect(rows()).toEqual(before); // nothing moved
    const ticked = container.querySelector('[data-hub-need="q3"]')!;
    expect(ticked.querySelector("button")).toBeNull();
    expect(ticked.querySelector('[aria-label="Done"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label^="Hivra"] .hub-count-badge')).toBeNull(); // no zero badge
    // leaving the page: ticked rows go
    mount(createElement("div"));
    mount(surface());
    await until(() => !container.querySelector('[data-hub-need="q3"]') && rows().length > 0, "gone");
  });

  it("a new Need arrives at the bottom of its project without a reload", async () => {
    mount(surface());
    await until(() => rows().length >= 8, "needs");
    stub.addNeed({ id: "q20", projectId: "exo-game", title: "Example: late arrival", rank: 0 });
    await until(() => rows().includes("q20"), "new row");
    const r = rows();
    expect(r.indexOf("q20")).toBe(r.indexOf("q2") + 1);
  });

  it("with Ash OS down it shows one calm sentence and one button, never example data", async () => {
    await stub.close();
    mount(surface());
    await until(() => container.querySelector("[data-hub-down]"), "down state");
    expect(text()).toContain("Ash OS isn't running.");
    expect(text()).not.toMatch(/Example|EXO game|Hivra/);
    expect(container.querySelectorAll("button").length).toBe(1);
    expect(container.querySelector("[data-hub-down-retry]")?.textContent).toBe("Try again");
    stub = await startStub();
    url = stub.url;
  });

  it("the Try again button reads again, and Today fills in when Ash OS is back", async () => {
    const port = stub.port;
    const token = stub.token;
    await stub.close();
    mount(surface());
    await until(() => container.querySelector("[data-hub-down]"), "down state");
    stub = await startStub({ port, token });
    act(() => (container.querySelector("[data-hub-down-retry]") as HTMLButtonElement).click());
    await until(() => rows().length >= 8, "today after retry");
    expect(container.querySelector("[data-hub-down]")).toBeNull();
  });

  it("a project with no code folder opens on its Inbox and lists no Coding team", async () => {
    mount(createElement("div"));
    await act(async () => store.start());
    await until(() => store.getSnapshot().status === "ready", "ready");
    const items = createLiveHubData(store).listProjectItems("org").map((i) => i.id);
    expect(items).not.toContain("coding-team");
    expect(createLiveHubData(store).listProjectItems("hivra").map((i) => i.id)).toContain("coding-team");
  });
});
