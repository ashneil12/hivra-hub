// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { checkBespokePage } from "./designCheck";
import { allPages, resetPagesForTest } from "./pages";
import { validatePageSpec, type BespokeSpec } from "./pageSpec";
import {
  AGENTS_PAGE,
  AGENTS_READY,
  BUILT_PAGE,
  BUILT_READY,
  NEEDS_PAGE,
  NEEDS_READY,
  PROJECTS_PAGE,
  PROJECTS_READY,
  READY_PAGES,
} from "./readyPages";

const READY_CASES: { id: string; title: string; spec: BespokeSpec; request: string; watch: string | null; words: string[] }[] = [
  {
    id: "agents",
    title: "Agents",
    spec: AGENTS_PAGE,
    request: AGENTS_READY,
    watch: 'hub.watch("agents.read"',
    words: ["See your agents", "Answer an agent's question when you tap", "Take an agent's suggested answer when you tap", "Stop an agent's work when you tap", "Open a chat when you tap"],
  },
  {
    id: "needs-you",
    title: "Needs you",
    spec: NEEDS_PAGE,
    request: NEEDS_READY,
    watch: 'hub.watch("needs.read"',
    words: ["See what's waiting on you", "Answer an agent's question when you tap", "Take an agent's suggested answer when you tap", "Open a chat when you tap"],
  },
  {
    id: "being-built",
    title: "Being built",
    spec: BUILT_PAGE,
    request: BUILT_READY,
    watch: 'hub.watch("jobs.read"',
    words: ["See what's being built", "Open a chat when you tap"],
  },
  {
    id: "projects",
    title: "Projects",
    spec: PROJECTS_PAGE,
    request: PROJECTS_READY,
    watch: null,
    words: ["Read your projects and what each is working on", "Read what's waiting on you, being built or stuck"],
  },
];

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

it("offers every page the catalog names, one spec each, under the request it is kept with", () => {
  expect(READY_PAGES.map((p) => p.id)).toEqual(READY_CASES.map((c) => c.id));
  expect(READY_PAGES.map((p) => p.spec)).toEqual(READY_CASES.map((c) => c.spec));
  for (const page of READY_PAGES) expect(page.request).toBe(`Ready-made: ${page.title}`);
});

for (const ready of READY_CASES) {
  it(`the ${ready.title} page is a page like any other: it validates, passes the design check and asks only for what it uses`, () => {
    expect(validatePageSpec(ready.spec).ok).toBe(true);
    expect(checkBespokePage(ready.spec)).toEqual({ warnings: [] });
    const used = new Set(
      [...ready.spec.js!.matchAll(/"(agents\.[a-z]+|chats\.open|tasks\.read|jobs\.read|project\.read|needs\.read)"/g)].map((m) => m[1]),
    );
    expect([...used].sort()).toEqual([...ready.spec.permissions].sort());
    // It reads live (no polling) and taps only from click handlers.
    if (ready.watch) expect(ready.spec.js).toContain(ready.watch);
    expect(ready.spec.js).not.toMatch(/setInterval\([^)]*hub\.call/);
  });

  it(`Pages offers ${ready.title} ready-made; Add shows its preview and asks; Keep and allow keeps it and the offer goes`, async () => {
    const { PagesContent } = await import("../ui/PagesView");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(createElement(PagesContent)));
    const add = host.querySelector(`[data-pages-ready-add="${ready.id}"]`) as HTMLButtonElement;
    expect(add).not.toBeNull();
    await act(async () => add.click());
    expect(host.querySelector("[data-pages-preview]")!.textContent).toContain("Ready-made hub");
    const asks = host.querySelector("[data-page-permissions]")!.textContent!;
    for (const words of ready.words) expect(asks).toContain(words);
    const keep = host.querySelector("[data-pages-keep]") as HTMLButtonElement;
    expect(keep.textContent).toBe("Apply and allow");
    await act(async () => keep.click());
    const kept = allPages().find((p) => p.request === ready.request)!;
    expect(kept).toMatchObject({ title: ready.title, by: "Ready-made", projectId: "today", permissions: ready.spec.permissions });
    expect(host.querySelector("[data-pages-open] h1")!.textContent).toBe(ready.title);
    await act(async () => (host.querySelector("[data-pages-open] [data-pages-menu-button]") as HTMLButtonElement).click());
    await act(async () => (host.querySelector('[data-pages-menu-item="all"]') as HTMLButtonElement).click()); // All pages
    expect(host.querySelector(`[data-pages-ready-row="${ready.id}"]`)).toBeNull();
  });
}
