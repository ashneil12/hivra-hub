// The live store over the app's own local hub (WP-04: no Ash OS): projects, Pages and Being built come from the app,
// Needs, questions and checks are empty until WP-14's decision store, and a write elsewhere reaches the screens.
import { afterEach, describe, expect, it } from "vitest";
import type { Delegation } from "../../monos/model/delegations";
import { HubStore, mergeStable } from "./hubStore";
import { delegationDecisions } from "./localHub/decisions";
import { LocalHub, memoryDisk } from "./localHub/localHub";
import { createLocalTransport } from "./localHub/localTransport";
import type { Need } from "./types";

const FAST = { coalesceMs: 10, minGapMs: 0, healthMs: 30, pollMs: 80, retryMs: [30, 60], stopGraceMs: 5 };

async function waitFor<T>(read: () => T | undefined | false, what: string, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const stores: HubStore[] = [];
function setup(open: Delegation[] = []) {
  const hub = new LocalHub(memoryDisk());
  const store = new HubStore({ transport: createLocalTransport(hub, delegationDecisions(async () => open)), ...FAST });
  stores.push(store);
  return { hub, store };
}
afterEach(() => {
  stores.splice(0).forEach((s) => s.stop());
});

describe("first read", () => {
  it("loads the app's own projects and Pages and says ready, with nothing outside asked", async () => {
    const { hub, store } = setup();
    await hub.projectCreate({ name: "EXO game", project_id: "vg-game", folder: "/tmp/vg-game", icon_shape: "gamepad" });
    await hub.pageUpdate({ pageId: "pg-1", projectId: "vg-game", spec: { kind: "blocks", title: "Builds", blocks: [{ kind: "note", title: "n", text: "t" }] }, kept: true });
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    const snap = store.getSnapshot();
    expect(snap.projects.map((p) => [p.id, p.name, p.iconShape, p.folder])).toEqual([["vg-game", "EXO game", "gamepad", "/tmp/vg-game"]]);
    await waitFor(() => store.getSnapshot().pages?.length, "pages");
    expect((store.getSnapshot().pages as Array<{ id: string }>).map((p) => p.id)).toEqual(["pg-1"]);
    // Needs, questions and checks wait for WP-14: empty, not an outage.
    expect(Object.values(snap.needs).flatMap((r) => r.shown)).toEqual([]);
    expect(snap.setup).toEqual([]);
    expect(snap.since).toBeUndefined();
  });

  it("an empty store is a clean start: no projects, nothing being built, still ready", async () => {
    const { store } = setup();
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    expect(store.getSnapshot()).toMatchObject({ projects: [], jobs: [], loadedOnce: true });
  });
});

describe("live changes land in place", () => {
  it("a project made elsewhere appears on the strip without touching the others", async () => {
    const { hub, store } = setup();
    await hub.projectCreate({ name: "Hivra", project_id: "hivra" });
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    const first = store.getSnapshot().projects[0];
    await hub.projectCreate({ name: "Nibbii", project_id: "nibbii" });
    await waitFor(() => store.getSnapshot().projects.length === 2, "new project");
    expect(store.getSnapshot().projects.map((p) => p.id)).toEqual(["hivra", "nibbii"]);
    expect(store.getSnapshot().projects[0]).toEqual(first);
  });
});

describe("Being built", () => {
  it("is the app's own open delegations, grouped under the Mono running each one", async () => {
    const open = [
      { id: "d1", rootId: "d1", ownerMono: "exo-lead", project: "vg-game", title: "Fix the save bug", state: "running", createdAt: 1_000, updatedAt: 2_000, parentId: null, pendingQuestion: null },
    ] as unknown as Delegation[];
    const { hub, store } = setup(open);
    await hub.projectCreate({ name: "EXO", project_id: "vg-game" });
    store.start();
    await waitFor(() => store.getSnapshot().jobs.length, "jobs");
    const jobs = store.getSnapshot().jobs.flatMap((g) => g.jobs);
    expect(jobs.map((j) => [j.id, j.title])).toEqual([["d1", "Fix the save bug"]]);
  });
});

describe("mergeStable", () => {
  const n = (id: string, extra: Partial<Need> = {}): Need => ({ id, projectId: "p", title: id, why: "", actionType: "open", actionLabel: "Open", state: "open", ...extra });
  it("keeps the old order, ticks a finished row in place, and adds new rows last", () => {
    const prev = [n("a"), n("b"), n("c")];
    const out = mergeStable(prev, [n("c"), n("d"), n("a")], new Map([["b", n("b", { state: "done" })]]), new Set());
    expect(out.map((x) => `${x.id}:${x.state}`)).toEqual(["a:open", "b:done", "c:open", "d:open"]);
  });
  it("drops a row the source no longer lists, and one Ash has left behind", () => {
    const prev = [n("a"), n("b", { state: "done" }), n("c")];
    expect(mergeStable(prev, [n("a")], new Map(), new Set(["b"])).map((x) => x.id)).toEqual(["a"]);
  });
});

