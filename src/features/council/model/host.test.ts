// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { blankProposal, councilFromUnknown, councilToJson } from "./record";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

it("reads a leading /council and not one mid-sentence", async () => {
  const { consumeCouncilCommand } = await import("./command");
  expect(consumeCouncilCommand("/council should we ship")).toEqual({ matched: true, question: "should we ship" });
  expect(consumeCouncilCommand("  /Council  ")).toEqual({ matched: true, question: "" });
  expect(consumeCouncilCommand("please /council no")).toEqual({ matched: false, question: "" });
  expect(consumeCouncilCommand("/councils")).toEqual({ matched: false, question: "" });
});

it("drops a council record that is not the shape, and refuses one that is too big to store", async () => {
  const good = blankProposal("Should we ship?");
  expect(councilFromUnknown(JSON.parse(councilToJson(good)!))?.question).toBe("Should we ship?");
  expect(councilFromUnknown({ ...good, phase: "flying" })).toBeNull();
  expect(councilFromUnknown(null)).toBeNull();
  expect(councilFromUnknown("nope")).toBeNull();
  const huge = blankProposal("x".repeat(20_000));
  expect(councilToJson(huge)).toBeNull();
});

it("convenes on the current project, and two windows cannot overwrite one council", async () => {
  const nav = await import("../../hub/model/hubNav");
  const host = await import("./host");
  expect(host.requestCouncil("should we ship")).toBe(false);

  nav.setHubSelection({ project: "hub", item: "coding-team" });
  expect(host.requestCouncil("should we ship")).toBe(true);
  expect(nav.currentHubSelection().item.startsWith("chat:")).toBe(true);

  const chats = await import("../../hub/model/hubChats");
  const id = nav.currentHubSelection().item.slice("chat:".length);
  const first = chats.getChat(id)!;
  expect(first.council?.question).toBe("should we ship");
  expect(first.council?.phase).toBe("propose");
  expect(first.memberIds).toEqual([]);

  const again = chats.saveCouncil(id, { ...first.council!, question: "a later write" }, 0);
  expect(again).toBe(false);
  expect(chats.getChat(id)!.council?.question).toBe("should we ship");
  expect(chats.getChat(id)!.council?.revision).toBe(1);

  const next = chats.saveCouncil(id, { ...first.council!, question: "corrected" }, 1);
  expect(next).toBe(true);
  expect(chats.getChat(id)!.council?.revision).toBe(2);
});

it("a lost write adopts the row that won, and a newer local write is not rolled back", async () => {
  const chats = await import("../../hub/model/hubChats");
  const { councilToJson } = await import("./record");
  const winner = councilToJson({ ...blankProposal("from the other window"), revision: 9 })!;
  await chats.loadRooms({
    kind: "app",
    load: async () => ({ rooms: [] }),
    upsertRoom: async () => undefined,
    upsertConversation: async () => undefined,
    addMessage: async () => undefined,
    updateMessage: async () => undefined,
    read: async () => [],
    import: async () => ({ rooms: 0, conversations: 0, messages: 0 }),
    addOrigin: async () => undefined,
    openOrigins: async () => [],
    originDone: async () => false,
    // Writes are queued, so the first response arrives only after a newer one is already in memory.
    setCouncil: async (_id, expected) =>
      expected === 0 ? { applied: false, revision: 9, json: winner } : { applied: true, revision: expected + 1, json: "{}" },
  });
  const chat = chats.createChat("hub", "Council", []);
  expect(chats.saveCouncil(chat.id, blankProposal("first"), 0)).toBe(true);
  expect(chats.saveCouncil(chat.id, { ...blankProposal("second"), revision: 1 }, 1)).toBe(true);
  await chats.roomWritesSettled();
  expect(chats.getChat(chat.id)!.council?.revision).toBe(2);
  expect(chats.getChat(chat.id)!.council?.question).toBe("second");
});

it("hands the verdict to the room as a normal brief", async () => {
  const chats = await import("../../hub/model/hubChats");
  chats.resetRoomsForTests();
  const host = await import("./host");
  const chat = chats.createChat("hub", "Council", []);
  const heard: string[] = [];
  host.setCouncilDelegator((brief) => heard.push(brief.outcome));
  const record = {
    ...blankProposal("should we ship"),
    phase: "done" as const,
    verdict: { unresolved: "The price.", killCriteria: "A refund spike.", nextStep: "Publish the page.", minority: "Member C waited.", fromChairman: true },
  };
  const text = host.postCouncilBrief(chat.id, record);
  expect(text).toMatch(/Outcome: Publish the page\./);
  expect(text).toMatch(/Done looks like: A refund spike\./);
  expect(text).toContain("should we ship");
  expect(heard).toEqual(["Publish the page."]);
  expect(chats.getChat(chat.id)!.conversations[0].messages[0]).toMatchObject({ from: "app", kind: "system" });
  host.setCouncilDelegator(undefined);
});
