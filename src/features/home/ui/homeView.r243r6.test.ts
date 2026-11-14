// @vitest-environment happy-dom
// Review of PR #243 (WP-210), round 6: fails on f892dbdb4.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  invoke: vi.fn(async (cmd: string) => (/list|cards|decisions|tasks|docs|habits|programme/i.test(cmd) ? [] : null)),
}));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listen: vi.fn(async () => () => undefined),
}));

import { mockHubData } from "../../hub/model/mockData";
import { setHubDataSource } from "../../hub/model/hubData";
import type { HubProject } from "../../hub/model/types";
import { noteChats, resetWaitingChats, setWaitingChatsHost, setWorkerQuestionRouter } from "../../hub/model/waitingChats";
import { setHomeOpener, type HomeOpenTarget } from "../model/opener";
import { HomeView } from "./HomeView";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const HUB_PROJECTS: HubProject[] = [
  { id: "tally", name: "Tally", shortName: "Tally", iconShape: "folder", folder: "/Users/ash/Projects/tally" },
];

let root: Root;
let container: HTMLElement;
const opened: HomeOpenTarget[] = [];
let stopOpener: () => void = () => undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  resetWaitingChats();
  opened.length = 0;
  setHubDataSource({ ...mockHubData, listProjects: () => HUB_PROJECTS });
  setWorkerQuestionRouter(undefined);
  setWaitingChatsHost({ liveQuestion: () => undefined, respond: () => {}, send: async () => true, open: () => {} });
  stopOpener = setHomeOpener((target) => { opened.push(target); });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  stopOpener();
});

// MED. A Needs you row's sentence is a button that opens `targetFor(line)`. HomeView builds the line from the item's
// kind and decision key only, never `item.open`: a chat question becomes a "question" line whose target is the chat's
// session id, so a click opens the project's team on a task that does not exist instead of the chat. A chat approval,
// a Page ask, a PR review and a gate card land on the Inbox or a task under an id that is not theirs.
it("clicking a chat question's sentence on Home opens that chat", async () => {
  noteChats([{
    id: "tally-lead", cwd: "/Users/ash/Projects/tally", title: "Tally lead", harness: "claude", busy: false, queuedMessages: [],
    blocks: [{ role: "user", text: "go", startedAt: 1 }, { role: "assistant", text: "Needs Ash: Which font should the landing page use?\nMy pick: Inter." }],
  } as Parameters<typeof noteChats>[0][number]], 1000);
  await act(async () => {
    root.render(createElement(HomeView));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const row = [...container.querySelectorAll<HTMLElement>("[data-home-line]")].find((el) => el.textContent?.includes("Which font"));
  expect(row, container.innerHTML.slice(0, 400)).toBeDefined();
  const sentence = [...row!.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.includes("Which font"));
  expect(sentence).toBeDefined();
  act(() => sentence!.click());
  expect(opened).toEqual([{ kind: "chat", id: "tally-lead", projectId: "tally" }]);
});

it("lets a pending Home read finish when task changes arrive during the read", async () => {
  const callbacks = new Map<string, () => void>();
  let finish: (value: unknown) => void = () => undefined;
  let catalogs = 0;
  vi.mocked(listen).mockImplementation(async (event, handler) => {
    callbacks.set(String(event), () => handler({ payload: {} } as never));
    return () => undefined;
  });
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === "panels_catalog" && ++catalogs === 1) return new Promise((resolve) => { finish = resolve; });
    return /list|cards|decisions|tasks|docs|habits|programme/i.test(cmd) ? [] : null;
  });
  await act(async () => root.render(createElement(HomeView)));
  expect(container.querySelector("[data-home-loading]")?.textContent).toContain("Loading Home");
  await act(async () => {
    callbacks.get("tasks://changed")?.();
    callbacks.get("tasks://changed")?.();
  });
  expect(catalogs).toBe(1);
  await act(async () => finish([]));
  expect(container.querySelector("[data-home-loading]")).toBeNull();
  expect(container.querySelector("[data-home-action=customize]")).not.toBeNull();
  expect(catalogs).toBe(2);
});
