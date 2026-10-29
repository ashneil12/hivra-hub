// @vitest-environment happy-dom
// A6: a Mono's team draft shows as a card in the chat it was drafted in, saying plainly that nothing is made yet,
// with its name, what it is for, its projects (by name) and the Monos that belong; Not this one takes it away.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// The composer needs the app's window (file drops); the chat's own screen is what is under test.
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

const HIVRA = "/Users/ash/Projects/hivra";
const ME = { monoId: "chief-of-staff", name: "Chief of Staff" };

async function setup() {
  const hub = await import("../../hub/model/hubData");
  const mock = await import("../../hub/model/mockData");
  hub.setHubDataSource({
    ...mock.mockHubData,
    listProjects: () => [
      { id: "hivra", name: "Hivra", folder: HIVRA, iconShape: "sparkles" },
      { id: "nibbii", name: "Nibbii", folder: "/Users/ash/Projects/nibbii", iconShape: "palette" },
    ],
  } as never);
  const mono = await import("../../monos/model/mono");
  const postie = mono.createMono([HIVRA]);
  mono.saveMonoName(postie.id, "Postie");
  return { make: await import("../model/teamMake"), postie };
}

/** The card and every element above it: none is lifted out of the page flow. */
function floats(el: Element): string[] {
  const out: string[] = [];
  for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
    const cls = typeof e.className === "string" ? e.className : "";
    if (/(^|\s)(fixed|absolute|sticky)(\s|$)|(^|\s)z-\d/.test(cls)) out.push(cls);
  }
  return out;
}

it("the card says what the team would be and that nothing is made yet, by plain project and Mono names", async () => {
  const a = await setup();
  a.make.draftTeam(
    { name: "Marketing", brief: "Owns the launch.", projects: ["hivra", "nibbii"], members: ["Postie"] },
    ME,
    Date.now(),
    { session: "cos-chat" },
  );
  const { TeamDraftsInChat } = await import("./TeamDraftCard");
  act(() => root.render(createElement(TeamDraftsInChat, { session: "cos-chat" })));
  const card = container.querySelector("[data-team-draft]")!;
  expect(card).toBeTruthy();
  expect(card.textContent).toContain("Marketing team");
  expect(card.textContent).toContain("Owns the launch.");
  expect(card.textContent).toContain("Hivra, Nibbii");
  expect(card.textContent).toContain("Postie");
  expect(card.textContent).toContain("Nothing is made yet. Say yes in the chat to make it; this card only turns it down.");
  // r62 (A5): the card has no yes button, so nothing on it says to click it.
  expect(card.textContent).not.toMatch(/click/i);
  expect(floats(card)).toEqual([]);
});

it("it shows only in the chat it was drafted in, and Not this one takes it away without making anything", async () => {
  const a = await setup();
  const draft = a.make.draftTeam({ name: "Marketing", brief: "Owns the launch.", projects: ["hivra"] }, ME, Date.now(), { session: "cos-chat" });
  const { TeamDraftsInChat } = await import("./TeamDraftCard");
  act(() =>
    root.render(
      createElement("div", null, createElement(TeamDraftsInChat, { session: "cos-chat" }), createElement(TeamDraftsInChat, { session: "other-chat" })),
    ),
  );
  expect(container.querySelectorAll("[data-team-draft]")).toHaveLength(1);
  act(() => (container.querySelector("[data-team-draft-dismiss]") as HTMLElement).click());
  expect(container.querySelector("[data-team-draft]")).toBeNull();
  const teams = await import("../../hub/model/hubTeams");
  expect(teams.listTeams()).toEqual([]);
  expect(a.make.waitingTeamDrafts().some((d) => d.id === draft.draftId)).toBe(false);
});

it("in a group chat it is a message in the conversation's scroll, after Ash's, never floating over the chat", async () => {
  const a = await setup();
  const chat = await import("../../hub/model/hubChats");
  const { GroupChatView } = await import("../../hub/ui/GroupChatView");
  const room = chat.createChat("hub", "Leadership team", ["chief-of-staff"]);
  const conv = chat.startConversation(room.id, "Let's make a marketing team");
  a.make.draftTeam({ name: "Marketing", brief: "Owns the launch.", projects: ["hivra"] }, ME, Date.now(), { room: room.id, conv });
  act(() => root.render(createElement(GroupChatView, { chatId: room.id, projectId: "hub" })));
  const cards = container.querySelectorAll("[data-team-draft]");
  expect(cards).toHaveLength(1);
  const card = cards[0];
  expect(floats(card)).toEqual([]);
  const scroll = card.closest(".overflow-y-auto")!;
  expect(scroll).toBeTruthy();
  const ash = [...scroll.querySelectorAll("*")].find((e) => e.textContent === "Let's make a marketing team");
  expect(ash).toBeTruthy();
  expect(ash!.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
