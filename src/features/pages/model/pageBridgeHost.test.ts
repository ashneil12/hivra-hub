// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PageBridgeHost, TAP_ONLY, type PageSources } from "./pageBridgeHost";
import { NOT_ASKED, WAITING_ALLOW } from "./bridge";
import type { Capability } from "./pageSpec";

type Msg = Record<string, unknown>;
function fakeSources() {
  const subs = new Map<string, Set<() => void>>();
  let agents = { agents: [{ id: "ed", state: "idle" }] };
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
    { type: "hub:reply", id: "c1", ok: true, result: { agents: [{ id: "ed", state: "idle" }] } },
    { type: "hub:reply", id: "c2", ok: false, error: NOT_ASKED },
  ]);
});

it("a watch gets the data now and again whenever it changes (only when it changed), until it stops", async () => {
  vi.useFakeTimers();
  const { h, src } = host();
  h.receive({ type: "hub:watch", id: "w1", call: "agents.read" });
  await vi.advanceTimersByTimeAsync(0);
  expect(replies()).toEqual([{ type: "hub:reply", id: "w1", ok: true, result: true }]);
  expect(data()).toEqual([{ type: "hub:data", watch: "w1", call: "agents.read", data: { agents: [{ id: "ed", state: "idle" }] } }]);
  src.set({ agents: [{ id: "ed", state: "working" }] });
  src.set({ agents: [{ id: "ed", state: "asking" }] }); // a burst folds into one push
  await vi.advanceTimersByTimeAsync(60);
  expect(data().map((m) => (m.data as { agents: { state: string }[] }).agents[0].state)).toEqual(["idle", "asking"]);
  src.set({ agents: [{ id: "ed", state: "asking" }] }); // nothing new: no push
  await vi.advanceTimersByTimeAsync(60);
  expect(data()).toHaveLength(2);
  h.receive({ type: "hub:unwatch", id: "w1" });
  expect(src.listeners("agents.read")).toBe(0);
});

it("a push the frame did not take is tried again, and the same snapshot is not sent twice once it lands", async () => {
  vi.useFakeTimers();
  let open = false;
  const { h, src } = host({
    post: (m) => {
      if (!open && (m as Msg).type === "hub:data") return false;
      sent.push(m as Msg);
    },
  });
  h.receive({ type: "hub:watch", id: "w1", call: "agents.read" });
  await vi.advanceTimersByTimeAsync(0);
  expect(data()).toEqual([]);
  open = true;
  await vi.advanceTimersByTimeAsync(60);
  expect(data()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(200);
  expect(data()).toHaveLength(1);
  src.set({ agents: [{ id: "ed", state: "working" }] });
  await vi.advanceTimersByTimeAsync(60);
  expect(data().map((m) => (m.data as { agents: { state: string }[] }).agents[0].state)).toEqual(["idle", "working"]);
});

it("a frame that never takes a push is not retried forever", async () => {
  vi.useFakeTimers();
  const { h } = host({
    post: (m) => {
      if ((m as Msg).type === "hub:data") return false;
      sent.push(m as Msg);
    },
  });
  h.receive({ type: "hub:watch", id: "w1", call: "agents.read" });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(data()).toEqual([]);
  const before = sent.length;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(sent.length).toBe(before);
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
  expect(sent.at(-1)).toEqual({ type: "hub:watch-ended", watch: "w1", error: WAITING_ALLOW });
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
  h.receive({ type: "hub:call", id: "a3", call: "agents.message", args: { agentId: "ed", text: "hi" } });
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
  expect(replies()[1].error).toBe("This is a preview: its buttons work once you keep the hub.");
  // mono.run is a tap now (C4): a preview's button waits until the page is kept.
  expect(replies()[2].error).toBe("This is a preview: its buttons work once you keep the hub.");
  expect(acted).toEqual([]);
});

it("mono.run and tasks.write run on Ash's tap on a kept page that asked for them, never on their own (C4)", async () => {
  approved = ["agents.read", "mono.run", "tasks.write"];
  const { h } = host({ asks: ["agents.read", "mono.run", "tasks.write"] });
  h.receive({ type: "hub:call", id: "m1", call: "mono.run", args: { agentId: "ed", text: "Pull signups" } });
  await flush();
  expect(replies()[0]).toEqual({ type: "hub:reply", id: "m1", ok: false, error: TAP_ONLY });
  tapped = true;
  h.receive({ type: "hub:call", id: "m2", call: "mono.run", args: { agentId: "ed", text: "Pull signups" } });
  h.receive({ type: "hub:call", id: "m3", call: "tasks.write", args: { op: "stop", workerId: "d1" } });
  await flush();
  expect(replies().slice(1).map((r) => r.ok)).toEqual([true, true]);
  expect(acted.map((a) => a[0])).toEqual(["mono.run", "tasks.write"]);
  expect(JSON.stringify(replies())).not.toContain("Not connected yet");
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
    "Hubs can't do that: changing Monos and reaching the app directly are never allowed.",
    "Hubs can't do that: changing Monos and reaching the app directly are never allowed.",
    "Only live data can be watched: agents.read, jobs.read, needs.read or rooms.read.",
    "Hubs can't read your keys: a hub can't reach the network, so a key would do nothing inside one.",
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

it("a page's chats are behind its agents read: refused without it, answered with it", async () => {
  const handlers = { "sessions.read": async () => ({ sessions: [{ id: "s1" }], total: 1 }) };
  approved = [];
  const { h } = host({ handlers });
  h.receive({ type: "hub:call", id: "c1", call: "sessions.read" });
  approved = ["agents.read"];
  h.receive({ type: "hub:call", id: "c2", call: "sessions.read" });
  await flush();
  expect(replies()).toEqual([
    { type: "hub:reply", id: "c1", ok: false, error: WAITING_ALLOW },
    { type: "hub:reply", id: "c2", ok: true, result: { sessions: [{ id: "s1" }], total: 1 } },
  ]);
});

it("a web fetch reaches the page's own handler, and its plain refusal comes back as it was written", async () => {
  const handlers = {
    "http.fetch": async (args: Record<string, unknown>) => {
      if (args.url === "https://nope.example.com") throw new Error("This page isn't connected to nope.example.com, so it can't read it.");
      return { status: 200, type: "application/json", body: "{}", url: String(args.url) };
    },
  };
  const { h } = host({ handlers });
  h.receive({ type: "hub:call", id: "c1", call: "http.fetch", args: { url: "https://nope.example.com" } });
  h.receive({ type: "hub:call", id: "c2", call: "http.fetch", args: { url: "https://api.example.com" } });
  const alone = host();
  alone.h.receive({ type: "hub:call", id: "c3", call: "http.fetch", args: { url: "https://api.example.com" } });
  await flush();
  // A call with no handler answers at once, so the order across two pages isn't fixed; the answers are.
  expect(replies().sort((a, b) => String(a.id).localeCompare(String(b.id)))).toEqual([
    { type: "hub:reply", id: "c1", ok: false, error: "This page isn't connected to nope.example.com, so it can't read it." },
    { type: "hub:reply", id: "c2", ok: true, result: { status: 200, type: "application/json", body: "{}", url: "https://api.example.com" } },
    { type: "hub:reply", id: "c3", ok: false, error: "Not connected yet: the app can't do this for hubs yet." },
  ]);
});

// r61 (PM's blind C3 on 0.16.2): a reply typed on a page went nowhere and the page showed nothing either way.
it("every tap's outcome is said on the page by the app: Sending… while it runs, then sent, refused or failed", async () => {
  const { pageActionLog, pageActionRunning, resetPageActionsForTest } = await import("./pageActions");
  resetPageActionsForTest();
  approved = ["agents.read", "agents.stop", "agents.message"] as Capability[];
  // Refused: no tap.
  const { h } = host({ asks: ["agents.read", "agents.stop", "agents.message"] as Capability[] });
  h.receive({ type: "hub:call", id: "r1", call: "agents.message", args: { agentId: "ada", text: "hi" } });
  await flush();
  expect(pageActionLog("pg_1")[0]).toMatchObject({ line: `Didn't go through: ${TAP_ONLY}`, ok: false });
  // Running, then failed with the plain reason.
  tapped = true;
  let fail!: (e: Error) => void;
  const failing = host({ asks: ["agents.message"] as Capability[], act: () => new Promise((_, rej) => { fail = rej; }) }).h;
  failing.receive({ type: "hub:call", id: "r2", call: "agents.message", args: { agentId: "ada", text: "hi" } });
  await flush();
  expect(pageActionRunning("pg_1")).toBe(true);
  fail(new Error("Chief of Staff couldn't take a message right now. Open the chat instead."));
  await flush();
  expect(pageActionRunning("pg_1")).toBe(false);
  expect(pageActionLog("pg_1")[0]).toMatchObject({ line: "Didn't go through: Chief of Staff couldn't take a message right now. Open the chat instead.", ok: false });
  expect(replies().find((m) => m.id === "r2")).toMatchObject({ ok: false });
  resetPageActionsForTest();
});

it("r65: a page that asked but isn't allowed yet says it's waiting for Allow, never \"didn't ask\", and no permission id", async () => {
  approved = [];
  const { h } = host();
  h.receive({ type: "hub:call", id: "c1", call: "agents.read" });
  h.receive({ type: "hub:call", id: "c2", call: "jobs.read" });
  await flush();
  const [a, b] = replies() as { error: string }[];
  expect(a.error).toBe(WAITING_ALLOW);
  expect(b.error).toBe(NOT_ASKED);
  for (const e of [a.error, b.error]) expect(e).not.toMatch(/agents\.read|jobs\.read|didn't ask for/);
});
