// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { ensureLeadership, autoTitle, getChat, renameConversation, sendMessage, startConversation } from "./hubChats";

ensureLeadership("qa");
it("a new conversation is made only when the first message is sent, and names itself from it", () => {
  const before = getChat("qa:leadership")!.conversations.length;
  const id = startConversation("qa:leadership", "Can we move level 3 to next week please, and keep the boss fight?");
  const chat = getChat("qa:leadership")!;
  expect(chat.conversations.length).toBe(before + 1);
  expect(chat.conversations[0]).toMatchObject({ id, title: autoTitle("Can we move level 3 to next week please, and keep the boss fight?") });
});

it("a renamed conversation keeps its name", () => {
  const id = startConversation("qa:leadership", "first");
  renameConversation("qa:leadership", id, "Level 3 plan");
  sendMessage("qa:leadership", "more", id);
  expect(getChat("qa:leadership")!.conversations.find((c) => c.id === id)).toMatchObject({ title: "Level 3 plan", named: true });
  renameConversation("qa:leadership", id, "   ");
  expect(getChat("qa:leadership")!.conversations.find((c) => c.id === id)!.title).toBe("Level 3 plan");
});

it("auto titles cut at a word", () => {
  expect(autoTitle("short")).toBe("short");
  expect(autoTitle("one\ntwo")).toBe("one");
});
