// @vitest-environment happy-dom
// "Editing the interface": Change the hub moves data; a change to how a screen looks or works is the app itself, and it
// goes to the MonoCode Hub lead (worktree, a dev copy Ash tries, Ship), with a short explanation instead of a flat no.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addMono } from "../../monos/model/mono";
import { resetPageActionsForTest, setPageActionsHost } from "../../pages/model/pageActions";
import { APP_CHANGE_NOTE, hubLeadMono, sendToHubLead } from "./appChange";
import { requestChange } from "./hubChange";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roster = [{ id: "bo" }];
const req = { flow: "hub" as const, projectId: "today", monoId: "bo", prompt: "Make the sidebar icons bigger" };

beforeEach(() => { localStorage.clear(); resetPageActionsForTest(); });
afterEach(() => vi.restoreAllMocks());

it("a Mono's 'this is a change to the app itself' is its own result, not a turn-down", async () => {
  // The dev stub (Ash OS's preview builds are retired, WP-04): words about a screen's look are a change to the app.
  const r = await requestChange(req, { roster, stub: true });
  expect(r).toEqual({ status: "app-change", reason: "bo says this is a change to the app itself: Example: that's how a screen looks." });
  expect((await requestChange({ ...req, prompt: "group my chats by week" }, { roster, stub: true })).status).toBe("ready");
});

it("Send to MonoCode Hub lead puts Ash's words in that Lead's own chat, through the composer's send", async () => {
  addMono({ id: "hub-lead", name: "Hub lead", sessionId: "s-hub", mascot: "letter", color: "x", projects: [] });
  const sent: [string, string][] = [];
  setPageActionsHost({ liveQuestion: () => undefined, respond: () => undefined, send: async (id, text) => { sent.push([id, text]); return true; }, open: () => undefined, openMono: () => undefined });
  expect(hubLeadMono()?.id).toBe("hub-lead");
  expect(await sendToHubLead("Make the sidebar icons bigger")).toEqual({ ok: true, lead: "Hub lead" });
  expect(sent[0][0]).toBe("s-hub");
  expect(sent[0][1]).toContain("Make the sidebar icons bigger");
  expect(sent[0][1]).toMatch(/worktree[\s\S]*copy of the app[\s\S]*Ship/);
  expect(sent[0][1]).toContain("(sent from Change the app)");
});

it("the old Harness lead's seat is not adopted; a Lead with no chat yet is opened and the words follow once it has one", async () => {
  addMono({ id: "ash-lead", name: "Harness lead", mascot: "letter", color: "x", projects: [] });
  const sent: string[] = [];
  const opened: string[] = [];
  setPageActionsHost({
    liveQuestion: () => undefined, respond: () => undefined, open: () => undefined,
    send: async (id) => { sent.push(id); return true; },
    openMono: (id) => {
      opened.push(id);
      const roster = JSON.parse(localStorage.getItem("monocode:mono-roster")!);
      localStorage.setItem("monocode:mono-roster", JSON.stringify(roster.map((m: { id: string }) => (m.id === id ? { ...m, sessionId: "s-new" } : m))));
    },
  });
  expect(await sendToHubLead("Rounder cards")).toEqual({ ok: false, reason: "The MonoCode Hub lead isn't on your Monos list yet." });
  expect(opened).toEqual([]);
  addMono({ id: "hub-lead", name: "Hub lead", mascot: "letter", color: "x", projects: [] });
  expect(await sendToHubLead("Rounder cards")).toEqual({ ok: true, lead: "Hub lead" });
  expect(opened).toEqual(["hub-lead"]);
  expect(sent).toEqual(["s-new"]);
  resetPageActionsForTest();
  expect(await sendToHubLead("x")).toEqual({ ok: false, reason: "The app isn't ready to send that yet. Open the MonoCode Hub lead and ask there." });
});

it("on screen: the explanation and Send to MonoCode Hub lead instead of a flat no", async () => {
  addMono({ id: "bo", name: "Bo", mascot: "letter", color: "x", projects: [] });
  addMono({ id: "hub-lead", name: "Hub lead", sessionId: "s-hub", mascot: "letter", color: "x", projects: [] });
  const sent: string[] = [];
  setPageActionsHost({ liveQuestion: () => undefined, respond: () => undefined, send: async (id) => { sent.push(id); return true; }, open: () => undefined, openMono: () => undefined });
  localStorage.setItem("monocode:hub-change-dev-stub", "1"); // the dev stub: Ash OS's preview builds are retired (WP-04)
  const { HubChangeContent } = await import("../ui/HubChangeView");
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => createRoot(host).render(createElement(HubChangeContent, { flow: "hub", projectId: "today" })));
  expect(host.querySelector("[data-hub-change-app-note]")!.textContent).toBe(APP_CHANGE_NOTE);
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Make the sidebar icons bigger");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  const card = host.querySelector("[data-hub-change-app-change]")!;
  expect(card.textContent).toContain("This changes the app itself");
  expect(card.textContent).toContain("that's how a screen looks.");
  const send = card.querySelector("[data-hub-change-send-lead]") as HTMLButtonElement;
  expect(send.textContent).toBe("Send to MonoCode Hub lead");
  await act(async () => send.click());
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(sent).toEqual(["s-hub"]);
  expect(host.querySelector("[data-hub-change-sent-lead]")!.textContent).toContain("Sent to Hub lead");
});
