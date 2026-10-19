// @vitest-environment happy-dom
// Pages backed by Ash OS's record, against the stub's own Pages calls over real HTTP (scripts/hub-stub-studio.mjs):
// builds wait and are collected by Try again, Keep / pin / Undo / Redo write the record, pages kept on this Mac before
// are sent there once. No model and no real Ash OS: the stub "builds" from its invented asks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startStub, type Stub } from "../../../../scripts/hub-stub-server.mjs";
import { httpTransport } from "../../../dev/hubTestTransport";
import { setGroupChatRunner } from "../../hub/model/hubChats";
import { HubStore } from "../../hub/model/hubStore";
import { HubCallError } from "../../hub/model/hubTransport";
import { botChangeRows, redoBotChange, undoBotChange } from "../../hub/model/botChanges";
import { BUILD_WAIT_SECONDS, buildPage } from "./buildPage";
import { allPages, approvedPermissions, keepPage, pageFromSpec, pagesProblem, pinnedPages, setPagesBackend, setPinned } from "./pages";

const roster = [{ id: "hivra-lead" }, { id: "projects-manager" }];
const FAST = { coalesceMs: 5, minGapMs: 0, healthMs: 20, pollMs: 40, retryMs: [40], stopGraceMs: 5 };
let stub: Stub;
let store: HubStore;
const transport = () => httpTransport(() => stub.url, () => stub.token);

async function until<T>(read: () => T | undefined | false, what: string, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function start(buildMs = 0) {
  stub = await startStub({ buildMs });
  store = new HubStore({ transport: transport(), ...FAST });
  store.start();
  await until(() => store.getSnapshot().pages, "pages read");
  setPagesBackend(store);
}

beforeEach(() => localStorage.clear());
afterEach(async () => {
  setPagesBackend(undefined);
  store?.stop();
  await stub?.close();
});

describe("building a page", () => {
  it("goes to Ash OS (even with the in-app Mono runner connected), says how long it may wait, and brings the record's pageId", async () => {
    await start();
    const runner = vi.fn(async () => "{}");
    const clear = setGroupChatRunner(runner);
    try {
      const r = await buildPage({ projectId: "hivra", monoId: "hivra-lead", prompt: "Sign-ups this week" }, { roster, transport: transport(), stub: false });
      expect(runner).not.toHaveBeenCalled();
      expect(r.status).toBe("ready");
      if (r.status !== "ready") return;
      expect(r.pageId).toMatch(/^pg_/);
      expect(r.spec.title).toBe("Example: Sign-ups this week");
      expect(stub.studio.pages.find((p) => p.id === r.pageId)?.state).toBe("preview");
    } finally {
      clear();
    }
    expect(BUILD_WAIT_SECONDS).toBe(30);
  });

  it("a build slower than the wait says 'still building'; Try again collects the same page and nothing is built twice", async () => {
    await start(400);
    const t = transport();
    const slow = { call: (action: string, payload?: Record<string, unknown>) => t.call(action, { ...payload, wait: 0 }), openFeed: t.openFeed };
    const req = { projectId: "hivra", monoId: "hivra-lead", prompt: "Waitlist" };
    const first = await buildPage(req, { roster, transport: slow, stub: false });
    expect(first).toEqual({ status: "building", reason: "Hivra lead is still building this page. Press Try again in a moment to see it." });
    await new Promise((r) => setTimeout(r, 450));
    const again = await buildPage({ ...req, prompt: "  waitlist " }, { roster, transport: slow, stub: false });
    expect(again.status).toBe("ready");
    expect(stub.studio.pages).toHaveLength(1);
    expect(again.status === "ready" && again.spec.title).toBe("Example: Waitlist");
  });

  it("a Mono's turn-down, a worker and a service that isn't running each say so plainly", async () => {
    await start();
    const down = await buildPage({ projectId: "hivra", monoId: "hivra-lead", prompt: "please turn down" }, { roster, transport: transport(), stub: false });
    expect(down).toEqual({ status: "turned-down", reason: "Hivra lead turned it down: Example: that page would need your bank login, and pages never hold keys." });
    const worker = await buildPage({ projectId: "hivra", monoId: "worker-1", prompt: "x" }, { roster: [{ id: "worker-1" }], transport: transport(), stub: false });
    expect(worker.status).toBe("turned-down");
    const off = await buildPage({ projectId: "hivra", monoId: "hivra-lead", prompt: "x" }, { roster, transport: { call: async () => { throw new HubCallError("unreachable", "down"); }, openFeed: () => () => undefined }, stub: false });
    expect(off.status).toBe("not-connected");
  });
});

describe("kept pages live in Ash OS's record", () => {
  it("Keep marks the record's preview kept; Undo and Redo in Bot changes remove and restore it there", async () => {
    await start();
    const r = await buildPage({ projectId: "hivra", monoId: "hivra-lead", prompt: "Board" }, { roster, transport: transport(), stub: false });
    if (r.status !== "ready") throw new Error(r.status);
    const preview = pageFromSpec(r.spec, "Board", "Hivra lead", "hivra", r.warnings, 1, r.pageId, "hivra-lead");
    expect(await keepPage(preview)).toBe(true);
    expect(stub.studio.pages.find((p) => p.id === r.pageId)?.state).toBe("kept");
    await until(() => allPages().some((p) => p.id === r.pageId), "kept page listed");
    expect(stub.studio.pages).toHaveLength(1);

    const row = botChangeRows().flatMap((x) => (x.kind === "one" ? [x.change] : x.items)).find((c) => c.pageId === r.pageId)!;
    await undoBotChange([row.id]);
    expect(stub.studio.pages[0].state).toBe("removed");
    await until(() => !allPages().some((p) => p.id === r.pageId), "gone after Undo");
    await redoBotChange([row.id]);
    expect(stub.studio.pages[0].state).toBe("kept");
    await until(() => allPages().some((p) => p.id === r.pageId), "back after Redo");
  });

  it("a bespoke page's asks are approved with Keep and allow; pins (Ash's or a Mono's) are in the record", async () => {
    await start();
    const r = await buildPage({ projectId: "hivra", monoId: "hivra-lead", prompt: "a custom room reading tasks" }, { roster, transport: transport(), stub: false });
    if (r.status !== "ready") throw new Error(r.status);
    expect(r.spec.kind).toBe("bespoke");
    const page = pageFromSpec(r.spec, "room", "Hivra lead", "hivra", r.warnings, 1, r.pageId, "hivra-lead");
    await keepPage(page);
    expect(stub.studio.pages[0].permissions).toEqual(["tasks.read"]);
    await until(() => approvedPermissions(page.id).length === 1, "approved");
    setPinned(page.id, true, "Hivra lead");
    await until(() => stub.studio.pages[0].pinned === true, "pinned in the record");
    await until(() => pinnedPages().length === 1, "pinned listed");
    expect(pinnedPages()[0].pinnedBy).toBe("Hivra lead");
  });

  it("a page built without Ash OS (the dev stub) is saved to the record when kept", async () => {
    await start();
    const r = await buildPage({ projectId: "hivra", monoId: "hivra-lead", prompt: "EXO bugs" }, { roster, stub: true });
    if (r.status !== "ready") throw new Error(r.status);
    const page = pageFromSpec(r.spec, "EXO bugs", "Hivra lead", "hivra", [], 7, undefined, "hivra-lead");
    await keepPage(page);
    expect(stub.studio.pages.map((p) => [p.id, p.state, p.projectId])).toEqual([[page.id, "kept", "hivra"]]);
  });

  it("a refusal puts the page back as it was and says why", async () => {
    await start();
    const page = pageFromSpec({ kind: "blocks", title: "Example: x", blocks: [{ kind: "note", title: "n", text: "Example: y" }] }, "x", "Hivra lead", "nowhere", [], 3, undefined, "hivra-lead");
    expect(await keepPage(page)).toBe(false);
    expect(pagesProblem()).toBe("unknown project 'nowhere'");
    expect(allPages().some((p) => p.id === page.id)).toBe(false);
  });

  it("pages kept on this Mac before are sent to the record once, with what Ash allowed, and a copy stays", async () => {
    const old = [
      { id: "page-old1", projectId: "hivra", title: "Example: old", request: "old", by: "Projects Manager", spec: { kind: "blocks", title: "Example: old", blocks: [{ kind: "note", title: "n", text: "Example: hi" }] }, permissions: [], keptAt: 5, pinned: true, pinnedBy: "you" },
      { id: "page-gone", projectId: "hivra", title: "Example: undone", request: "u", by: "frank", spec: { kind: "blocks", title: "Example: undone", blocks: [{ kind: "note", title: "n", text: "Example: x" }] }, permissions: [], keptAt: 4, removed: true },
    ];
    localStorage.setItem("monocode:pages", JSON.stringify(old));
    await start();
    await until(() => allPages().some((p) => p.id === "page-old1"), "imported");
    expect(stub.studio.pages.map((p) => [p.id, p.state, p.pinned])).toEqual([["page-old1", "kept", true]]);
    expect(localStorage.getItem("monocode:pages")).toBeNull();
    expect(JSON.parse(localStorage.getItem("monocode:pages.before-record")!)).toHaveLength(2);
    // Once: a second read doesn't send it again.
    await store.reload(["pages"]);
    expect(stub.calls.filter((c) => c.path === "/api/ash-hub-page-update")).toHaveLength(1);
  });
});
