// @vitest-environment happy-dom
// Pages' own headings in sentence case (PM's real-app check of r35, 22 Oct: "READY-MADE" showed in capitals because the
// CSS forced it). The heading reads "Ready-made" as written, like Today's quiet section headings; nothing in Pages'
// screens forces capitals with text-transform (built pages already can't: pageKit.test.ts).
import fs from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { addMono } from "../../monos/model/mono";
import { keepPage, pageFromSpec, resetPagesForTest } from "../model/pages";
import type { BespokeSpec } from "../model/pageSpec";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const FORCED_CAPS = /\buppercase\b|text-transform:\s*uppercase|\bsmall-caps\b|font-variant-caps/;
const SPEC: BespokeSpec = { kind: "bespoke", title: "Example: sign-ups this week", html: "<section><h2>Example: sign-ups</h2></section>", css: "", js: "", permissions: [] };

const roots: Root[] = [];
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
afterEach(() => act(() => roots.splice(0).forEach((r) => r.unmount())));
afterAll(async () => (await import("../../hub/model/hubData")).setHubDataSource(undefined));

async function render() {
  const { PagesContent } = await import("./PagesView");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(PagesContent)));
  return host;
}
const headings = (host: HTMLElement) => [...host.querySelectorAll("h2")];

it("the Ready-made heading is sentence case, with no forced capitals, on an empty Pages and beside kept pages", async () => {
  let host = await render();
  let ready = host.querySelector("[data-pages-ready] h2")!;
  expect(ready.textContent).toBe("Ready-made");
  expect(ready.className).not.toMatch(FORCED_CAPS);
  act(() => roots.splice(0).forEach((r) => r.unmount()));

  await keepPage({ ...pageFromSpec(SPEC, "Example: show me sign-ups", "ed", "today", [], 1, undefined, "ed"), id: "page-r25" });
  host = await render();
  ready = host.querySelector("[data-pages-ready] h2")!;
  expect(ready.textContent).toBe("Ready-made");
  // Every heading Pages draws (the group's name and Ready-made) keeps its own case.
  expect(headings(host).length).toBeGreaterThanOrEqual(2);
  for (const h of headings(host)) expect(h.className, h.textContent!).not.toMatch(FORCED_CAPS);
});

it("no Pages screen forces capitals with CSS", () => {
  const dir = path.resolve(__dirname);
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".tsx"))) {
    const hits = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter((l) => FORCED_CAPS.test(l));
    expect(hits, f).toEqual([]);
  }
});
