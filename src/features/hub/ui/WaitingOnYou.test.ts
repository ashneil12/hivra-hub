// @vitest-environment happy-dom
// Port map idea 3: each row's reason is the same plain grey word; a red line is two explicit choices, no default.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockHubData } from "../model/mockData";
import { setHubDataSource } from "../model/hubData";
import { noteChats, resetWaitingChats, setWaitingChatsHost } from "../model/waitingChats";
import { WaitingOnYou } from "./WaitingOnYou";

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const sent: [string, string][] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  resetWaitingChats();
  sent.length = 0;
  setHubDataSource({ ...mockHubData, listProjects: () => [] });
  setWaitingChatsHost({ liveQuestion: () => undefined, respond: () => undefined, send: async (id, text) => (sent.push([id, text]), true), open: () => undefined });
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
});

const turn = (id: string, text: string) => ({ id, cwd: "/tmp/x", title: `claude · ${id}`, harness: "claude" as const, blocks: [{ role: "user" as const, text: "go", startedAt: 1 }, { role: "assistant" as const, text }] });

it("every row says why in the same plain grey word, no colour chip", () => {
  noteChats([
    turn("a", "Needs Ash (sign in): Log in to Vercel?"),
    turn("b", "Needs Ash: Keep the old page?\nMy pick: Archive it."),
    turn("c", "Needs Ash (red line): Ship to production tonight?\nMy pick: Tomorrow morning."),
  ]);
  act(() => root.render(createElement(WaitingOnYou, { projectId: undefined })));
  const reasons = [...el.querySelectorAll("[data-hub-waiting-reason]")];
  expect(reasons.map((r) => r.textContent)).toEqual(["sign in", "pick an option", "approve a red-line step"]);
  for (const r of reasons) {
    expect(r.className).not.toMatch(/bg-|text-|rounded|border/);
    expect(r.parentElement!.className).toContain("text-content/60");
  }
  // The suggestion stays on its own line under the question.
  const b = el.querySelector('[data-hub-waiting-chat="b"]')!;
  expect(b.querySelector("[data-hub-waiting-pick]")!.textContent).toBe("Suggests: Archive it.");
  // No suggestion, no line; no project, no "No project ·" in front of the chat's name.
  const a = el.querySelector('[data-hub-waiting-chat="a"]')!;
  expect(a.querySelector("[data-hub-waiting-pick]")).toBeNull();
  expect(a.textContent).not.toMatch(/No suggestion|No project/);
  const where = a.querySelector("[data-hub-waiting-where]")!.textContent!;
  expect(where.length).toBeGreaterThan(0);
  expect(where.startsWith("·")).toBe(false);
});

it("a red line offers exactly Approve once and Deny, neither the default, no Always allow and no one-tap pick", async () => {
  noteChats([turn("c", "Needs Ash (red line): Ship to production tonight?\nMy pick: Tomorrow morning.")]);
  act(() => root.render(createElement(WaitingOnYou, { projectId: undefined })));
  const row = el.querySelector('[data-hub-waiting-chat="c"]')!;
  const choices = [...row.querySelectorAll("[data-hub-approval] button")];
  expect(choices.map((b) => b.textContent)).toEqual(["Approve once", "Deny"]);
  expect(choices[0].className).toBe(choices[1].className);
  expect(choices.some((b) => b === document.activeElement || b.hasAttribute("autofocus"))).toBe(false);
  expect(row.textContent).not.toMatch(/Always allow|this session/i);
  expect(row.querySelector("[data-hub-take-pick]")).toBeNull();
  await act(async () => (choices[0] as HTMLButtonElement).click());
  expect(sent).toEqual([["c", "Approved, this once: Tomorrow morning."]]);
});
