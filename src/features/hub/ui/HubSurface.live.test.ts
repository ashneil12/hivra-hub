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
    for (const name of ["EXO", "Hivra", "Hub"]) expect(text()).toContain(name);
    expect(container.querySelector("[data-hub-home-projects]")?.textContent).toContain("Nibbii"); // quiet projects remain accessible
    const org = container.querySelectorAll('[data-hub-need]');
    for (const row of org) expect(row.querySelectorAll("button").length).toBe(1);
    expect(text()).toContain("1 more under Later");
    expect(text()).not.toContain("renew the domain names"); // Later is a count until its list is built
  });

  it("the strip's badge is the open rows Today shows for the project (stuck included, Later not), with no zero badge", async () => {
    mount(createElement("div", null, createElement(ProjectStrip, { selection: { project: "today", item: "inbox" }, onPickProject: () => undefined, onCreateProject: () => undefined }), surface()));
    await until(() => rows().length >= 8, "needs");
    const badge = (name: string) => container.querySelector(`button[aria-label^="${name}"] span.hub-count-badge`)?.textContent;
    expect(badge("EXO")).toBe("2");
    expect(badge("Hivra")).toBe("1");
    expect(badge("MonoCode Hub")).toBe("5"); // the five rows shown; the one under Later has its own line
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
    stub.addNeed({ id: "q20", projectId: "vg-game", title: "Example: late arrival", rank: 0 });
    await until(() => rows().includes("q20"), "new row");
    // Last of its project's rows of its own kind (Today groups a project's Needs: to decide, to check, to look at).
    const row = container.querySelector('[data-hub-need="q20"]')!;
    const group = row.closest("[data-hub-need-group]") ?? row.closest("section")!;
    const mine = [...group.querySelectorAll("[data-hub-need]")].map((r) => r.getAttribute("data-hub-need"));
    expect(mine[mine.length - 1]).toBe("q20");
  });

  it("with Ash OS down it shows one calm sentence and one button, never example data", async () => {
    await stub.close();
    mount(surface());
    await until(() => container.querySelector("[data-hub-down]"), "down state");
    expect(text()).toContain("The harness service is unavailable.");
    expect(text()).not.toMatch(/Example|EXO|Hivra/);
    expect(container.querySelectorAll("[data-hub-down-retry]").length).toBe(1);
    expect(container.querySelector("[data-hub-home-tools]")).not.toBeNull();
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
    stub.addProject({ id: "side", name: "Side thing" }); // the stub makes it without a folder
    await until(() => store.getSnapshot().projects.some((p) => p.id === "side"), "foldless project");
    const items = createLiveHubData(store).listProjectItems("side").map((i) => i.id);
    expect(items).not.toContain("coding-team");
    expect(createLiveHubData(store).listProjectItems("hivra").map((i) => i.id)).toContain("coding-team");
  });
});

describe("ships clean and calm", () => {
  it("lists no template section (they lead to example data or a 'built in Unit N' placeholder)", async () => {
    await act(async () => store.start());
    await until(() => store.getSnapshot().status === "ready", "ready");
    const data = createLiveHubData(store);
    for (const id of ["vg-game", "hivra", "nibbii", "hub"]) {
      const kinds = data.listProjectItems(id).map((i) => i.kind);
      expect(kinds).not.toContain("section");
    }
    expect(data.listProjectItems("hivra").map((i) => i.title)).not.toContain("Users & emails");
  });

  it("the strip shows Today, Autopilot, then EXO, Hivra, Nibbii, Hub in that order, each its own grey shape (never a ghost)", async () => {
    mount(createElement(ProjectStrip, { selection: { project: "today", item: "inbox" }, onPickProject: () => undefined, onCreateProject: () => undefined }));
    await until(() => container.querySelectorAll("[data-hub-strip] button").length > 3, "strip");
    const labels = [...container.querySelectorAll("[data-hub-strip] button span.truncate")].map((s) => s.textContent);
    expect(labels).toEqual(["Today", "Autopilot", "EXO", "Hivra", "Nibbii", "Hub"]);
    // Each project wears its shape from Ash OS, grey (Ash picks another from the tile's menu): never the ghost.
    const tiles = [...container.querySelectorAll("[data-hub-strip] [data-project-glyph]")].map((g) => g.getAttribute("data-project-shape"));
    expect(tiles).toEqual(["gamepad", "sparkles", "palette", "gauge"]);
  });

  it("while Ash OS is still writing the summary it shows a quiet line, then swaps the paragraph in place", async () => {
    await stub.close();
    stub = await startStub({ pendingSinceOnce: true });
    url = stub.url;
    mount(surface());
    await until(() => container.querySelector("[data-hub-since-pending]"), "pending line");
    expect(container.querySelector("[data-hub-since-pending]")?.textContent).toBe("Writing up what changed…");
    expect(text()).not.toContain("on their way");
    stub.finishPendingSince();
    await until(() => container.querySelector("[data-hub-since]"), "paragraph", 6000);
    expect(container.querySelector("[data-hub-since-pending]")).toBeNull();
    expect(container.querySelector("[data-hub-since]")?.className).toContain("line-clamp-4");
  });
});

describe("questions and asks open something useful", () => {
  const btn = (scope: string, label: string) =>
    [...container.querySelectorAll(`${scope} button`)].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
  const open = async (row: string) => {
    await until(() => container.querySelector(`[data-hub-need="${row}"]`), `row ${row}`);
    await act(async () => btn(`[data-hub-need="${row}"]`, "See options")!.click());
    await until(() => container.querySelector("[data-hub-question]"), "sheet");
  };

  it("a question with options: the question, the suggestion with Go with this, one row per option (Suggested marked quietly), Not now, Drop it, one Send", async () => {
    mount(surface());
    await open("q2");
    expect(container.querySelector("[data-hub-question]")?.textContent).toBe("Example: skim the new game rules");
    expect(container.querySelector("[data-hub-recommendation]")?.textContent).toContain("Yes: they read like what you said on 12 Oct.");
    const options = [...container.querySelectorAll("[data-hub-question-option]")];
    expect(options.map((o) => o.querySelector("span span")?.textContent)).toEqual(["They match what I meant", "Two of them are off", "Park the rules for now"]);
    expect(options[0].querySelector("[data-hub-suggested]")?.textContent).toBe("Suggested");
    expect([...container.querySelectorAll("[data-hub-quick]")].map((b) => b.textContent)).toEqual(["Go with this", "Not now", "Drop it"]);
    expect(container.querySelectorAll("[data-hub-send]").length).toBe(1);
    expect((container.querySelector("[data-hub-send]") as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('input[placeholder="Say something else…"]')).toBeTruthy();
  });

  it("a question with no options still works: the suggestion, Go with this, Not now, Drop it, Say something else", async () => {
    mount(surface());
    await until(() => container.querySelector('[data-hub-need="q4"]'), "row");
    // q4 is an ask (Open); make a plain question row to open
    stub.addNeed({ id: "q:qx", projectId: "hivra", title: "Example: archive the old waitlist?", why: "My suggestion: Park it for later.", actionType: "see_options", actionTarget: "question:qx" });
    await open("q:qx");
    expect(container.querySelectorAll("[data-hub-question-option]").length).toBe(0);
    expect(container.querySelector("[data-hub-recommendation]")?.textContent).toContain("Park it for later.");
    expect([...container.querySelectorAll("[data-hub-quick]")].map((b) => b.textContent)).toEqual(["Go with this", "Not now", "Drop it"]);
    await act(async () => (container.querySelector('[data-hub-quick="park"]') as HTMLButtonElement).click());
    await until(() => container.querySelector('[data-hub-need="q:qx"][data-hub-need-done]'), "ticked");
    expect(container.querySelector('[data-hub-need="q:qx"] [data-hub-answer-receipt]')?.textContent).toBe("Parked for later. It comes back when you mention it again.");
  });

  it("sending a pick closes the sheet at once; the row says Sending… while the model reads it, then ticks off with the receipt", async () => {
    await stub.close();
    stub = await startStub({ answerDelayMs: 400 });
    url = stub.url;
    mount(surface());
    await open("q2");
    const order = rows();
    act(() => (container.querySelectorAll("[data-hub-question-option]")[1] as HTMLButtonElement).click());
    await act(async () => (container.querySelector("[data-hub-send]") as HTMLButtonElement).click());
    expect(container.querySelector("[data-hub-question]")).toBeNull(); // nothing waits on the sheet
    expect(container.querySelector('[data-hub-need="q2"] [data-hub-sending]')?.textContent).toBe("Sending…");
    expect(container.querySelector('[data-hub-need="q2"] button')).toBeNull();
    await until(() => container.querySelector('[data-hub-need="q2"][data-hub-need-done]'), "ticked");
    expect(container.querySelector('[data-hub-need="q2"] [data-hub-answer-receipt]')?.textContent).toBe("Saved to memory as your decision.");
    expect(rows().slice(0, order.length)).toEqual(order);
  });

  it("words Ash OS can't act on leave the row open with the receipt, its button back", async () => {
    mount(surface());
    await open("q3");
    const input = container.querySelector('input[placeholder="Say something else…"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "something unclear");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => (container.querySelector("[data-hub-send]") as HTMLButtonElement).click());
    await until(() => container.querySelector('[data-hub-need="q3"] [data-hub-answer-receipt]'), "receipt");
    expect(container.querySelector('[data-hub-need="q3"] [data-hub-answer-receipt]')?.textContent).toMatch(/stays open/);
    expect(container.querySelector('[data-hub-need="q3"][data-hub-need-done]')).toBeNull();
    expect(btn('[data-hub-need="q3"]', "See options")).toBeTruthy();
  });

  it("Open on an ask shows it in full (title, why, detail), and no ids", async () => {
    mount(surface());
    await until(() => container.querySelector('[data-hub-need="q4"]'), "ask row");
    await act(async () => btn('[data-hub-need="q4"]', "Open")!.click());
    const sheet = container.querySelector("[data-hub-detail]")!;
    expect(sheet.textContent).toContain("Example: approve the Q4 hiring plan");
    expect(sheet.textContent).toContain("Two roles changed since last week.");
    expect(sheet.textContent).not.toMatch(/a4|ask:/);
  });
});
