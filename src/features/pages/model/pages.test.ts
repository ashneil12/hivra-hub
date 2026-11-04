// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import type { HubStore } from "../../hub/model/hubStore";
import { buildPreview, keepPage, keptPages, pageBlocks, resetPagesForTest } from "./pages";
import { botChangeRows, redoBotChange, undoBotChange } from "../../hub/model/botChanges";

beforeEach(() => { localStorage.clear(); resetPagesForTest(); });

it("matches a request to a layout of all five ready-made blocks", () => {
  const p = buildPreview("make me a dashboard for EXO bugs", "Projects Manager", 1);
  expect(p.title).toBe("Example: EXO · Bugs and fixes");
  expect(pageBlocks(p).map((b) => b.kind).sort()).toEqual(["calendar", "chart", "list", "note", "status"]);
  expect(pageBlocks(p)[0].kind).toBe("status");
  expect(pageBlocks(buildPreview("my schedule this week", "ed", 2))[0].kind).toBe("calendar");
});

it("Keep lists the page and adds a Bot changes row whose Undo takes it away again", async () => {
  const p = buildPreview("EXO bugs", "Projects Manager", 3);
  keepPage(p);
  expect(keptPages("today").map((x) => x.id)).toEqual([p.id]);
  const row = botChangeRows().find((r) => r.kind === "one" && r.change.pageId === p.id);
  expect(row).toBeTruthy();
  await undoBotChange([`page:${p.id}`]);
  expect(keptPages("today")).toEqual([]);
  await redoBotChange([`page:${p.id}`]);
  expect(keptPages("today").map((x) => x.id)).toEqual([p.id]);
});

it("each project keeps its own Pages", () => {
  keepPage(buildPreview("EXO bugs", "Projects Manager", 10, "exo-game"));
  keepPage(buildPreview("Hivra sign-ups", "Projects Manager", 11, "hivra"));
  expect(keptPages("exo-game").map((p) => p.title)).toEqual(["Example: EXO · Bugs and fixes"]);
  expect(keptPages("hivra").map((p) => p.title)).toEqual(["Example: Hivra · Sign-ups and sales"]);
  expect(keptPages("today")).toEqual([]);
});

it("pages imported into Ash OS count only once it took them; one it refused is named with why", async () => {
  const { importPages, setPagesBackend } = await import("./pages");
  const { HubCallError } = await import("../../hub/model/hubTransport");
  const act = vi.fn(async (_action: string, payload: Record<string, unknown>) => {
    if (payload.pageId === "imp-bad") throw new HubCallError("refused", "That project isn't in Ash OS.");
    return { id: payload.pageId, spec: payload.spec, state: "kept", keptAt: 1, projectId: payload.projectId, by: payload.by, request: payload.request, permissions: [] };
  });
  const store = { getSnapshot: () => ({ pages: [] }), subscribe: () => () => undefined, reload: async () => undefined, act } as unknown as HubStore;
  setPagesBackend(store);
  const good = { ...buildPreview("EXO bugs", "Projects Manager", 1, "hivra"), id: "imp-good", keptAt: 1 };
  const bad = { ...buildPreview("Hivra sign-ups", "Projects Manager", 2, "nowhere"), id: "imp-bad", keptAt: 2 };
  const r = await importPages([good, bad]);
  expect(act).toHaveBeenCalledTimes(2);
  expect(r).toEqual({ added: 1, failed: [`${bad.title}: That project isn't in Ash OS.`] });
});

it("an imported page asks again: nothing works until Keep and allow, and Undo revokes it", async () => {
  const { importPages, allowPage, needsAllow, approvedPermissions, keptPages } = await import("./pages");
  const { botChangeRows, undoBotChange } = await import("../../hub/model/botChanges");
  const spec = { kind: "bespoke", title: "Example: room", html: "<p>x</p>", css: "", js: "", permissions: ["tasks.read"] };
  expect(await importPages([{ id: "imp-1", projectId: "hivra", title: "Example: room", request: "r", by: "Hivra lead", spec, permissions: ["tasks.read"], keptAt: 1 } as never])).toEqual({ added: 1, failed: [] });
  const page = keptPages("hivra").find((p) => p.id === "imp-1")!;
  expect(needsAllow(page)).toBe(true);
  expect(approvedPermissions("imp-1")).toEqual([]);
  allowPage("imp-1");
  expect(approvedPermissions("imp-1")).toEqual(["tasks.read"]);
  const row = botChangeRows().flatMap((r) => (r.kind === "one" ? [r.change] : r.changes)).find((c) => c.pageId === "imp-1")!;
  await undoBotChange([row.id]);
  expect(approvedPermissions("imp-1")).toEqual([]);
});
