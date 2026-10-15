// @vitest-environment happy-dom
// The live Today and project strip, rendered against the stub server: what Ash sees when Ash OS is there, when a
// Need ticks itself off, when it is slow to answer and when it isn't running. Never example data.
import http from "node:http";
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startStub, type Stub } from "../../../../scripts/hub-stub-server.mjs";
import { HubStore } from "../model/hubStore";
import { HubCallError, type HubTransport } from "../model/hubTransport";
import { setHubDataSource } from "../model/hubData";
import { createLiveHubData } from "../model/liveHubData";
import { ProjectStrip } from "./ProjectStrip";
import { HubSurface } from "./HubSurface";
import { BeingBuiltView } from "./BeingBuiltView";
import { MonoRailSection } from "../../../app/shell/MonoRailSection";
import { hubMonoRank } from "../model/hubData";

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
  stub = await startStub({ jobs: true });
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

const click = (selector: string) => act(() => (container.querySelector(selector) as HTMLElement).click());
const button = (scope: string, label: string) =>
  [...container.querySelectorAll(`${scope} button`)].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;

describe("Later, Older, Looks right and the options sheet", () => {
  it("Later is a quiet line that opens its rows; Older is collapsed, counted on its own and in no badge", async () => {
    mount(createElement("div", null, createElement(ProjectStrip, { selection: { project: "today", item: "inbox" }, onPickProject: () => undefined, onCreateProject: () => undefined }), surface()));
    await until(() => rows().length >= 8, "needs");
    // Older (3): one quiet line at the bottom of Today, shut
    const older = container.querySelector("[data-hub-older] > button")!;
    expect(older.textContent).toBe("Older (3)");
    expect(older.getAttribute("aria-expanded")).toBe("false");
    expect(text()).not.toContain("Recovered from an old chat");
    // not in any badge: Hivra has 2 real Needs (the headline and the given-up job), 2 old ones
    const badge = (name: string) => container.querySelector(`button[aria-label^="${name}"] span.hub-count-badge`)?.textContent;
    expect(badge("Hivra")).toBe("2");
    expect(badge("EXO")).toBe("2");
    act(() => (older as HTMLElement).click());
    expect(text()).toContain("Example: which Hivra folder is the real one?");
    expect([...container.querySelectorAll("[data-hub-older] h2")].map((h) => h.textContent)).toEqual(["Hivra", "EXO"]);
    expect(badge("Hivra")).toBe("2"); // opening it changes no count
    // Later (the harness has one past five): a line that opens
    const later = container.querySelector("[data-hub-later] > button")!;
    expect(later.textContent).toBe("1 more under Later");
    act(() => (later as HTMLElement).click());
    expect(later.textContent).toBe("Hide Later");
  });

  it("a Looks-right row shows Ash OS's own action, Looks right, which accepts it and ticks it off", async () => {
    mount(surface());
    await until(() => container.querySelector('[data-hub-need="s:a_cannon"]'), "looks-right row");
    const row = '[data-hub-need="s:a_cannon"]';
    expect(container.querySelectorAll(`${row} button`).length).toBe(1);
    await act(async () => button(row, "Looks right")!.click());
    await until(() => container.querySelector(`${row}[data-hub-need-done]`), "ticked");
    expect(container.querySelector(`${row} button`)).toBeNull();
    expect(stub.calls.some((c) => c.path === "/api/ash-hub-need-accept")).toBe(true);
    expect(stub.calls.some((c) => c.path === "/api/ash-hub-need-seen")).toBe(false);
  });

  it("an older Looks-right row (action Open) keeps its one action, Seen", async () => {
    mount(surface());
    await until(() => container.querySelector('[data-hub-need="s:a_legacy"]'), "legacy row");
    const row = '[data-hub-need="s:a_legacy"]';
    expect([...container.querySelectorAll(`${row} button`)].map((b) => b.textContent)).toEqual(["Seen"]);
    await act(async () => button(row, "Seen")!.click());
    await until(() => container.querySelector(`${row}[data-hub-need-done]`), "ticked");
    expect(stub.calls.some((c) => c.path === "/api/ash-hub-need-seen")).toBe(true);
  });

  it("a given-up job is one red row: a 14px circle and a plain grey word, then See options", async () => {
    mount(surface());
    await until(() => container.querySelector('[data-hub-need="j:j_sender"]'), "given-up row");
    const row = '[data-hub-need="j:j_sender"]';
    const mark = container.querySelector(`${row} [data-hub-circle]`)!;
    expect(mark.getAttribute("data-hub-circle")).toBe("red");
    expect(mark.textContent).toBe("Needs you");
    expect(mark.querySelector("svg")?.getAttribute("width")).toBe("14");
    expect(mark.className).toContain("text-content/60");
    expect(container.querySelectorAll(`${row} button`).length).toBe(1);
    expect(button(row, "See options")).toBeTruthy();
  });

  it("See options shows the four choices; Try it a different way asks for a hint; the pick goes to Ash OS and the row ticks off", async () => {
    mount(surface());
    await until(() => container.querySelector('[data-hub-need="j:j_sender"]'), "given-up row");
    await act(async () => button('[data-hub-need="j:j_sender"]', "See options")!.click());
    await until(() => container.querySelector("[data-hub-options-sheet] [data-hub-option]"), "the sheet");
    const labels = [...container.querySelectorAll("[data-hub-option]")].map((o) => o.querySelector(".text-content")?.textContent);
    expect(labels).toEqual(["Try again tonight", "Try it a different way…", "Pause this job", "Drop it"]);
    // no hint box until asked; Send needs words
    expect(container.querySelector("[data-hub-options-sheet] input")).toBeNull();
    await act(async () => button('[data-hub-option="try_different"]', "Write a hint")!.click());
    const input = container.querySelector("[data-hub-options-sheet] input") as HTMLInputElement;
    expect(input.placeholder).toBe("A hint for the coding team lead");
    expect(button('[data-hub-option="try_different"]', "Send")!.disabled).toBe(true);
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "use the other login");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button('[data-hub-option="try_different"]', "Send")!.click());
    await until(() => !container.querySelector("[data-hub-options-sheet]"), "sheet closed");
    await until(() => container.querySelector('[data-hub-need="j:j_sender"][data-hub-need-done]'), "row ticked");
    const call = stub.calls.filter((c) => c.path === "/api/ash-hub-job-act").at(-1)!;
    expect(call.query).toEqual({});
    expect(stub.state.jobs.find((j) => j.id === "j_sender")).toMatchObject({ state: "sent_to_lead", hint: "use the other login" });
  });

  it("Pause is one press and says nothing more; a refusal is shown in plain words and the sheet stays", async () => {
    mount(surface());
    await until(() => container.querySelector('[data-hub-need="j:j_sender"]'), "given-up row");
    await act(async () => button('[data-hub-need="j:j_sender"]', "See options")!.click());
    await until(() => container.querySelector("[data-hub-option]"), "the sheet");
    stub.setJob("j_sender", { state: "working" }); // it moved on while the sheet was open
    await act(async () => button('[data-hub-option="pause"]', "Choose")!.click());
    await until(() => container.querySelector("[data-hub-options-problem]"), "problem");
    expect(container.querySelector("[data-hub-options-problem]")?.textContent).toBe("That job isn't waiting on you.");
    expect(container.querySelector("[data-hub-options-sheet]")).toBeTruthy();
    click("[data-hub-options-sheet] .flex.justify-end button");
    expect(container.querySelector("[data-hub-options-sheet]")).toBeNull();
  });

  it("a stuck job is an amber row with its reason and when it was sent, and no button", async () => {
    mount(surface());
    await until(() => text().includes("Moving the nightly backup"), "stuck row");
    const stuck = [...container.querySelectorAll("div")].find((d) => d.textContent?.startsWith("Moving the nightly backup") && d.className.includes("hover:bg-content/5"))!;
    expect(stuck.querySelector('[data-hub-circle="amber"]')?.textContent).toBe("Stuck");
    expect(stuck.textContent).toContain("The disk was full twice.");
    expect(stuck.querySelector("[data-hub-sent]")?.textContent).toMatch(/^Sent to coding team lead at .* · Got it$/);
    expect(stuck.querySelector("button")).toBeNull();
  });
});

describe("Being built, live", () => {
  const view = () => createElement(BeingBuiltView, { projectId: "hivra" });
  const state = (id: string) => container.querySelector(`[data-hub-worker="${id}"] [data-hub-job-state]`)?.getAttribute("data-hub-job-state");

  it("one row per job under its Lead, in Ash OS's order, with no helpers named", async () => {
    mount(view());
    await until(() => container.querySelector("[data-hub-mono-jobs]"), "groups");
    expect([...container.querySelectorAll("[data-hub-mono-jobs]")].map((g) => g.getAttribute("data-hub-mono-jobs"))).toEqual(["Hivra lead"]);
    expect([...container.querySelectorAll("[data-hub-worker]")].map((r) => r.getAttribute("data-hub-worker"))).toEqual(["j_mail", "j_backup", "j_sender", "j_footer"]);
    expect(text()).not.toMatch(/helper|worker/i);
  });

  it("Working is quiet, Stuck is amber with the reason on a second line, Needs you and Done are a dot and plain text", async () => {
    mount(view());
    await until(() => container.querySelector("[data-hub-worker]"), "rows");
    expect(state("j_mail")).toBe("working");
    expect(container.querySelector('[data-hub-worker="j_mail"] [data-hub-job-state]')?.className).toContain("text-content/60");
    expect(state("j_backup")).toBe("stuck");
    const stuck = container.querySelector('[data-hub-worker="j_backup"]')!;
    expect(stuck.querySelector("svg circle")?.getAttribute("stroke")).toBe("rgb(245 158 11)");
    expect(stuck.querySelector("[data-hub-job-reason]")?.textContent).toBe("The disk was full twice.");
    expect(stuck.querySelector("[data-hub-job-sent]")?.textContent).toMatch(/^Sent to coding team lead at .* · Got it$/);
    expect(state("j_sender")).toBe("needs_you");
    expect(container.querySelector('[data-hub-worker="j_sender"] [data-hub-job-state]')?.textContent).toBe("Needs you");
    expect(container.querySelector('[data-hub-worker="j_sender"] [data-hub-job-state] .rounded-full')?.textContent).toBe("");
    expect(state("j_footer")).toBe("done_unseen");
    expect(container.querySelector('[data-hub-worker="j_footer"] [aria-label="Not seen yet"]')).toBeTruthy();
    // no filled pill anywhere: only the two small dots (Needs you, Done)
    expect(container.querySelectorAll("[data-hub-job-state] .rounded-full").length).toBe(2);
    expect(container.querySelectorAll("[data-hub-job-state] .px-2").length).toBe(0);
  });

  it("columns are fixed width, so rows line up whatever the state", async () => {
    mount(view());
    await until(() => container.querySelectorAll("[data-hub-worker]").length === 4, "rows");
    const cols = [...container.querySelectorAll("[data-hub-worker]")].map((r) => [...r.children].slice(1).map((c) => c.className.split(" ").filter((k) => /^w-\d+$/.test(k)).join("")));
    expect(new Set(cols.map((c) => c.join(","))).size).toBe(1);
    expect(cols[0]).toEqual(["w-28", "w-24", "w-24"]);
  });

  it("a change from the feed lands in place: a job's state changes, a new one joins the end, nothing moves", async () => {
    mount(view());
    await until(() => container.querySelectorAll("[data-hub-worker]").length === 4, "rows");
    const before = [...container.querySelectorAll("[data-hub-worker]")];
    stub.setJob("j_mail", { state: "checking" });
    await until(() => state("j_mail") === "checking", "state change");
    const after = [...container.querySelectorAll("[data-hub-worker]")];
    expect(after.map((r) => r.getAttribute("data-hub-worker"))).toEqual(before.map((r) => r.getAttribute("data-hub-worker")));
    expect(after[0]).toBe(before[0]); // the same element: not re-created, so not under the mouse any differently
    stub.addJob({ id: "j_late", projectId: "hivra", title: "Another job", leadName: "Hivra lead", lead: "hivra-lead" });
    await until(() => container.querySelector('[data-hub-worker="j_late"]'), "new job");
    expect([...container.querySelectorAll("[data-hub-worker]")].map((r) => r.getAttribute("data-hub-worker")).at(-1)).toBe("j_late");
    expect(container.querySelector('[data-hub-worker="j_late"]')?.className).toContain("hub-fade-in");
  });

  it("leaving the page tells Ash OS the finished jobs were seen, and they go", async () => {
    mount(view());
    await until(() => container.querySelector('[data-hub-worker="j_footer"]'), "done row");
    mount(createElement("div"));
    await new Promise((r) => setTimeout(r, 80));
    expect(stub.calls.some((c) => c.path === "/api/ash-hub-job-seen")).toBe(true);
    expect(stub.state.jobs.find((j) => j.id === "j_footer")).toMatchObject({ seen: true });
  });

  it("React's dev double-run does not count as leaving: a finished job keeps its dot until Ash really leaves", async () => {
    mount(createElement(StrictMode, null, view()));
    await until(() => container.querySelector('[data-hub-worker="j_footer"]'), "done row");
    await new Promise((r) => setTimeout(r, 60));
    expect(stub.calls.some((c) => c.path === "/api/ash-hub-job-seen")).toBe(false);
    expect(container.querySelector('[data-hub-worker="j_footer"] [aria-label="Not seen yet"]')).toBeTruthy();
    mount(createElement("div"));
    await new Promise((r) => setTimeout(r, 80));
    expect(stub.calls.some((c) => c.path === "/api/ash-hub-job-seen")).toBe(true);
  });

  it("with nothing being built it says so quietly", async () => {
    mount(createElement(BeingBuiltView, { projectId: "ash" }));
    await until(() => container.querySelector("[data-hub-being-built-empty]"), "empty");
    expect(text()).toContain("Nobody's working on");
  });
});

describe("point 13, item 3: a big job's workers show only in Being built, and only while it runs", () => {
  const ROSTER = ["Chief of Staff", "Projects Manager", "frank", "Alfred", "Hivra lead"];
  const sidebar = () => [...container.querySelectorAll("[data-mono-rail] [data-mono-status] > button[title]")].map((b) => b.getAttribute("title")!.split("\n")[0]).filter((t) => t !== "Mono options");
  const rowsNow = () => [...container.querySelectorAll("[data-hub-worker]")].map((r) => r.getAttribute("data-hub-worker"));
  const page = () =>
    createElement("div", null,
      createElement(MonoRailSection, { states: new Map(), onOpen: () => {}, onCreate: () => {}, onDelete: () => {}, rank: hubMonoRank }),
      createElement(BeingBuiltView, { projectId: "hivra" }));

  it("running: the job's workers are rows under the Lead; done: they go; the Monos sidebar never changes", async () => {
    localStorage.setItem("monocode:mono-roster", JSON.stringify(ROSTER.map((name, i) => ({ id: i === 4 ? "hivra-lead" : `m${i}`, name, mascot: "robot", color: "x", projects: [] }))));
    mount(page());
    await until(() => rowsNow().length === 4, "rows");
    expect(sidebar()).toEqual(ROSTER);
    // A big job: the Lead splits it over three workers running in parallel. It is ONE row, counted once.
    const big = ["j_big_1", "j_big_2", "j_big_3"];
    big.forEach((id, i) => stub.addJob({ id, projectId: "hivra", title: `Part ${i + 1}`, parentId: "big", parentTitle: "Rebuild the waitlist", leadName: "Hivra lead", lead: "hivra-lead" }));
    await until(() => rowsNow().includes("big:big"), "the big job's row");
    expect(rowsNow()).toEqual(["j_mail", "j_backup", "j_sender", "j_footer", "big:big"]);
    const row = () => container.querySelector('[data-hub-worker="big:big"]')!;
    expect(row().textContent).toContain("Rebuild the waitlist, 0 of 3 parts done");
    expect(row().querySelector("[data-hub-last-active]")?.textContent).toBe("just started");
    expect(row().getAttribute("aria-expanded")).toBe("false");
    act(() => (row() as HTMLElement).click());
    expect([...container.querySelectorAll('[data-hub-parts-of="big:big"] [data-hub-worker]')].map((r) => r.getAttribute("data-hub-worker"))).toEqual(big);
    expect(sidebar()).toEqual(ROSTER); // no worker became a Mono
    expect(container.querySelector("[data-mono-rail]")?.textContent).not.toMatch(/Part \d|Rebuild|worker/i);
    // One part done: the count moves, the row stays.
    stub.setJob("j_big_1", { state: "done", finishedAt: new Date().toISOString() });
    await until(() => row()?.textContent?.includes("1 of 3 parts done"), "one part done");
    expect(rowsNow().filter((id) => !big.includes(id!))).toEqual(["j_mail", "j_backup", "j_sender", "j_footer", "big:big"]);
    // All done: the row is Done and shows the time it finished, not a duration.
    stub.setJob("j_big_2", { state: "done", finishedAt: new Date().toISOString() });
    stub.setJob("j_big_3", { state: "done", finishedAt: new Date().toISOString() });
    await until(() => row()?.querySelector("[data-hub-job-state]")?.getAttribute("data-hub-job-state") === "done_unseen", "big job done");
    expect(row().querySelector("[data-hub-last-active]")?.textContent).toMatch(/^\d{1,2}:\d{2}(am|pm)$/);
    // Seen: gone from Being built.
    big.forEach((id) => stub.setJob(id, { seen: true }));
    await until(() => !rowsNow().includes("big:big"), "big job gone");
    expect(sidebar()).toEqual(ROSTER);
    expect(JSON.parse(localStorage.getItem("monocode:mono-roster")!).length).toBe(ROSTER.length);
  });
});
