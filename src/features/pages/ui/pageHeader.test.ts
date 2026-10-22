// @vitest-environment happy-dom
// A kept page's header (Critiquito on the C3 shot, 22 Oct): the title shows once, and "Kept" shows once, with Undo, in
// the bar; the line under the title is just where the page lives, who built it, what was asked and what it may do.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { addMono } from "../../monos/model/mono";
import { keepPage, pageFromSpec, requestOpenPage, resetPagesForTest } from "../model/pages";
import type { BespokeSpec } from "../model/pageSpec";
import { bespokeSrcdoc } from "../model/sandbox";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const SPEC: BespokeSpec = {
  kind: "bespoke", title: "What the agents are doing", html: "<section><h1>What they're doing</h1><section><h2>Needs you</h2><div></div></section></section>",
  css: "", js: "", permissions: ["agents.read", "needs.read", "agents.answer", "chats.open"],
};

beforeEach(async () => {
  localStorage.clear();
  resetPagesForTest();
  addMono({ id: "frank", name: "frank", mascot: "robot", color: "x", projects: [] });
  const { hubData, setHubDataSource } = await import("../../hub/model/hubData");
  setHubDataSource(undefined);
  const src = Object.create(hubData());
  src.listProjects = () => [];
  setHubDataSource(src);
});
const roots: Root[] = [];
afterEach(() => act(() => roots.splice(0).forEach((r) => r.unmount())));
afterAll(async () => (await import("../../hub/model/hubData")).setHubDataSource(undefined));

it("a kept page's line under the title doesn't say Kept, and the app shows the title once", async () => {
  const page = { ...pageFromSpec(SPEC, "Make me a dashboard of what the agents are doing", "frank", "today", [], 1, undefined, "frank"), id: "page-c3" };
  await keepPage(page);
  requestOpenPage(page.id);
  const { PagesContent } = await import("./PagesView");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(PagesContent)));
  const open = host.querySelector("[data-pages-open]")!;
  expect(open.querySelectorAll("h1")).toHaveLength(1);
  const meta = open.querySelector("[data-pages-meta]")!.textContent!;
  expect(meta).not.toMatch(/\bKept\b/);
  expect(meta).toContain("Allowed: 4 things");
  // The frame hides the page's own first h1, so the header's is the one title Ash sees.
  expect(bespokeSrcdoc(SPEC, {})).toContain('h1.style.display = "none"');
});
