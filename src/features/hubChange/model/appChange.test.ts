// @vitest-environment happy-dom
// "Editing the interface": Change the hub moves data; a change to how a screen looks or works is the app itself, and it
// goes to the MonoCode Hub lead (worktree, a dev copy Ash tries, Ship), with a short explanation instead of a flat no.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubCallError } from "../../hub/model/hubTransport";
import { addMono } from "../../monos/model/mono";
import { resetPageActionsForTest, setPageActionsHost } from "../../pages/model/pageActions";
import { APP_CHANGE_NOTE, hubLeadMono, sendToHubLead } from "./appChange";
import { requestChange } from "./hubChange";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roster = [{ id: "projects-manager" }];
const req = { flow: "hub" as const, projectId: "today", monoId: "projects-manager", prompt: "Make the sidebar icons bigger" };
const failing = (message: string) => ({ call: async () => { throw new HubCallError("error", message); }, openFeed: () => () => undefined });

beforeEach(() => { localStorage.clear(); resetPageActionsForTest(); });
afterEach(() => vi.restoreAllMocks());

it("a Mono's 'this is a change to the app itself' is its own result, not a turn-down", async () => {
  const r = await requestChange(req, { roster, transport: failing("Projects Manager says this is a change to the app itself: The sidebar icons are drawn by the app.") });
  expect(r).toEqual({ status: "app-change", reason: "Projects Manager says this is a change to the app itself: The sidebar icons are drawn by the app." });
  expect((await requestChange(req, { roster, transport: failing("Projects Manager turned it down: no.") })).status).toBe("turned-down");
});

it("Send to MonoCode Hub lead puts Ash's words in that Lead's own chat, through the composer's send", async () => {
  addMono({ id: "hub-lead", name: "MonoCode Hub lead", sessionId: "s-hub", mascot: "letter", color: "x", projects: [] });
  const sent: [string, string][] = [];
  setPageActionsHost({ liveQuestion: () => undefined, respond: () => undefined, send: async (id, text) => { sent.push([id, text]); return true; }, open: () => undefined, openMono: () => undefined });
  expect(hubLeadMono()?.id).toBe("hub-lead");
  expect(await sendToHubLead("Make the sidebar icons bigger")).toEqual({ ok: true, lead: "MonoCode Hub lead" });
  expect(sent[0][0]).toBe("s-hub");
  expect(sent[0][1]).toContain("Make the sidebar icons bigger");
  expect(sent[0][1]).toMatch(/worktree[\s\S]*copy of the app[\s\S]*Ship/);
  expect(sent[0][1]).toContain("(sent from Change the hub)");
});

it("the old Harness lead's seat counts; a Lead with no chat yet is opened and the words follow once it has one", async () => {
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
  expect(await sendToHubLead("Rounder cards")).toEqual({ ok: true, lead: "Harness lead" });
  expect(opened).toEqual(["ash-lead"]);
  expect(sent).toEqual(["s-new"]);
  resetPageActionsForTest();
  expect(await sendToHubLead("x")).toEqual({ ok: false, reason: "The app isn't ready to send that yet. Open the MonoCode Hub lead and ask there." });
});

it("on screen: the explanation and Send to MonoCode Hub lead instead of a flat no", async () => {
  addMono({ id: "projects-manager", name: "Projects Manager", mascot: "letter", color: "x", projects: [] });
  addMono({ id: "hub-lead", name: "MonoCode Hub lead", sessionId: "s-hub", mascot: "letter", color: "x", projects: [] });
  const sent: string[] = [];
  setPageActionsHost({ liveQuestion: () => undefined, respond: () => undefined, send: async (id) => { sent.push(id); return true; }, open: () => undefined, openMono: () => undefined });
  const { tauriHubTransport } = await import("../../hub/model/hubTransport");
  vi.spyOn(tauriHubTransport, "call").mockRejectedValue(new HubCallError("error", "Projects Manager says this is a change to the app itself: The sidebar icons are drawn by the app."));
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
  expect(card.textContent).toContain("The sidebar icons are drawn by the app.");
  const send = card.querySelector("[data-hub-change-send-lead]") as HTMLButtonElement;
  expect(send.textContent).toBe("Send to MonoCode Hub lead");
  await act(async () => send.click());
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(sent).toEqual(["s-hub"]);
  expect(host.querySelector("[data-hub-change-sent-lead]")!.textContent).toContain("Sent to MonoCode Hub lead");
});
