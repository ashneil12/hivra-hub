// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { checkBespokePage } from "./designCheck";
import { allPages, resetPagesForTest } from "./pages";
import { validatePageSpec } from "./pageSpec";
import { AGENTS_PAGE, AGENTS_READY } from "./readyPages";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
beforeEach(async () => {
  localStorage.clear();
  resetPagesForTest();
  const { hubData, setHubDataSource } = await import("../../hub/model/hubData");
  setHubDataSource(undefined);
  const src = Object.create(hubData());
  src.listProjects = () => [];
  setHubDataSource(src);
});
afterEach(() => act(() => roots.splice(0).forEach((r) => r.unmount())));
afterAll(async () => (await import("../../hub/model/hubData")).setHubDataSource(undefined));

it("the Agents page is a page like any other: it validates, passes the design check and asks only for what it uses", () => {
  expect(validatePageSpec(AGENTS_PAGE).ok).toBe(true);
  expect(checkBespokePage(AGENTS_PAGE)).toEqual({ warnings: [] });
  const used = new Set([...AGENTS_PAGE.js!.matchAll(/"(agents\.[a-z]+|chats\.open)"/g)].map((m) => m[1]));
  expect([...used].sort()).toEqual([...AGENTS_PAGE.permissions].sort());
  // It reads live (no polling) and taps only from click handlers.
  expect(AGENTS_PAGE.js).toContain('hub.watch("agents.read"');
  expect(AGENTS_PAGE.js).not.toMatch(/setInterval\([^)]*hub\.call/);
});

it("Pages offers it ready-made; Add shows its preview and asks; Keep and allow keeps it and the offer goes", async () => {
  const { PagesContent } = await import("../ui/PagesView");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(PagesContent)));
  const add = host.querySelector('[data-pages-ready-add="agents"]') as HTMLButtonElement;
  expect(host.querySelector('[data-pages-ready-row="agents"]')!.textContent).toContain("stuck and asking ones on top");
  await act(async () => add.click());
  expect(host.querySelector("[data-pages-preview]")!.textContent).toContain("Ready-made page");
  const asks = host.querySelector("[data-page-permissions]")!.textContent!;
  for (const words of ["See your agents", "Answer an agent's question when you tap", "Stop an agent's work when you tap", "Open a chat when you tap"]) expect(asks).toContain(words);
  const keep = host.querySelector("[data-pages-keep]") as HTMLButtonElement;
  expect(keep.textContent).toBe("Apply and allow");
  await act(async () => keep.click());
  const kept = allPages().find((p) => p.request === AGENTS_READY)!;
  expect(kept).toMatchObject({ title: "Agents", by: "Ready-made", projectId: "today", permissions: AGENTS_PAGE.permissions });
  expect(host.querySelector("[data-pages-open] h1")!.textContent).toBe("Agents");
  await act(async () => (host.querySelector("[data-pages-open] button") as HTMLButtonElement).click()); // ← All pages
  expect(host.querySelector('[data-pages-ready-row="agents"]')).toBeNull();
});
