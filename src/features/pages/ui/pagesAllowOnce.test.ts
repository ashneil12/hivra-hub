// @vitest-environment happy-dom
// r63 (PM's blind C8 on 0.16.3, a blocker): the ready-made Agents page showed its "This page came from a setup file…
// Allow" card 4+ times and the page was dead until Allow. The card and the page had the same React key, so each live
// re-render added a card. Now: one card, the page greyed out and inert until Allow, and the header says "Ready-made" once.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { addMono } from "../../monos/model/mono";
import { allowPage, findPage, keepPage, pageFromSpec, requestOpenPage, resetPagesForTest, setPinned } from "../model/pages";
import { AGENTS_READY, READY_BY, READY_PAGES, withReadySpec } from "../model/readyPages";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const agents = READY_PAGES.find((r) => r.request === AGENTS_READY)!;

beforeEach(async () => {
  localStorage.clear();
  resetPagesForTest();
  addMono({ id: "ed", name: "ed", mascot: "robot", color: "x", projects: [] });
  const { hubData, setHubDataSource } = await import("../../hub/model/hubData");
  setHubDataSource(undefined);
  const src = Object.create(hubData());
  src.listProjects = () => [];
  setHubDataSource(src);
});
const roots: Root[] = [];
afterEach(() => act(() => roots.splice(0).forEach((r) => r.unmount())));
afterAll(async () => (await import("../../hub/model/hubData")).setHubDataSource(undefined));

async function openReady() {
  const page = { ...pageFromSpec(agents.spec, agents.request, READY_BY, "today", [], 1), id: "page-ready-agents" };
  await keepPage(page, 1, { allow: false });
  requestOpenPage(page.id);
  const { PagesContent } = await import("./PagesView");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(PagesContent)));
  return { host, root, page, PagesContent };
}

it("the Allow card shows once however often the page re-renders, and the page is greyed out and inert until Allow", async () => {
  const { host, root, page, PagesContent } = await openReady();
  for (let i = 0; i < 6; i++) {
    // Live data and Ash's taps re-render the open page; a pin toggle is one of them.
    await act(async () => setPinned(page.id, i % 2 === 0));
    await act(async () => root.render(createElement(PagesContent)));
  }
  expect(host.querySelectorAll("[data-pages-allow-again]")).toHaveLength(1);
  expect(host.querySelectorAll("[data-pages-allow]")).toHaveLength(1);
  const gated = host.querySelector("[data-pages-gated]")!;
  expect(gated).not.toBeNull();
  expect(gated.getAttribute("aria-disabled")).toBe("true");
  expect(gated.hasAttribute("inert")).toBe(true);
  expect(host.querySelector("[data-pages-allow-note]")!.textContent).toContain("greyed out until then");
  expect(host.querySelector("[data-pages-allow-note]")!.textContent).toContain("comes with the app");

  await act(async () => allowPage(page.id));
  expect(findPage(page.id)!.permissions.length).toBeGreaterThan(0);
  expect(host.querySelectorAll("[data-pages-allow-again]")).toHaveLength(0);
  expect(host.querySelector("[data-pages-gated]")).toBeNull();
});

it("a ready-made page's header says Ready-made once (no quoted request)", async () => {
  const { host } = await openReady();
  const meta = host.querySelector("[data-pages-meta]")!.textContent!;
  expect(meta.match(/Ready-made/g)).toHaveLength(1);
  expect(meta).not.toContain(AGENTS_READY);
  expect(meta).toContain("by Ready-made");
});

it("the Agents page names each row's buttons for its agent, and a page kept by an older build draws the new code", () => {
  expect(agents.spec.js).toContain('b.setAttribute("aria-label", label + " " + name)');
  expect(agents.spec.js).toMatch(/btn\("Message", [\s\S]{0,120}, false, item\.name\)/);
  const old = { ...pageFromSpec({ ...agents.spec, js: "/* old */" }, agents.request, READY_BY, "today", [], 1), id: "p-old" };
  expect(withReadySpec(old).spec.kind === "bespoke" && withReadySpec(old).spec.js).toBe(agents.spec.js);
  // Asking for something else than what was kept: the kept page stays as it is (what Ash allowed never changes).
  const asksMore = { ...old, spec: { ...old.spec, permissions: ["agents.read"] } } as typeof old;
  expect(withReadySpec(asksMore)).toBe(asksMore);
  // A Mono's own page is never touched.
  const mine = { ...old, by: "Projects Manager" };
  expect(withReadySpec(mine)).toBe(mine);
});

it("a ready-made page Ash used a new version of keeps that version (the ready-made code doesn't replace it)", async () => {
  const { setOwnCode } = await import("../model/ownCode");
  const changedByAsh = { ...pageFromSpec({ ...agents.spec, html: `${agents.spec.html}<p data-rebuilt>mine</p>` }, agents.request, READY_BY, "today", [], 1), id: "p-mine" };
  expect(withReadySpec(changedByAsh)).not.toBe(changedByAsh);
  setOwnCode("p-mine", true);
  expect(withReadySpec(changedByAsh)).toBe(changedByAsh);
  setOwnCode("p-mine", false);
});
