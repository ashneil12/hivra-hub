// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { HubCallError, type HubTransport } from "../../hub/model/hubTransport";
import { undoBotChange } from "../../hub/model/botChanges";
import { buildPage, SEATED_ONLY_PAGES } from "./buildPage";
import { handleBridgeCall } from "./bridge";
import { checkBespokePage } from "./designCheck";
import { approvedPermissions, keepPage, pageFromSpec, resetPagesForTest } from "./pages";
import { validatePageSpec, type BespokeSpec } from "./pageSpec";
import { CSP, SANDBOX, bespokeSrcdoc } from "./sandbox";
import { stubPageSpec } from "./stubPages";
import { KEY_CONFIRM_DELAY_MS, useKeyDelay } from "../ui/PagesView";

const roster = [{ id: "projects-manager" }];
const answering = (answer: unknown): HubTransport => ({ call: async () => answer as never, openFeed: () => () => undefined });
const failing = (e: unknown): HubTransport => ({ call: async () => { throw e; }, openFeed: () => () => undefined });
const req = { projectId: "hivra", monoId: "projects-manager", prompt: "a page" };
const bespoke = (over: Partial<BespokeSpec> = {}): BespokeSpec => ({ kind: "bespoke", title: "Example: room", html: "<p class='t'>Hi</p>", css: ".t{color:var(--color-content)}", permissions: [], ...over });

beforeEach(() => { localStorage.clear(); resetPagesForTest(); });

it("only a seated Mono may build; a temporary worker is turned away before anything is sent", async () => {
  const call = vi.fn();
  const r = await buildPage({ ...req, monoId: "worker-7f3" }, { roster, transport: { call, openFeed: () => () => undefined } });
  expect(r).toEqual({ status: "turned-down", reason: SEATED_ONLY_PAGES });
  expect(call).not.toHaveBeenCalled();
});

it("calls the backend through the hub transport and validates what comes back", async () => {
  const call = vi.fn(async () => stubPageSpec("EXO bugs"));
  const r = await buildPage(req, { roster, transport: { call: call as never, openFeed: () => () => undefined } });
  expect(call).toHaveBeenCalledWith("ash-hub-build-page", req);
  expect(r.status).toBe("ready");
  expect((await buildPage(req, { roster, transport: answering({ kind: "blocks", title: "x", blocks: [{ kind: "video", title: "v" }] }) })).status).toBe("turned-down");
});

it("an unwired backend shows Not connected yet instead of pretending", async () => {
  const r = await buildPage(req, { roster, transport: failing(new HubCallError("unreachable", "down")) });
  expect(r.status).toBe("not-connected");
});

it("bundles the restyled Tremor-style bar list as an allowed block", () => {
  expect(validatePageSpec({ kind: "blocks", title: "x", blocks: [{ kind: "barlist", title: "Where", rows: [{ label: "X", value: 3 }] }] }).ok).toBe(true);
});

it("design check: faint small text blocks; own colours and status colours only warn", async () => {
  const faint = checkBespokePage(bespoke({ css: ".t{color:color-mix(in srgb,var(--color-content) 25%,transparent)}" }));
  expect(faint.blocked?.rule).toBe("contrast");
  const loud = checkBespokePage(bespoke({ css: ".hero{background:#ff7a45;color:var(--color-content)} .deco{background:var(--color-status-ok)}" }));
  expect(loud.blocked).toBeUndefined();
  expect(loud.warnings.map((w) => w.rule).sort()).toEqual(["own-colours", "status-colours"]);
  expect((await buildPage({ ...req, prompt: "something faint" }, { roster, stub: true })).status).toBe("turned-down");
  const colourful = await buildPage({ ...req, prompt: "something colourful" }, { roster, stub: true });
  expect(colourful.status === "ready" && colourful.warnings.length).toBeTruthy();
});

it("pages can ask for keys and settings, but never for changing Monos or reaching the app directly", () => {
  expect(validatePageSpec(bespoke({ permissions: ["keys.read:Anthropic", "settings.write"] as never })).ok).toBe(true);
  for (const wall of ["monos.delete", "mono.seat", "monos.rename", "monos.add", "ipc", "tauri.invoke"]) {
    expect(validatePageSpec(bespoke({ permissions: [wall] as never })).ok).toBe(false);
  }
});

it("the bridge answers only approved asks; Undo revokes them", async () => {
  const page = pageFromSpec(bespoke({ permissions: ["tasks.read", "keys.read:Anthropic"] }), "p", "Projects Manager", "hivra", [], 5);
  const handlers = { "tasks.read": async () => ["Example: task"], "keys.read": async (a: Record<string, unknown>) => `key for ${String(a.name)}` };
  // Before Keep and allow: nothing is approved.
  expect((await handleBridgeCall({ id: "1", call: "tasks.read" }, approvedPermissions(page.id), handlers)).ok).toBe(false);
  keepPage(page);
  expect(await handleBridgeCall({ id: "2", call: "tasks.read" }, approvedPermissions(page.id), handlers)).toEqual({ id: "2", ok: true, result: ["Example: task"] });
  // The key it asked for works; one it didn't ask for is refused.
  expect((await handleBridgeCall({ id: "3", call: "keys.read", args: { name: "Anthropic" } }, approvedPermissions(page.id), handlers)).ok).toBe(true);
  const other = await handleBridgeCall({ id: "4", call: "keys.read", args: { name: "OpenAI" } }, approvedPermissions(page.id), handlers);
  expect(other).toEqual({ id: "4", ok: false, error: "This page didn't ask to read your OpenAI key, so it can't." });
  // A capability it never asked for, and the walls, are refused.
  expect((await handleBridgeCall({ id: "5", call: "project.write" }, approvedPermissions(page.id), handlers)).ok).toBe(false);
  expect((await handleBridgeCall({ id: "6", call: "monos.delete" }, ["monos.delete" as never], handlers)).ok).toBe(false);
  await undoBotChange([`page:${page.id}`]);
  expect(approvedPermissions(page.id)).toEqual([]);
  expect((await handleBridgeCall({ id: "7", call: "tasks.read" }, approvedPermissions(page.id), handlers)).ok).toBe(false);
});

it("a bespoke page can't reach the host: scripts only, no same-origin, no network, theme tokens injected", () => {
  expect(SANDBOX).toBe("allow-scripts");
  expect(SANDBOX).not.toContain("allow-same-origin");
  expect(CSP).toContain("default-src 'none'");
  expect(CSP).toContain("connect-src 'none'");
  const doc = bespokeSrcdoc({ html: "<p>x</p>", js: "window.__TAURI__ && 1; </script><script>alert(1)" }, { "--color-content": "hsl(240 0% 92%)" });
  expect(doc).toContain(`content="${CSP}"`);
  expect(doc).toContain(":root{--color-content:hsl(240 0% 92%);color-scheme:dark}");
  expect(doc).not.toContain("</script><script>alert(1)");
  expect(doc).toContain("parent.postMessage");
});

it("Keep and allow waits about a second after a key ask appears", () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let ready = false;
  const Probe = () => { ready = useKeyDelay(true); return null; };
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Probe)));
  expect(ready).toBe(false);
  act(() => { vi.advanceTimersByTime(KEY_CONFIRM_DELAY_MS - 100); });
  expect(ready).toBe(false);
  act(() => { vi.advanceTimersByTime(200); });
  expect(ready).toBe(true);
  vi.useRealTimers();
});
