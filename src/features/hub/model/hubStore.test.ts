// The live store against the stub server (scripts/hub-stub-server.mjs): real HTTP, real server-sent events.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startStub, type Stub } from "../../../../scripts/hub-stub-server.mjs";
import { bridgeTransport, createStubBridge } from "../../../dev/hubStubBridge";
import { HubStore, mergeStable } from "./hubStore";
import type { Need } from "./types";

const FAST = { coalesceMs: 10, healthMs: 30, pollMs: 80, retryMs: [30, 60], stopGraceMs: 5 };

async function waitFor<T>(read: () => T | undefined | false, what: string, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

let stub: Stub;
let store: HubStore;
const stores: HubStore[] = [];

function makeStore(url = stub.url, getToken: () => string = () => stub.token): HubStore {
  const s = new HubStore({ transport: bridgeTransport(createStubBridge(url, getToken)), ...FAST });
  stores.push(s);
  return s;
}
const needIds = (s: HubStore, pid: string) => s.getSnapshot().needs[pid]?.shown.map((n) => n.id) ?? [];
const needsCalls = () => stub.calls.filter((c) => c.path === "/api/ash-hub-needs").length;

beforeEach(async () => {
  stub = await startStub({ pingMs: 200 });
  store = makeStore();
});
afterEach(async () => {
  stores.splice(0).forEach((s) => s.stop());
  await stub.close();
});

describe("first read", () => {
  it("loads projects, Needs and Since from Ash OS and says ready", async () => {
    store.start();
    expect(store.getSnapshot().status).toBe("loading");
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    const snap = store.getSnapshot();
    expect(snap.projects.map((p) => p.id)).toEqual(["exo-game", "hivra", "nibbii", "org"]);
    expect(snap.projects[0]).toEqual({ id: "exo-game", name: "EXO game", shortName: "EXO", iconShape: "ghost", folder: "/Users/example/Projects/exo-game" });
    expect(snap.projects[3].folder).toBeNull();
    await waitFor(() => store.getSnapshot().since, "since");
    expect(store.getSnapshot().since?.overall.plainText).toContain("Example:");
  });

  it("never calls the old 927 KB page call, only ash-hub-* actions, with the key and a local Host", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().since, "since");
    expect(stub.calls.length).toBeGreaterThan(2);
    for (const c of stub.calls) {
      expect(c.path).toMatch(/^\/api\/ash-hub-[a-z-]+$/);
      expect(c.headers.authorization).toBe(`Bearer ${stub.token}`);
      expect(c.headers.host).toBe(`127.0.0.1:${stub.port}`);
    }
  });

  it("keeps Ash OS's own time strings as ISO timestamps, not display text", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().since, "since");
    const snap = store.getSnapshot();
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
    expect(snap.sinceAt).toMatch(iso);
    expect(snap.lastActiveAt).toMatch(iso);
    for (const rows of Object.values(snap.needs)) for (const n of [...rows.shown, ...rows.later]) expect(n.since).toMatch(iso);
  });

  it("shows at most 5 Needs per project and files the rest under Later, so counts match the rows", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    const org = store.getSnapshot().needs.org;
    expect(org.shown).toHaveLength(5);
    expect(org.later.map((n) => n.id)).toEqual(["q9"]);
    expect(org.later[0].later).toBe(true);
    expect(org.shown.some((n) => n.later)).toBe(false);
  });

  it("starts the feed at the number the first read returned", async () => {
    store.start();
    await waitFor(() => stub.calls.some((c) => c.path === "/api/ash-hub-events"), "feed");
    const call = stub.calls.find((c) => c.path === "/api/ash-hub-events")!;
    expect(call.query.after).toBe(String(stub.latest));
    expect(call.query.stream).toBe("1");
  });
});

describe("live changes land in place", () => {
  it("a new Need joins at the bottom of its group and nothing above it moves", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    const before = needIds(store, "exo-game");
    const firstRowObject = store.getSnapshot().needs["exo-game"].shown[0];
    // rank 0 would sort first if the store re-sorted
    stub.addNeed({ id: "q10", projectId: "exo-game", title: "Example: urgent thing", rank: 0 });
    await waitFor(() => needIds(store, "exo-game").includes("q10"), "new need");
    expect(needIds(store, "exo-game")).toEqual([...before, "q10"]);
    expect(store.getSnapshot().needs["exo-game"].shown[0]).toEqual(firstRowObject);
  });

  it("a Need answered somewhere else ticks itself off where it stands, and stops counting", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    stub.addNeed({ id: "q10", projectId: "org", title: "Example: sixth thing", rank: 9 });
    await waitFor(() => store.getSnapshot().needs.org.later.some((n) => n.id === "q10"), "sixth need under Later");
    const order = needIds(store, "org");
    expect(order).toEqual(["q4", "q5", "q6", "q7", "q8"]);
    stub.doneNeed("q5", "answered");
    const ticked = await waitFor(() => store.getSnapshot().needs.org.shown.find((n) => n.id === "q5" && n.state === "done"), "tick");
    expect(ticked.doneReason).toBe("answered");
    // the Need waiting under Later moves up to the bottom of the list; the ticked row and the rest did not move
    await waitFor(() => needIds(store, "org").includes("q10"), "promotion");
    expect(needIds(store, "org")).toEqual([...order, "q10"]);
    expect(store.getSnapshot().needs.org.later.map((n) => n.id)).toEqual(["q9"]);
  });

  it("ticked rows stay until Ash leaves the page, then go and stay gone while Ash OS still lists them", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    stub.doneNeed("q1");
    await waitFor(() => store.getSnapshot().needs["exo-game"].shown.some((n) => n.state === "done"), "tick");
    store.dismissDone();
    expect(needIds(store, "exo-game")).toEqual(["q2"]);
    stub.addNeed({ id: "q11", projectId: "exo-game", title: "Example: another" });
    await waitFor(() => needIds(store, "exo-game").includes("q11"), "refresh");
    expect(needIds(store, "exo-game")).toEqual(["q2", "q11"]);
  });

  it("a burst of changes becomes one read of Needs, not one per event", async () => {
    store.start();
    await waitFor(() => stub.calls.some((c) => c.path === "/api/ash-hub-events"), "feed");
    await new Promise((r) => setTimeout(r, 50));
    const before = needsCalls();
    for (let i = 0; i < 8; i++) stub.addNeed({ id: `burst${i}`, projectId: "hivra", title: `Example: burst ${i}` });
    const has = (id: string) => { const r = store.getSnapshot().needs.hivra; return [...r.shown, ...r.later].some((n) => n.id === id); };
    await waitFor(() => has("burst7"), "all burst needs");
    await new Promise((r) => setTimeout(r, 100));
    expect(needsCalls() - before).toBeLessThanOrEqual(2);
  });

  it("a new project appears on the strip without touching the others", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    stub.addProject({ id: "side", name: "Side thing" });
    await waitFor(() => store.getSnapshot().projects.some((p) => p.id === "side"), "project");
    expect(store.getSnapshot().projects.map((p) => p.id)).toEqual(["exo-game", "hivra", "nibbii", "org", "side"]);
    expect(store.getSnapshot().projects.at(-1)?.iconShape).toBe("folder");
  });

  it("the Since paragraph is swapped in when the model's text is ready, without a reload", async () => {
    await stub.close();
    stub = await startStub({ pendingSinceOnce: true, pingMs: 200 });
    store = makeStore();
    store.start();
    await waitFor(() => store.getSnapshot().since?.pending, "pending since");
    expect(store.getSnapshot().since?.overall.plainText).toMatch(/on their way/);
    stub.finishPendingSince();
    await waitFor(() => store.getSnapshot().since?.pending === false, "finished since");
    expect(store.getSnapshot().since?.overall.plainText).toContain("Org has five decisions");
  });

  it("Since for one project and for all of them come from the same read", async () => {
    store.start();
    const since = await waitFor(() => store.getSnapshot().since, "since");
    expect(since.byProject["exo-game"].plainText).toContain("new level");
    expect(since.byProject.nibbii).toBeUndefined();
  });
});

describe("Ash's activity", () => {
  it("tells Ash OS the time of the real input, and picks up the new Since time after a gap", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().since, "since");
    const before = store.getSnapshot().sinceAt;
    stub.setActivity({ lastActive: Date.now() - 2 * 3600_000 });
    const at = new Date(Date.now() - 5000);
    await store.reportActive(at);
    const call = stub.calls.filter((c) => c.path === "/api/ash-hub-active").at(-1);
    expect(call).toBeTruthy();
    await waitFor(() => store.getSnapshot().sinceAt !== before, "new since time");
  });

  it("an activity failure is never shown", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    await stub.close();
    await expect(store.reportActive(new Date())).resolves.toBeUndefined();
  });
});

describe("Ash OS restarts", () => {
  it("reads everything again after the 'code version' event, with the new key", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    const before = stub.calls.filter((c) => c.path === "/api/ash-hub-projects").length;
    stub.state.projects.push({ id: "late", name: "Late", shortName: "Late", iconShape: "folder", folder: null, workOwner: "ash_os", status: "active" });
    stub.restart({ newToken: "second-key-after-restart" });
    await waitFor(() => store.getSnapshot().projects.some((p) => p.id === "late"), "reload after restart");
    expect(stub.calls.filter((c) => c.path === "/api/ash-hub-projects").length).toBeGreaterThan(before);
  });

  it("goes unreachable when Ash OS stops, keeps what it had, and recovers by itself when it is back", async () => {
    const port = stub.port;
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    const had = store.getSnapshot().projects;
    await stub.close();
    const down = await waitFor(() => (store.getSnapshot().status === "unreachable" ? store.getSnapshot() : undefined), "unreachable");
    expect(down.message).toBe("Ash OS isn't running.");
    expect(down.projects).toEqual(had);
    stub = await startStub({ port, token: "after-restart-key" });
    // the store reads the key fresh each time, like the Rust plugin
    (store as unknown as { t: unknown }).t = bridgeTransport(createStubBridge(stub.url, () => stub.token));
    await waitFor(() => store.getSnapshot().status === "ready", "recovered", 6000);
  });

  it("starts as unreachable, never as example data, when Ash OS was never there", async () => {
    const dead = await startStub();
    const url = dead.url;
    await dead.close();
    const lonely = makeStore(url);
    lonely.start();
    const snap = await waitFor(() => (lonely.getSnapshot().status === "unreachable" ? lonely.getSnapshot() : undefined), "unreachable");
    expect(snap.projects).toEqual([]);
    expect(snap.needs).toEqual({});
    expect(snap.since).toBeUndefined();
    expect(snap.loadedOnce).toBe(false);
  });

  it("the retry button reads again at once and shows 'trying' meanwhile", async () => {
    const dead = await startStub();
    const url = dead.url;
    const port = dead.port;
    await dead.close();
    const lonely = new HubStore({ transport: bridgeTransport(createStubBridge(url, () => "any")), ...FAST, retryMs: [60_000] });
    stores.push(lonely);
    lonely.start();
    await waitFor(() => lonely.getSnapshot().status === "unreachable", "unreachable");
    stub = await startStub({ port, token: "any" });
    lonely.retry();
    expect(lonely.getSnapshot().retrying).toBe(true);
    await waitFor(() => lonely.getSnapshot().status === "ready", "ready after retry");
    expect(lonely.getSnapshot().retrying).toBe(false);
  });

  it("an old service that doesn't know the hub calls is shown as down, not as an empty app", async () => {
    stub.state.projects.length = 0;
    const odd = new HubStore({
      transport: {
        call: async () => {
          throw Object.assign(new Error("Unknown hub action"), { kind: "error", message: "Unknown hub action" });
        },
        openFeed: () => () => undefined,
      },
      ...FAST,
      retryMs: [60_000],
    });
    stores.push(odd);
    odd.start();
    await waitFor(() => odd.getSnapshot().status === "unreachable", "unreachable");
    expect(odd.getSnapshot().loadedOnce).toBe(false);
  });

  it("a ledger restore (cursor ahead of Ash OS) makes it read everything again", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    stub.state.projects.push({ id: "after-restore", name: "After restore", shortName: "AR", iconShape: "folder", folder: null, workOwner: "ash_os", status: "active" });
    stub.rewindTo(3);
    stub.restart();
    await waitFor(() => store.getSnapshot().projects.some((p) => p.id === "after-restore"), "reload after reset");
  });
});

describe("the feed drops but Ash OS stays", () => {
  it("falls back to polling and still brings in changes", async () => {
    store.start();
    await waitFor(() => stub.calls.some((c) => c.path === "/api/ash-hub-events"), "feed");
    // sever the stream only (no code-version event), then change something while it is down
    stub.closeStreams();
    stub.addNeed({ id: "poll1", projectId: "nibbii", title: "Example: seen by polling or the reconnected feed" });
    await waitFor(() => needIds(store, "nibbii").includes("poll1"), "change after the drop");
  });
});

describe("mergeStable", () => {
  const n = (id: string, extra: Partial<Need> = {}): Need => ({ id, projectId: "p", title: id, why: "", actionType: "open", actionLabel: "Open", state: "open", ...extra });
  it("keeps the old order, ticks a finished row in place, and adds new rows last", () => {
    const prev = [n("a"), n("b"), n("c")];
    const out = mergeStable(prev, [n("c"), n("d"), n("a")], new Map([["b", n("b", { state: "done" })]]), new Set());
    expect(out.map((x) => `${x.id}:${x.state}`)).toEqual(["a:open", "b:done", "c:open", "d:open"]);
  });
  it("drops a row Ash OS no longer lists, and one Ash has left behind", () => {
    const prev = [n("a"), n("b", { state: "done" }), n("c")];
    expect(mergeStable(prev, [n("a")], new Map(), new Set(["b"])).map((x) => x.id)).toEqual(["a"]);
  });
});
