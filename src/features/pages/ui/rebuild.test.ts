// @vitest-environment happy-dom
// Rebuild on a kept page, on screen (the example data with the dev stub standing in for the Mono): Ash says what should
// change, sees the new version with what it keeps and newly asks, and uses it; the page is the same page, changed.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import type { Root } from "react-dom/client";
import { addMono } from "../../monos/model/mono";
import { findPage, keepPage, pageFromSpec, requestOpenPage, resetPagesForTest } from "../model/pages";
import type { BespokeSpec } from "../model/pageSpec";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const AGENTS: BespokeSpec = { kind: "bespoke", title: "Agents", html: "<main id='list'></main>", css: "#list{color:var(--color-content)}", js: "", permissions: ["agents.read", "agents.stop"] };

beforeEach(async () => {
  localStorage.clear();
  resetPagesForTest();
  localStorage.setItem("monocode:pages-dev-stub", "1");
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

async function type(input: HTMLInputElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const until = async (read: () => unknown) => {
  for (let i = 0; i < 100 && !read(); i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
  return read();
};

it("Rebuild: say what should change, see the new version, use it, and the page keeps what it was allowed", async () => {
  const page = { ...pageFromSpec(AGENTS, "Every agent", "ed", "today", [], 1, undefined, "ed"), id: "page-agents" };
  await keepPage(page);
  requestOpenPage(page.id);
  const { PagesContent } = await import("./PagesView");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(PagesContent)));
  expect(host.querySelector("[data-pages-open] h1")!.textContent).toBe("Agents");

  await act(async () => (host.querySelector("[data-pages-menu-button]") as HTMLButtonElement).click());
  await act(async () => (host.querySelector("[data-pages-rebuild]") as HTMLButtonElement).click());
  const input = host.querySelector('[data-pages-rebuild-ask] input[aria-label="What should change"]') as HTMLInputElement;
  expect((host.querySelector("[data-pages-rebuild-ask] [data-pages-mono-picker]") as HTMLSelectElement).value).toBe("ed");
  await type(input, "Add a column for stuck time");
  await act(async () => (host.querySelector("[data-pages-rebuild-ask] form") as HTMLFormElement).requestSubmit());
  expect(await until(() => host.querySelector("[data-pages-new-version]"))).toBeTruthy();
  expect(host.textContent).toContain("“Add a column for stuck time” · ed built a new version");
  expect(host.querySelector("[data-pages-new-version-keeps]")!.textContent).toContain("It keeps what you allowed");
  // The page itself hasn't changed yet.
  expect(findPage(page.id)!.spec).toEqual(AGENTS);

  await act(async () => (host.querySelector("[data-pages-use-version]") as HTMLButtonElement).click());
  expect(await until(() => !host.querySelector("[data-pages-new-version]"))).toBe(true);
  const used = findPage(page.id)!;
  expect(used.spec.kind === "bespoke" && used.spec.html).toContain("Example: changed for “Add a column for stuck time”");
  expect(used.permissions).toEqual(["agents.read", "agents.stop"]);
  expect(host.querySelector("[data-pages-open] h1")!.textContent).toBe("Agents");
});

it("a new version that newly asks something says so, and using it is Use it and allow", async () => {
  const page = { ...pageFromSpec(AGENTS, "Every agent", "ed", "today", [], 1, undefined, "ed"), id: "page-agents" };
  await keepPage(page);
  requestOpenPage(page.id);
  const { PagesContent } = await import("./PagesView");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(PagesContent)));
  await act(async () => (host.querySelector("[data-pages-menu-button]") as HTMLButtonElement).click());
  await act(async () => (host.querySelector("[data-pages-rebuild]") as HTMLButtonElement).click());
  await type(host.querySelector('[data-pages-rebuild-ask] input') as HTMLInputElement, "let me message a Mono");
  await act(async () => (host.querySelector("[data-pages-rebuild-ask] form") as HTMLFormElement).requestSubmit());
  await until(() => host.querySelector("[data-pages-new-version]"));
  expect(host.querySelector("[data-pages-new-version] [data-page-permissions]")!.textContent).toContain("Send a Mono a message when you tap");
  const use = host.querySelector("[data-pages-use-version]") as HTMLButtonElement;
  expect(use.textContent).toBe("Use it and allow");
  await act(async () => use.click());
  await until(() => findPage(page.id)!.permissions.includes("agents.message"));
  expect(findPage(page.id)!.permissions).toEqual(["agents.read", "agents.stop", "agents.message"]);
});
