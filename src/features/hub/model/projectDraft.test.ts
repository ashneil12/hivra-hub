// @vitest-environment happy-dom
// New project's interview with the engine mocked (the turn itself: projectInterview.ts): the draft keeps the
// chat, a reply's `project` block becomes the preview card, nothing is made before Create, and with no engine the chat
// says so instead of asking scripted questions.
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearProjectDraft, projectDraft, saveProjectDraft } from "./projectDraft";
import { mockHubData } from "./mockData";
import { NewProjectView } from "../ui/NewProjectView";

const harness = vi.hoisted(() => ({ live: true, prompts: [] as string[], replies: [] as string[] }));
vi.mock("../../../integrations/harness", async (original) => ({
  ...(await original<object>()),
  canRunHarnessTextPrompt: () => harness.live,
  runHarnessTextPrompt: async (input: { prompt: string }) => {
    harness.prompts.push(input.prompt);
    return harness.replies.shift() ?? "Tell me more?";
  },
}));
const made = vi.hoisted(() => [] as unknown[]);
vi.mock("./projectActions", async (original) => ({
  ...(await original<object>()),
  createProject: async (input: unknown) => { made.push(input); return new Promise(() => undefined); },
}));
vi.mock("../../../platform/tauri/fs", async (original) => ({ ...(await original<object>()), homeDir: async () => "/Users/example" }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement;
let root: Root;
beforeEach(() => {
  harness.live = true;
  harness.prompts = [];
  harness.replies = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  clearProjectDraft();
});

const q = (s: string) => host.querySelector(s) as HTMLElement | null;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
function type(selector: string, value: string) {
  const el = q(selector) as HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
async function enter(selector: string, value: string) {
  await act(async () => type(selector, value));
  await act(async () => q(selector)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await settle();
}

it("a draft with a name is kept (and stored); an unnamed one isn't shown", () => {
  saveProjectDraft({ name: "", started: false, lines: [], tpl: null, addon: false });
  expect(projectDraft()).toBeNull();
  saveProjectDraft({ name: "Moonrise", started: true, lines: [{ from: "cos", text: "Q1" }], tpl: null, addon: false });
  expect(projectDraft()?.name).toBe("Moonrise");
  expect(JSON.parse(localStorage.getItem("monocode:hub-project-draft")!).name).toBe("Moonrise");
  clearProjectDraft();
  expect(projectDraft()).toBeNull();
});

it("the interview asks what it needs, and its proposal becomes the card; nothing is made before Create", async () => {
  harness.replies = [
    "Moonrise, nice. What's it about, and do you already have code for it?",
    'Got it.\n```project\n{"name": "Moonrise", "oneLine": "A cosy farming game for the Mac notch", "template": "game-studio", "code": "none", "addon": true}\n```',
  ];
  const before = mockHubData.listProjects().length;
  made.length = 0;
  await act(async () => root.render(createElement(NewProjectView)));
  await enter("[data-hub-new-project-name]", "Moonrise");
  expect(host.textContent).toContain("What's it about, and do you already have code for it?");
  // The first turn: the short note on what Create needs, not a script.
  expect(harness.prompts[0]).toContain('A new project is being set up in the app, called "Moonrise"');
  expect(harness.prompts[0]).toContain("You are a first mate.");
  expect(harness.prompts[0]).toContain("```project");
  expect(q("[data-hub-new-project-preview]")).toBeNull();

  await enter("[data-hub-new-project-answer]", "A cosy farming game, no code yet. Add the design reviewer too");
  // Each turn carries the chat so far.
  expect(harness.prompts[1]).toContain("You: Moonrise, nice. What's it about");
  expect(harness.prompts[1]).toContain("A cosy farming game, no code yet. Add the design reviewer too");
  const card = q("[data-hub-new-project-preview]");
  expect(card?.textContent).toContain("A cosy farming game for the Mac notch");
  expect(host.textContent).toContain("Got it.");
  expect(host.textContent).not.toContain("```project");
  expect(q('[data-hub-template="game-studio"]')?.className).toContain("bg-content/12");
  expect(q("[data-hub-new-project-code]")?.getAttribute("data-hub-new-project-code")).toBe("none");
  expect(q("[data-hub-new-project-team]")?.textContent).toContain("Moonrise lead, its own lead");
  expect(mockHubData.listProjects()).toHaveLength(before);
  expect(made).toEqual([]);
  expect(projectDraft()).toMatchObject({ name: "Moonrise", tpl: "game-studio", oneLine: "A cosy farming game for the Mac notch", addon: true });

  await act(async () => q("[data-hub-create-project]")!.click());
  expect(made).toEqual([{ name: "Moonrise", oneLine: "A cosy farming game for the Mac notch", code: false, folder: undefined, shape: "gamepad" }]);
});

it("leaving mid-interview and coming back shows the chat as it was, and the interview answers the last line", async () => {
  saveProjectDraft({
    name: "Moonrise", started: true, tpl: null, addon: false,
    lines: [{ from: "cos", text: "What's Moonrise about?" }, { from: "ash", text: "A cosy farming game" }],
  });
  harness.replies = ["Who's it for?"];
  await act(async () => root.render(createElement(NewProjectView)));
  expect(host.textContent).toContain("New project: Moonrise");
  expect(host.textContent).toContain("A cosy farming game");
  await settle();
  expect(harness.prompts).toHaveLength(1);
  expect(harness.prompts[0]).toContain("You: What's Moonrise about?");
  expect(host.textContent).toContain("Who's it for?");
  await act(async () => root.unmount());
  expect(projectDraft()?.lines.map((l) => l.text)).toEqual(["What's Moonrise about?", "A cosy farming game", "Who's it for?"]);
  root = createRoot(host);
  // Back again, the last word is already the interview's: nothing is asked again.
  await act(async () => root.render(createElement(NewProjectView)));
  await settle();
  expect(harness.prompts).toHaveLength(1);
  expect(host.textContent).toContain("Who's it for?");
});

it("with no engine to talk on, the chat says so plainly and asks nothing scripted", async () => {
  harness.live = false;
  await act(async () => root.render(createElement(NewProjectView)));
  await enter("[data-hub-new-project-name]", "Moonrise");
  expect(q("[data-hub-new-project-stuck]")?.textContent).toContain("no Claude runtime is connected");
  expect(harness.prompts).toHaveLength(0);
  expect(projectDraft()?.lines).toEqual([]);
  expect(q("[data-hub-new-project-preview]")).toBeNull();
});
