// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PageBridgeHost, TAP_ONLY, type PageSources } from "./pageBridgeHost";
import type { Capability } from "./pageSpec";

type Msg = Record<string, unknown>;
function fakeSources() {
  const subs = new Map<string, Set<() => void>>();
  let agents = { agents: [{ id: "frank", state: "idle" }] };
  const source = (name: string, read: (args: Record<string, unknown>) => unknown) => ({
    read,
    subscribe(fn: () => void) {
      const set = subs.get(name) ?? new Set();
      set.add(fn);
      subs.set(name, set);
      return () => set.delete(fn);
    },
  });
  const sources: PageSources = {
    "agents.read": source("agents.read", () => agents),
    "jobs.read": source("jobs.read", () => ({ jobs: [] })),
    "needs.read": source("needs.read", () => ({ needs: [], waiting: [] })),
    "rooms.read": source("rooms.read", (args) => ({ rooms: [], args })),
  };
  return {
    sources,
    set(next: typeof agents) {
      agents = next;
      subs.get("agents.read")?.forEach((f) => f());
    },
    listeners: (name: string) => subs.get(name)?.size ?? 0,
  };
}

let sent: Msg[];
let approved: Capability[];
let tapped: boolean;
let acted: unknown[][];
function host(over: Partial<ConstructorParameters<typeof PageBridgeHost>[0]> = {}, src = fakeSources()) {
  const h = new PageBridgeHost({
    pageId: "pg_1", title: "Agents", live: true, asks: ["agents.read", "agents.stop", "rooms.read"],
    approved: () => approved, tapped: () => tapped, post: (m) => sent.push(m as Msg), sources: src.sources, throttleMs: 50,
    act: async (call, args, ctx) => { acted.push([call, args, ctx]); return { done: "Stopped it" }; },
    ...over,
  });
  return { h, src };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const replies = () => sent.filter((m) => m.type === "hub:reply");
const data = () => sent.filter((m) => m.type === "hub:data");

beforeEach(() => {
  sent = [];
  approved = ["agents.read", "agents.stop", "rooms.read"];
  tapped = false;
  acted = [];
});
afterEach(() => vi.useRealTimers());

it("answers a read Ash allowed, once, and refuses one he didn't", async () => {
  const { h } = host();
  h.receive({ type: "hub:call", id: "c1", call: "agents.read" });
  h.receive({ type: "hub:call", id: "c2", call: "jobs.read" });
  await flush();
  expect(replies()).toEqual([
    { type: "hub:reply", id: "c1", ok: true, result: { agents: [{ id: "frank", state: "idle" }] } },
    { type: "hub:reply", id: "c2", ok: false, error: "This page didn't ask for “jobs.read”, so it can't use it." },
  ]);
});

it("a watch gets the data now and again whenever it changes (only when it changed), until it stops", async () => {
  vi.useFakeTimers();
  const { h, src } = host();
  h.receive({ type: "hub:watch", id: "w1", call: "agents.read" });
  await vi.advanceTimersByTimeAsync(0);
  expect(replies()).toEqual([{ type: "hub:reply", id: "w1", ok: true, result: true }]);
  expect(data()).toEqual([{ type: "hub:data", watch: "w1", call: "agents.read", data: { agents: [{ id: "frank", state: "idle" }] } }]);
  src.set({ agents: [{ id: "frank", state: "working" }] });
  src.set({ agents: [{ id: "frank", state: "asking" }] }); // a burst folds into one push
  await vi.advanceTimersByTimeAsync(60);
  expect(data().map((m) => (m.data as { agents: { state: string }[] }).agents[0].state)).toEqual(["idle", "asking"]);
  src.set({ agents: [{ id: "frank", state: "asking" }] }); // nothing new: no push
  await vi.advanceTimersByTimeAsync(60);
  expect(data()).toHaveLength(2);
  h.receive({ type: "hub:unwatch", id: "w1" });
  expect(src.listeners("agents.read")).toBe(0);
});

it("a watch passes its args to the read", async () => {
  const { h } = host();
  h.receive({ type: "hub:watch", id: "w1", call: "rooms.read", args: { projectId: "hivra" } });
  await flush();
  expect(data()[0].data).toEqual({ rooms: [], args: { projectId: "hivra" } });
});

it("Undo stops a watch: the next change finds the permission gone and ends it", async () => {
  vi.useFakeTimers();
  const { h, src } = host();
  h.receive({ type: "hub:watch", id: "w1", call: "agents.read" });
  await vi.advanceTimersByTimeAsync(0);
  approved = [];
  src.set({ agents: [] });
  await vi.advanceTimersByTimeAsync(60);
  expect(sent.at(-1)).toEqual({ type: "hub:watch-ended", watch: "w1", error: "This page didn't ask for “agents.read”, so it can't use it." });
  expect(src.listeners("agents.read")).toBe(0);
});

it("an action runs only on Ash's tap inside the page, and only on a kept page", async () => {
  const { h } = host();
  h.receive({ type: "hub:call", id: "a1", call: "agents.stop", args: { workerId: "d1" } });
  await flush();
  expect(replies()[0]).toEqual({ type: "hub:reply", id: "a1", ok: false, error: TAP_ONLY });
  tapped = true;
  h.receive({ type: "hub:call", id: "a2", call: "agents.stop", args: { workerId: "d1" } });
  await flush();
  expect(replies()[1]).toEqual({ type: "hub:reply", id: "a2", ok: true, result: { done: "Stopped it" } });
  expect(acted).toEqual([["agents.stop", { workerId: "d1" }, { pageId: "pg_1", pageTitle: "Agents" }]]);
  // An action it didn't ask for is refused even on a tap.
  h.receive({ type: "hub:call", id: "a3", call: "agents.message", args: { agentId: "frank", text: "hi" } });
  await flush();
  expect(replies()[2].ok).toBe(false);
});

it("a preview shows live data it asked to read, but its buttons and everything else wait until it's kept", async () => {
  const { h } = host({ live: false, asks: ["agents.read", "agents.stop", "mono.run"], approved: () => [] });
  tapped = true;
  h.receive({ type: "hub:call", id: "c1", call: "agents.read" });
  h.receive({ type: "hub:call", id: "c2", call: "agents.stop", args: {} });
  h.receive({ type: "hub:call", id: "c3", call: "mono.run", args: {} });
  await flush();
  expect(replies().map((r) => r.ok)).toEqual([true, false, false]);
  expect(replies()[1].error).toBe("This is a preview: its buttons work once you keep the page.");
  expect(replies()[2].error).toBe("This is a preview: it can do that once you keep the page.");
  expect(acted).toEqual([]);
});

it("the walls stay: never Monos, never the app itself; anything unknown is refused plainly", async () => {
  approved = ["monos.delete" as Capability];
  const { h } = host();
  h.receive({ type: "hub:call", id: "c1", call: "monos.delete" });
  h.receive({ type: "hub:watch", id: "w1", call: "monos.delete" });
  h.receive({ type: "hub:watch", id: "w2", call: "agents.stop" });
  // A key is refused however the page frames it, even with "keys.read" in what is approved: there is nothing to approve.
  h.receive({ type: "hub:call", id: "c2", call: "keys.read", args: { name: "Anthropic" } });
  h.receive({ nonsense: true });
  await flush();
  expect(replies().map((r) => r.error)).toEqual([
    "Pages can't do that: changing Monos and reaching the app directly are never allowed.",
    "Pages can't do that: changing Monos and reaching the app directly are never allowed.",
    "Only live data can be watched: agents.read, jobs.read, needs.read or rooms.read.",
    "Pages can't read your keys: a page can't reach the network, so a key would do nothing inside one.",
  ]);
});

it("the page's height comes back clamped, and closing the page lets go of every watch", async () => {
  const sizes: number[] = [];
  const { h, src } = host({ onSize: (px) => sizes.push(px) });
  h.receive({ type: "hub:size", height: 812.4 });
  h.receive({ type: "hub:size", height: 20 });
  h.receive({ type: "hub:size", height: 99999 });
  expect(sizes).toEqual([813, 160, 4000]);
  h.receive({ type: "hub:watch", id: "w1", call: "agents.read" });
  await flush();
  h.dispose();
  expect(src.listeners("agents.read")).toBe(0);
});

it("a read that throws tells the page why (onError) instead of leaving it blank, once, and the watch stays (C3 22 Oct)", async () => {
  let fail = true;
  const src = fakeSources();
  const broken = { ...src.sources["agents.read"], read: () => { if (fail) throw new Error("bad row"); return { agents: [] }; } };
  const { h } = host({}, { ...src, sources: { ...src.sources, "agents.read": broken } });
  h.receive({ type: "hub:watch", id: "w1", call: "agents.read", args: {} });
  await flush();
  expect(sent.filter((m) => m.type === "hub:watch-error")).toEqual([{ type: "hub:watch-error", watch: "w1", error: "Couldn't read that just now: bad row" }]);
  fail = false;
  src.set({ agents: [] });
  await new Promise((r) => setTimeout(r, 80));
  expect(data().map((m) => m.watch)).toEqual(["w1"]);
});
