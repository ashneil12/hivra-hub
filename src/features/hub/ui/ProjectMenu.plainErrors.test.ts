// @vitest-environment happy-dom
// WP-94: when the hub refuses a change with the system's own sentence ("database is locked"), the project's menu says
// what to do about it instead. A refusal in the store's own plain words is passed through unchanged
// (Projects.record.test.ts covers the name clash).
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localTestHub, type TestHub } from "../../../dev/hubTestTransport";
import { setHubDataSource } from "../model/hubData";
import { HubStore } from "../model/hubStore";
import { createLiveHubData } from "../model/liveHubData";
import { ProjectMenu } from "./ProjectMenu";

const FAST = { coalesceMs: 5, minGapMs: 0, healthMs: 20, pollMs: 40, retryMs: [40], stopGraceMs: 5 };
let t: TestHub;
let store: HubStore;
let root: Root;
let container: HTMLElement;

async function until(read: () => unknown, what: string, ms = 4000) {
  const end = Date.now() + ms;
  while (!(await read())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${document.body.textContent}`);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}

const project = (id: string) => store.getSnapshot().projects.find((p) => p.id === id)!;
function type(el: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  t = await localTestHub();
  // The disk is full: every write the project's menu makes is refused in the system's own words.
  const inner = t.transport.call;
  t.transport.call = (action, payload) =>
    action === "project-rename" ? Promise.reject({ kind: "error", message: "database is locked" }) : inner(action, payload);
  store = new HubStore({ transport: t.transport, ...FAST });
  setHubDataSource(createLiveHubData(store), store);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  store.start();
  await until(() => store.getSnapshot().status === "ready", "ready");
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await new Promise((r) => setTimeout(r, 20));
  store.stop();
  setHubDataSource(undefined);
  vi.unstubAllGlobals();
});

describe("a refused change", () => {
  it("shows what to do instead of the raw database sentence, when a rename is refused", async () => {
    act(() => root.render(createElement(ProjectMenu, { project: project("nibbii"), anchor: { x: 10, y: 10 }, onClose: () => undefined })));
    act(() => (document.querySelector('[data-project-menu-item="Rename"]') as HTMLElement).click());
    const input = document.querySelector('[aria-label="Project name"]') as HTMLInputElement;
    type(input, "Nibbii Pet");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await until(() => document.querySelector("[data-project-rename-problem]"), "the refusal");
    const text = document.querySelector("[data-project-rename-problem]")?.textContent ?? "";
    expect(text).toBe("The app's database is busy. Nothing was lost. Try again in a moment.");
    // Still open, so the same tap can be tried again.
    expect(document.querySelector('[aria-label="Project name"]')).not.toBeNull();
  });

  it("shows what to do when a new shape is refused", async () => {
    act(() => root.render(createElement(ProjectMenu, { project: project("hivra"), anchor: { x: 10, y: 10 }, onClose: () => undefined })));
    act(() => (document.querySelector('[data-project-menu-item="Change icon"]') as HTMLElement).click());
    await act(async () => (document.querySelector('[data-project-shape-choice="megaphone"]') as HTMLElement).click());
    await until(() => document.querySelector("[data-project-icon-problem]"), "the refusal");
    expect(document.querySelector("[data-project-icon-problem]")?.textContent).toContain("Try again in a moment");
  });
});
