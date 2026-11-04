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

  nav.setHubSelection({ project: "hub", item: "coding-team" });
  expect(host.requestCouncil("who owns the price", ["ada", "ada", " ed "])).toBe(true);
  const withMembers = nav.currentHubSelection().item.slice("chat:".length);
  expect(chats.getChat(withMembers)!.memberIds).toEqual(["ada", "ed"]);

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

it("writes the council back when the stored row is missing", async () => {
  const chats = await import("../../hub/model/hubChats");
  let calls = 0;
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
    setCouncil: async (_id, expected, json) => {
      calls += 1;
      if (calls === 1) return { applied: false, revision: 0, json: "{}" };
      const body = JSON.parse(json) as { revision: number; question: string };
      expect(expected).toBe(0);
      expect(body.revision).toBe(1);
      expect(body.question).toBe("kept");
      return { applied: true, revision: 1, json };
    },
  });
  const chat = chats.createChat("hub", "Council", []);
  expect(chats.saveCouncil(chat.id, blankProposal("kept"), 0)).toBe(true);
  await chats.roomWritesSettled();
  expect(calls).toBe(2);
  expect(chats.getChat(chat.id)!.council?.question).toBe("kept");
  expect(chats.getChat(chat.id)!.council?.revision).toBe(1);
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

it("asks each seat through its own model, and the verdict through the chairman seat", async () => {
  const host = await import("./host");
  const { defaultModelId, resolveModel } = await import("../../sessions/model/models");
  expect(host.councilAsk([], async () => "")).toBeUndefined();
  const seen: string[] = [];
  const ask = host.councilAsk(
    [
      { id: "a", cli: "claude", model: "opus", sessionId: "s-a" },
      { id: "b", cli: "codex", model: "gpt", sessionId: "s-b" },
      { id: "c", cli: "grok", model: "grok-2", sessionId: "s-c" },
    ],
    async (seat) => {
      seen.push(`${seat.id}:${seat.cli}:${seat.sessionId}`);
      return "noted";
    },
  );
  const signal = new AbortController().signal;
  expect((await ask!({ seatId: "a", round: "blind", prompt: "p", signal })).text).toBe("noted");
  expect((await ask!({ seatId: "c", round: "verdict", prompt: "p", signal })).text).toBe("noted");
  expect(seen).toEqual(["a:claude:s-a", "c:grok:s-c"]);
  await expect(ask!({ seatId: "nope", round: "blind", prompt: "p", signal })).rejects.toThrow(/not on this council/);

  host.installCouncilModel();
  expect(host.councilModelInUse()).toBeUndefined();

  host.setCouncilEnginesForTests([
    { cli: "claude", family: "Anthropic", label: "Claude Code" },
    { cli: "claude", family: "Anthropic", label: "Claude Code", model: "kept" },
    { cli: "not-a-cli", family: "Other", label: "Other" },
  ]);
  const engines = host.availableCouncilEngines();
  expect(engines[0].model).toBe(resolveModel("claude", defaultModelId("claude")).name);
  expect(engines[1].model).toBe("kept");
  expect(engines[2].model).toBeUndefined();
  host.setCouncilEnginesForTests(undefined);
});

it("keeps a fractional tally and a confidence factor, and drops a factor that is not one of the three", () => {
  const stance = { seatId: "a", member: "Member A", option: "Ship", confidence: 75, reason: "Because.", weight: 1, factor: 0.75 as const };
  const record = {
    ...blankProposal("ship"),
    stances: [stance],
    tally: {
      consensus: false,
      total: 3.5,
      line: (3.5 * 2) / 3,
      options: [{ option: "Ship", weight: 2.25, share: 2.25 / 3.5 }],
      minority: [{ seatId: "a", member: "Member A", option: "Ship", confidence: 75, reason: "Because.", weight: 1 }],
      abstained: ["Member C"],
    },
  };
  const back = councilFromUnknown(JSON.parse(councilToJson(record)!));
  expect(back?.tally?.total).toBe(3.5);
  expect(back?.stances[0].factor).toBe(0.75);
  expect(councilToJson({ ...blankProposal("ship"), stances: [{ ...stance, factor: 2 }] })).toBeNull();
});
