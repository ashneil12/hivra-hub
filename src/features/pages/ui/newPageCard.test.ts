// @vitest-environment happy-dom
// G15 on screen: New page and Change on Pages ask the chosen first mate in its own chat, and its page_build there comes
// back to the card as the preview to keep or throw away. A busy first mate gets nothing sent and a Try again line.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import type { Root } from "react-dom/client";
import { setHomeChiefHost, type HomeChiefHost, type HomeChiefSession } from "../../home/model/homeChief";
import { addMono } from "../../monos/model/mono";
import { chatPreview, previewFromChat } from "../../selfBuild/model/pagesChat";
import { chatPageVersion, resetPageAsksForTest } from "../../selfBuild/model/pageAsks";
import { findPage, keepPage, pageFromSpec, requestOpenPage, resetPagesForTest } from "../model/pages";
import type { PageSpec } from "../model/pageSpec";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const SPEC = { kind: "blocks", title: "Agents now", blocks: [{ kind: "note", title: "About", text: "What each agent does." }] };
const CURRENT: PageSpec = { kind: "blocks", title: "Agents", blocks: [{ kind: "note", title: "Now", text: "Three agents running." }] };
const CHANGED = { kind: "blocks", title: "Agents and stuck time", blocks: [{ kind: "note", title: "Now", text: "Three running, one stuck for 2h." }] };

let chat: { sent: { sessionId: string; text: string }[]; busy: boolean; blocks: HomeChiefSession["blocks"][number][] };
let undo: () => void = () => undefined;

beforeEach(async () => {
  localStorage.clear();
  resetPagesForTest();
  resetPageAsksForTest();
  addMono({ id: "ed", name: "Ed", mascot: "robot", color: "x", projects: [] });
  const { hubData, setHubDataSource } = await import("../../hub/model/hubData");
  setHubDataSource(undefined);
  const src = Object.create(hubData());
  src.listProjects = () => [];
  setHubDataSource(src);
  chat = { sent: [], busy: false, blocks: [] };
  const host: HomeChiefHost = {
    ensure: async (monoId) => ({ id: `chat-${monoId}` }),
    submit: (sessionId, text) => {
      chat.sent.push({ sessionId, text });
      chat.blocks.push({ role: "user", text });
      chat.busy = true;
      return true;
    },
    answer: () => undefined,
    read: (id) => ({ id, busy: chat.busy, blocks: chat.blocks }),
  };
  undo = setHomeChiefHost(host);
});
const roots: Root[] = [];
afterEach(() => {
  act(() => roots.splice(0).forEach((r) => r.unmount()));
  undo();
});
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
async function render() {
  const { PagesContent } = await import("./PagesView");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(PagesContent)));
  return host;
}

it("New page: the description goes to Ed's own chat, and Ed's page_build there fills the card's preview to keep", async () => {
  const host = await render();
  await type(host.querySelector('[data-pages-new] input[aria-label="Describe the page"]') as HTMLInputElement, "a page of every agent");
  await act(async () => (host.querySelector("[data-pages-new] form") as HTMLFormElement).requestSubmit());
  expect(await until(() => chat.sent.length)).toBe(1);
  expect(chat.sent[0].sessionId).toBe("chat-ed");
  expect(chat.sent[0].text).toContain("“a page of every agent”");
  expect(host.querySelector("[data-pages-build-state]")!.textContent).toContain("Ed is building your page");

  let previewId = "";
  await act(async () => { previewId = previewFromChat({ spec: SPEC, request: "a page of every agent" }, { monoId: "ed", name: "Ed" }).previewId; });
  expect(await until(() => host.querySelector("[data-pages-preview]"))).toBeTruthy();
  expect(host.querySelector("[data-pages-preview] h1")!.textContent).toBe("Agents now");
  expect(host.textContent).toContain("Ed built this preview");

  await act(async () => (host.querySelector("[data-pages-keep]") as HTMLButtonElement).click());
  expect(await until(() => findPage(previewId)?.keptAt)).toBeTruthy();
  // Kept from the card, so it no longer waits as a chat preview (no second See it at the bottom).
  expect(chatPreview(previewId)).toBeUndefined();
});

it("a busy first mate: nothing is sent, the card says so with Try again and Open its chat, and Try again sends it", async () => {
  chat.busy = true;
  const host = await render();
  await type(host.querySelector('[data-pages-new] input[aria-label="Describe the page"]') as HTMLInputElement, "a page of every agent");
  await act(async () => (host.querySelector("[data-pages-new] form") as HTMLFormElement).requestSubmit());
  expect(await until(() => host.querySelector('[data-pages-build-state="busy"]'))).toBeTruthy();
  expect(host.querySelector("[data-pages-build-problem]")!.textContent).toContain("Ed is in the middle of something else");
  expect(host.querySelector("[data-pages-open-chat]")!.textContent).toBe("Open Ed's chat");
  expect(chat.sent).toEqual([]);

  chat.busy = false;
  await act(async () => (host.querySelector("[data-pages-try-again]") as HTMLButtonElement).click());
  expect(await until(() => chat.sent.length)).toBe(1);
});

it("Change on a kept page sends the page as it is with the ask, and the new version comes back to that page", async () => {
  const page = { ...pageFromSpec(CURRENT, "Every agent", "Ed", "today", [], 1, undefined, "ed"), id: "page-agents" };
  await keepPage(page);
  requestOpenPage(page.id);
  const host = await render();
  await act(async () => (host.querySelector("[data-pages-menu-button]") as HTMLButtonElement).click());
  await act(async () => (host.querySelector("[data-pages-rebuild]") as HTMLButtonElement).click());
  await type(host.querySelector('[data-pages-rebuild-ask] input[aria-label="What should change"]') as HTMLInputElement, "Add stuck time");
  await act(async () => (host.querySelector("[data-pages-rebuild-ask] form") as HTMLFormElement).requestSubmit());
  expect(await until(() => chat.sent.length)).toBe(1);
  expect(chat.sent[0].text).toContain("“Add stuck time”");
  expect(chat.sent[0].text).toContain(JSON.stringify(CURRENT, null, 2));

  await act(async () => { previewFromChat({ spec: CHANGED, request: "Add stuck time" }, { monoId: "ed", name: "Ed" }); });
  expect(await until(() => host.querySelector("[data-pages-new-version]"))).toBeTruthy();
  // Still on the kept page: the change didn't open as a new page.
  expect(host.querySelector("[data-pages-preview]")).toBeNull();
  expect(host.textContent).toContain("“Add stuck time” · Ed built a new version");
  await act(async () => (host.querySelector("[data-pages-use-version]") as HTMLButtonElement).click());
  expect(await until(() => findPage(page.id)!.spec.title === "Agents and stuck time")).toBe(true);
  expect(chatPageVersion(page.id)).toBeUndefined();
});
