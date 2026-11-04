// @vitest-environment happy-dom
// r63 (Critiquito): when the Lead had just answered, Chief of Staff posted a near-copy of its answer. The room rule is
// "add something new or stay quiet", and a near-copy of another Mono's post since Ash last wrote never lands.
import { beforeEach, expect, it, vi } from "vitest";
import type { RoomTurnRequest } from "./roomConductor";
import { repeatsAnother } from "./roomTurns";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:hub-team-pack", "ash");
  vi.resetModules();
});

const LEAD = "The sitemap is live on Canary: 412 URLs, all 200, and I've asked Google to recrawl it. Nothing needs you.";

it("a reply that rewords another Mono's answer is a repeat; one that adds from its own lane is not", () => {
  expect(repeatsAnother("Sitemap's live on Canary, 412 URLs, all 200; I've asked Google to recrawl. Nothing needs you.", [LEAD])).toBe(true);
  expect(repeatsAnother("Good. That unblocks the launch post: I'll put it on Thursday's plan and tell PM to move the billing card.", [LEAD])).toBe(false);
  expect(repeatsAnother("Done.", [LEAD])).toBe(false);
  expect(repeatsAnother(LEAD, [])).toBe(false);
});

it("every room turn carries the rule", async () => {
  const { ROOM_RULES } = await import("./teamSouls");
  // r64: the rule is about silence, not about announcing it.
  expect(ROOM_RULES).toContain("Silence is the default once another Mono (a Lead included) has answered");
  expect(ROOM_RULES).toMatch(/never repeat or reword its answer/);
  expect(ROOM_RULES).not.toContain("stay quiet");
});

it("in the room, the near-copy stays out and the seat with something new posts", async () => {
  const team = await import("./builtInMonos");
  team.ensureBuiltInMonos();
  const chat = await import("./hubChats");
  const c = chat.createChat("hub", "Leadership team", ["ada", "bo", "cam"]);
  const replies: Record<string, string> = {
    "ada": LEAD,
    "bo": "The sitemap is live on Canary with 412 URLs, all 200, and Google was asked to recrawl it. Nothing needs you.",
    cam: "One thing from me: the Canary robots.txt still blocks /blog, so the recrawl will skip those pages.",
  };
  const prompts: RoomTurnRequest[] = [];
  chat.setGroupChatRunner({
    run: async (request: RoomTurnRequest) => {
      prompts.push(request);
      await new Promise((r) => setTimeout(r, 1));
      return { kind: "reply", text: replies[request.monoId] ?? "NO_REPLY" };
    },
    stop: () => undefined,
  });
  const conv = chat.startConversation(c.id, "is the canary sitemap sorted?");
  await chat.requestReply(c.id, conv);
  const msgs = chat.getChat(c.id)!.conversations.find((x) => x.id === conv)!.messages;
  const posted = msgs.filter((m) => m.from !== "ash" && m.from !== "app").map((m) => m.from);
  expect(posted).toContain("ada");
  expect(posted).toContain("cam");
  expect(posted).not.toContain("bo");
  expect(msgs.every((m) => !/NO_REPLY/.test(m.text))).toBe(true);
  expect(prompts.every((p) => p.prompt.includes("Silence is the default"))).toBe(true);
});
