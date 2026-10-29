// @vitest-environment happy-dom
// r74 (blind s06, 29 Oct): the Lead stopped to ask Ash before starting a worker. Today showed the ask, but Being built
// said "Nobody's working on Tally right now". A project's chat waiting on Ash shows there too, as a red row.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockHubData } from "../model/mockData";
import { setHubDataSource } from "../model/hubData";
import { noteChats, resetWaitingChats, setWaitingChatsHost } from "../model/waitingChats";
import { BeingBuiltView } from "./BeingBuiltView";

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const opened: string[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  resetWaitingChats();
  opened.length = 0;
  setHubDataSource({ ...mockHubData, listProjects: () => [{ ...mockHubData.listProjects()[0], id: "tally", name: "Tally", folder: "/tmp/tally" }] });
  setWaitingChatsHost({ liveQuestion: () => undefined, respond: () => undefined, send: async () => true, open: (id) => void opened.push(id) });
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
});

const turn = (id: string, cwd: string, text: string) => ({ id, cwd, title: "Tally lead", harness: "claude" as const, blocks: [{ role: "user" as const, text: "go", startedAt: 1 }, { role: "assistant" as const, text }] });

it("a Lead waiting on Ash before it starts is listed, not 'Nobody's working'", () => {
  noteChats([turn("lead-1", "/tmp/tally", "Nothing started.\nNeeds the user: everyone sees everyone's tallies, or private unless shared?\nMy pick: everyone sees everyone's")]);
  act(() => root.render(createElement(BeingBuiltView, { projectId: "tally" })));
  expect(el.textContent).not.toContain("Nobody's working");
  const row = el.querySelector('[data-hub-being-built-waiting-chat="lead-1"]')!;
  expect(row).not.toBeNull();
  expect(row.hasAttribute("data-hub-red-row")).toBe(true);
  expect(row.textContent).toContain("Needs you");
  expect(row.textContent).toContain("Tally lead is waiting on you before it starts");
  expect(row.textContent).toContain("private unless shared?");
  const link = row.querySelector("[data-hub-needs-link] button") as HTMLButtonElement;
  act(() => link.click());
  expect(opened).toEqual(["lead-1"]);
});

it("another project's waiting chat stays off this page", () => {
  noteChats([turn("other", "/tmp/elsewhere", "Needs Ash: ship it?\nMy pick: yes")]);
  act(() => root.render(createElement(BeingBuiltView, { projectId: "tally" })));
  expect(el.querySelector("[data-hub-being-built-waiting]")).toBeNull();
  expect(el.textContent).toContain("Nobody's working on Tally");
});
