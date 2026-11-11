// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { undoBotChange } from "../../hub/model/botChanges";
import { buildPage, checkBuiltSpec, SEATED_ONLY_PAGES } from "./buildPage";
import { handleBridgeCall, KEYS_REFUSAL } from "./bridge";
import { checkBespokePage } from "./designCheck";
import { approvedPermissions, keepPage, pageFromSpec, resetPagesForTest } from "./pages";
import { validatePageSpec, type BespokeSpec } from "./pageSpec";
import { CSP, SANDBOX, bespokeSrcdoc } from "./sandbox";
import { stubPageSpec } from "./stubPages";

const roster = [{ id: "bo" }];
const req = { projectId: "hivra", monoId: "bo", prompt: "a page" };
const bespoke = (over: Partial<BespokeSpec> = {}): BespokeSpec => ({ kind: "bespoke", title: "Example: room", html: "<p class='t'>Hi</p>", css: ".t{color:var(--color-content)}", permissions: [], ...over });

beforeEach(() => { localStorage.clear(); resetPagesForTest(); });

it("only a seated Mono may build; a temporary worker is turned away before anything else", async () => {
  const r = await buildPage({ ...req, monoId: "worker-7f3" }, { roster, stub: true });
  expect(r).toEqual({ status: "turned-down", reason: SEATED_ONLY_PAGES });
});

it("a built page is validated before it is ready (a Mono's page_build, or the dev stub)", async () => {
  expect(checkBuiltSpec(stubPageSpec("EXO bugs")).status).toBe("ready");
  expect(checkBuiltSpec({ kind: "blocks", title: "x", blocks: [{ kind: "video", title: "v" }] }).status).toBe("turned-down");
  expect((await buildPage(req, { roster, stub: true })).status).toBe("ready");
});

it("outside the dev stub the Build button asks the first mate in its own chat (G15), never pretends", async () => {
  // No chat reachable from here: a plain line, no page made up. The ask itself is in buildPage.firstMate.test.ts.
  const r = await buildPage(req, { roster, stub: false, chat: null });
  expect(r.status).toBe("error");
  expect(r).not.toHaveProperty("spec");
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

it("pages can ask for what waits, a project and settings, but never for keys, changing Monos or reaching the app directly", () => {
  expect(validatePageSpec(bespoke({ permissions: ["tasks.read", "project.read", "settings.read", "settings.write"] })).ok).toBe(true);
  for (const wall of ["monos.delete", "mono.seat", "monos.rename", "monos.add", "ipc", "tauri.invoke"]) {
    expect(validatePageSpec(bespoke({ permissions: [wall] as never })).ok).toBe(false);
  }
  // A page can't reach the network, so a key would do nothing inside one; a key must never be in a page at all.
  const keyAsk = validatePageSpec(bespoke({ permissions: ["keys.read:Anthropic"] as never }));
  expect(keyAsk.ok).toBe(false);
  expect(keyAsk.ok ? "" : keyAsk.error).toContain("can't read your keys");
});

it("the bridge answers only approved asks; Undo revokes them", async () => {
  const page = pageFromSpec(bespoke({ permissions: ["tasks.read", "settings.read"] }), "p", "Projects Manager", "hivra", [], 5);
  const handlers = { "tasks.read": async () => ["Example: task"], "settings.read": async () => ({ name: "Ash" }) };
  // Before Keep and allow: nothing is approved.
  expect((await handleBridgeCall({ id: "1", call: "tasks.read" }, approvedPermissions(page.id), handlers)).ok).toBe(false);
  keepPage(page);
  expect(await handleBridgeCall({ id: "2", call: "tasks.read" }, approvedPermissions(page.id), handlers)).toEqual({ id: "2", ok: true, result: ["Example: task"] });
  expect(await handleBridgeCall({ id: "3", call: "settings.read" }, approvedPermissions(page.id), handlers)).toEqual({ id: "3", ok: true, result: { name: "Ash" } });
  // A capability it never asked for, a key (approved or not), and the walls, are refused.
  expect((await handleBridgeCall({ id: "4", call: "project.write" }, approvedPermissions(page.id), handlers)).ok).toBe(false);
  expect(await handleBridgeCall({ id: "5", call: "keys.read", args: { name: "Anthropic" } }, [...approvedPermissions(page.id), "keys.read" as never], {})).toEqual({ id: "5", ok: false, error: KEYS_REFUSAL });
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

it("bespoke cards use the hub card padding token", async () => {
  const { bespokeSrcdoc, PAGE_TOKENS } = await import("./sandbox");
  expect(PAGE_TOKENS).toContain("--space-card");
  const doc = bespokeSrcdoc({ kind: "bespoke", title: "t", html: "<p>x</p>", css: "", js: "", permissions: [] } as never, { "--space-card": "12px" }, "dark");
  expect(doc).toContain("padding:var(--space-card,12px)");
  expect(doc).toContain("--space-card:12px");
});
