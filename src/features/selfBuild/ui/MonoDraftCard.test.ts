// @vitest-environment happy-dom
// r29 (Critiquito, from Alfred's r44 blind shots): the new-Mono card floated over the chat, covering Ash's message and
// the reply, and listed skills by id ("Skills: ash-copywriting"). It is a message in the chat it was drafted in, in
// the scroll, and its skills read by their plain names.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../monos/ui/MonoComposer", () => ({ MonoComposer: () => null }));

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const ME = { monoId: "chief-of-staff", name: "Chief of Staff", projects: [] as string[] };
const POSTIE = {
  name: "Example: Postie",
  role: "Drafts X posts",
  who: "I draft your X posts and hand them to Chief of Staff. Drafts only.",
  watchFor: "Anything that would post on X.",
  skills: ["ash-copywriting", "human-writing"],
};

/** The card and every element above it: none is lifted out of the page flow. */
function floats(el: Element): string[] {
  const out: string[] = [];
  for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
    const cls = typeof e.className === "string" ? e.className : "";
    if (/(^|\s)(fixed|absolute|sticky)(\s|$)|(^|\s)z-\d/.test(cls)) out.push(cls);
  }
  return out;
}

it("the card sits in the group chat's conversation as a message after the messages, never over the chat", async () => {
  (await import("../../hub/model/builtInMonos")).ensureBuiltInMonos();
  const chat = await import("../../hub/model/hubChats");
  const make = await import("../model/monoMake");
  const { GroupChatView } = await import("../../hub/ui/GroupChatView");
  const { ChangeBar } = await import("./ChangeBar");
  const room = chat.createChat("hub", "Leadership team", ["chief-of-staff", "projects-manager"]);
  const conv = chat.startConversation(room.id, "Example: make a marketing chat, and a new Mono for X posts");
  make.draftMono(POSTIE, ME, Date.now(), new Set(POSTIE.skills), { room: room.id, conv });
  act(() => root.render(createElement("div", null, createElement(GroupChatView, { chatId: room.id, projectId: "hub" }), createElement(ChangeBar))));
  const cards = container.querySelectorAll("[data-mono-draft]");
  expect(cards).toHaveLength(1); // once: in the chat, not also floating at the top of the window
  const card = cards[0];
  expect(floats(card)).toEqual([]);
  // In the conversation's scroll, after Ash's message.
  const scroll = card.closest(".overflow-y-auto")!;
  expect(scroll).toBeTruthy();
  const ash = scroll.querySelector("[data-hub-msg-ash], [data-hub-msg-from='ash']") ?? [...scroll.querySelectorAll("*")].find((e) => e.textContent === "Example: make a marketing chat, and a new Mono for X posts");
  expect(ash).toBeTruthy();
  expect(ash!.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // Not in another room.
  const other = chat.createChat("hub", "Example: Marketing", ["chief-of-staff"]);
  act(() => root.render(createElement(GroupChatView, { chatId: other.id, projectId: "hub" })));
  expect(container.querySelector("[data-mono-draft]")).toBeNull();
});

it("in a Mono's own chat the card shows for drafts made there, and Not this one takes it away", async () => {
  const make = await import("../model/monoMake");
  const { MonoDraftsInChat } = await import("./MonoDraftCard");
  make.draftMono(POSTIE, ME, Date.now(), new Set(POSTIE.skills), { session: "cos-chat" });
  act(() => root.render(createElement("div", null, createElement(MonoDraftsInChat, { session: "cos-chat" }), createElement(MonoDraftsInChat, { session: "other-chat" }))));
  expect(container.querySelectorAll("[data-mono-draft]")).toHaveLength(1);
  expect(floats(container.querySelector("[data-mono-draft]")!)).toEqual([]);
  act(() => (container.querySelector("[data-mono-draft-dismiss]") as HTMLElement).click());
  expect(container.querySelector("[data-mono-draft]")).toBeNull();
});

it("lists the skills by their plain names, never their ids", async () => {
  const make = await import("../model/monoMake");
  const { MonoDraftsInChat } = await import("./MonoDraftCard");
  make.draftMono(POSTIE, ME, Date.now(), new Set(POSTIE.skills), { session: "cos-chat" });
  act(() => root.render(createElement(MonoDraftsInChat, { session: "cos-chat" })));
  const card = container.querySelector("[data-mono-draft]")!;
  expect(card.textContent).toContain("Skills: Copywriting, Human writing");
  expect(card.textContent).not.toMatch(/ash-copywriting|human-writing/);
});

it("the window-wide bar no longer floats a draft card over the screen", async () => {
  const make = await import("../model/monoMake");
  const { ChangeBar } = await import("./ChangeBar");
  make.draftMono(POSTIE, ME, Date.now(), new Set(POSTIE.skills), { session: "cos-chat" });
  act(() => root.render(createElement(ChangeBar)));
  expect(container.querySelector("[data-mono-draft]")).toBeNull();
});
