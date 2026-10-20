// @vitest-environment happy-dom
// Rebuild: a kept page changed from Ash's words. Against the stub's own Pages calls over real HTTP
// (scripts/hub-stub-studio.mjs), the shapes of exo-cc-studio's ashos/pages.py: the new version waits on the page until
// Ash uses it (keeping what he allowed) or throws it away; a Mono's rebuild from its chat shows on the page the same way.
import { afterEach, beforeEach, expect, it } from "vitest";
import { startStub, type Stub } from "../../../../scripts/hub-stub-server.mjs";
import { httpTransport } from "../../../dev/hubTestTransport";
import { HubStore } from "../../hub/model/hubStore";
import { buildPage, rebuildPage } from "./buildPage";
import { allPages, dropNewVersion, findPage, keepPage, pageFromSpec, setPagesBackend, useNewVersion, type Page } from "./pages";
import type { BespokeSpec } from "./pageSpec";

const roster = [{ id: "hivra-lead" }, { id: "frank" }];
const FAST = { coalesceMs: 5, minGapMs: 0, healthMs: 20, pollMs: 40, retryMs: [40], stopGraceMs: 5 };
const AGENTS: BespokeSpec = { kind: "bespoke", title: "Agents", html: "<main id='list'></main>", css: "#list{color:var(--color-content)}", js: "", permissions: ["agents.read", "agents.stop"] };
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
async function keptAgents(): Promise<Page> {
  const page = pageFromSpec(AGENTS, "Every agent", "frank", "today", [], 1, undefined, "frank");
  expect(await keepPage({ ...page, id: "page-agents" })).toBe(true);
  return until(() => allPages().find((p) => p.id === "page-agents"), "kept");
}

beforeEach(async () => {
  localStorage.clear();
  stub = await startStub({ buildMs: 0 });
  store = new HubStore({ transport: transport(), ...FAST });
  store.start();
  await until(() => store.getSnapshot().pages, "pages read");
  setPagesBackend(store);
});
afterEach(async () => {
  setPagesBackend(undefined);
  store?.stop();
  await stub?.close();
});

it("Rebuild sends the page and Ash's words; the new version waits on the page and the page runs as it was", async () => {
  const page = await keptAgents();
  const r = await rebuildPage({ pageId: page.id, monoId: "frank", prompt: "Add a column for stuck time" }, { roster, transport: transport(), stub: false });
  if (r.status !== "ready") throw new Error(r.status);
  expect(r.replaces).toBe(page.id);
  expect(r.spec.kind === "bespoke" && r.spec.html).toContain("Example: changed for “Add a column for stuck time”");
  const waiting = await until(() => findPage(page.id)?.newVersion, "new version listed");
  expect(waiting).toMatchObject({ id: r.pageId, request: "Add a column for stuck time", by: "frank" });
  expect(findPage(page.id)!.spec).toEqual(AGENTS);
  expect(allPages().filter((p) => p.title === "Agents")).toHaveLength(1);
});

it("Use it swaps the new code in and keeps what Ash allowed; a new ask waits unless he allows it", async () => {
  const page = await keptAgents();
  expect(page.permissions).toEqual(["agents.read", "agents.stop"]);
  const r = await rebuildPage({ pageId: page.id, monoId: "frank", prompt: "let me message a Mono" }, { roster, transport: transport(), stub: false });
  if (r.status !== "ready") throw new Error(r.status);
  expect(await useNewVersion(findPage(page.id)!, { id: r.pageId!, spec: r.spec })).toBe(true);
  const used = await until(() => { const p = findPage(page.id); return p && !p.newVersion && p.spec.kind === "bespoke" && p.spec.html.includes("data-rebuilt") ? p : undefined; }, "used");
  expect(used.permissions).toEqual(["agents.read", "agents.stop"]);
  expect(stub.studio.pages.find((p) => p.id === r.pageId)?.state).toBe("used");
  // Again, allowing the new ask this time.
  const again = await rebuildPage({ pageId: page.id, monoId: "frank", prompt: "and a message box" }, { roster, transport: transport(), stub: false });
  if (again.status !== "ready") throw new Error(again.status);
  await useNewVersion(findPage(page.id)!, { id: again.pageId!, spec: again.spec }, { allowNew: true });
  await until(() => findPage(page.id)?.permissions.includes("agents.message"), "allowed");
});

it("Throw away leaves the page as it was", async () => {
  const page = await keptAgents();
  const r = await rebuildPage({ pageId: page.id, monoId: "frank", prompt: "Add a column for stuck time" }, { roster, transport: transport(), stub: false });
  if (r.status !== "ready") throw new Error(r.status);
  await until(() => findPage(page.id)?.newVersion, "waiting");
  expect(await dropNewVersion(findPage(page.id)!, r.pageId!)).toBe(true);
  await until(() => !findPage(page.id)?.newVersion, "gone");
  expect(findPage(page.id)!.spec).toEqual(AGENTS);
  expect(stub.studio.pages.find((p) => p.id === r.pageId)?.state).toBe("dropped");
});

it("without Ash OS (the example data) a rebuild is used in place on this Mac", async () => {
  setPagesBackend("local");
  const built = await buildPage({ projectId: "today", monoId: "frank", prompt: "Overview" }, { roster, stub: true });
  if (built.status !== "ready") throw new Error(built.status);
  const page = pageFromSpec(built.spec, "Overview", "frank", "today", [], 5, undefined, "frank");
  await keepPage(page);
  const r = await rebuildPage({ pageId: page.id, monoId: "frank", prompt: "Add a column", current: page.spec }, { roster, stub: true });
  if (r.status !== "ready") throw new Error(r.status);
  expect(r.pageId).toBeUndefined();
  await useNewVersion(findPage(page.id)!, { spec: r.spec });
  expect(JSON.stringify(findPage(page.id)!.spec)).toContain("Example: changed for “Add a column”");
});
