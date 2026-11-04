// @vitest-environment happy-dom
// Kept pages live in the app's own local store (WP-04; src/dev/hubTestTransport.ts): Keep / pin / Undo / Redo write
// it, and pages kept on this Mac before (localStorage) go into it once. Building a page through Ash OS is retired: these
// pages come from the dev stub's builder, the path buildPage still has.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localTestHub, type TestHub } from "../../../dev/hubTestTransport";
import { HubStore } from "../../hub/model/hubStore";
import { botChangeRows, redoBotChange, undoBotChange } from "../../hub/model/botChanges";
import { buildPage } from "./buildPage";
import { allPages, approvedPermissions, keepPage, pageFromSpec, pagesProblem, pinnedPages, setPagesBackend, setPinned } from "./pages";

const roster = [{ id: "hivra-lead" }, { id: "projects-manager" }];
const FAST = { coalesceMs: 5, minGapMs: 0, healthMs: 20, pollMs: 40, retryMs: [40], stopGraceMs: 5 };
let t: TestHub;
let store: HubStore;

async function until<T>(read: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const kept = async () => (await t.state()).pages;
async function start() {
  t = await localTestHub();
  store = new HubStore({ transport: t.transport, ...FAST });
  store.start();
  await until(() => store.getSnapshot().pages, "pages read");
  setPagesBackend(store);
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  setPagesBackend(undefined);
  store?.stop();
});

describe("kept pages live in the app's own store", () => {
  it("Keep saves the page; Undo and Redo in Bot changes remove and restore it there", async () => {
    await start();
    const r = await buildPage({ projectId: "hivra", monoId: "hivra-lead", prompt: "Board" }, { roster, stub: true });
    if (r.status !== "ready") throw new Error(r.status);
    const page = pageFromSpec(r.spec, "Board", "Hivra lead", "hivra", r.warnings, 1, undefined, "hivra-lead");
    expect(await keepPage(page)).toBe(true);
    expect((await kept()).map((p) => [p.id, p.state, p.projectId])).toEqual([[page.id, "kept", "hivra"]]);
    await until(() => allPages().some((p) => p.id === page.id), "kept page listed");

    const row = botChangeRows().flatMap((x) => (x.kind === "one" ? [x.change] : x.items)).find((c) => c.pageId === page.id)!;
    await undoBotChange([row.id]);
    expect((await kept())[0].state).toBe("removed");
    await until(() => !allPages().some((p) => p.id === page.id), "gone after Undo");
    await redoBotChange([row.id]);
    expect((await kept())[0].state).toBe("kept");
    await until(() => allPages().some((p) => p.id === page.id), "back after Redo");
  });

  it("a bespoke page's asks are approved with Keep and allow; pins (Ash's or a Mono's) are kept", async () => {
    await start();
    const r = await buildPage({ projectId: "hivra", monoId: "hivra-lead", prompt: "a custom room reading tasks" }, { roster, stub: true });
    if (r.status !== "ready") throw new Error(r.status);
    expect(r.spec.kind).toBe("bespoke");
    const page = pageFromSpec(r.spec, "room", "Hivra lead", "hivra", r.warnings, 1, undefined, "hivra-lead");
    await keepPage(page);
    const asks = (r.spec as { permissions: string[] }).permissions;
    expect(asks).toContain("tasks.read");
    expect((await kept())[0].permissions).toEqual(asks);
    await until(() => approvedPermissions(page.id).length === asks.length, "approved");
    setPinned(page.id, true, "Hivra lead");
    await until(async () => (await kept())[0].pinned === true, "pinned in the store");
    await until(() => pinnedPages().length === 1, "pinned listed");
    expect(pinnedPages()[0].pinnedBy).toBe("Hivra lead");
  });

  it("a refusal puts the page back as it was and says why", async () => {
    await start();
    const page = pageFromSpec({ kind: "blocks", title: "Example: x", blocks: [{ kind: "note", title: "n", text: "Example: y" }] }, "x", "Hivra lead", "nowhere", [], 3, undefined, "hivra-lead");
    expect(await keepPage(page)).toBe(false);
    expect(pagesProblem()).toBe("unknown project 'nowhere'");
    expect(allPages().some((p) => p.id === page.id)).toBe(false);
  });

  it("pages kept on this Mac before go into the store once, with what Ash allowed, and a copy stays", async () => {
    const old = [
      { id: "page-old1", projectId: "hivra", title: "Example: old", request: "old", by: "Projects Manager", spec: { kind: "blocks", title: "Example: old", blocks: [{ kind: "note", title: "n", text: "Example: hi" }] }, permissions: [], keptAt: 5, pinned: true, pinnedBy: "you" },
      { id: "page-gone", projectId: "hivra", title: "Example: undone", request: "u", by: "frank", spec: { kind: "blocks", title: "Example: undone", blocks: [{ kind: "note", title: "n", text: "Example: x" }] }, permissions: [], keptAt: 4, removed: true },
    ];
    localStorage.setItem("monocode:pages", JSON.stringify(old));
    await start();
    await until(() => allPages().some((p) => p.id === "page-old1"), "imported");
    expect((await kept()).map((p) => [p.id, p.state, p.pinned])).toEqual([["page-old1", "kept", true]]);
    expect(localStorage.getItem("monocode:pages")).toBeNull();
    expect(JSON.parse(localStorage.getItem("monocode:pages.before-record")!)).toHaveLength(2);
    // Once: a second read doesn't send it again.
    await store.reload(["pages"]);
    expect(t.calls.filter((a) => a === "page-update")).toHaveLength(1);
  });
});
