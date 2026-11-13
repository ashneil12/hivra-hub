import { describe, expect, it } from "vitest";
import { aboutProject, earlierChatIds, isOneChat, isOneChatMono, oneChatId, oneChatMonoId } from "./oneChat";

const monos = [
  { id: "lead", name: "EXO lead", sessionId: "chat-lead", chats: ["chat-lead-2"] },
  { id: "chief", name: "Chief of Staff", everyProject: true, sessionId: "chat-chief", chats: ["chat-old", "chat-old", "chat-chief", ""] },
];

describe("one chat", () => {
  it("is the Chief of Staff's main chat, and nobody else's", () => {
    expect(oneChatMonoId(monos, true)).toBe("chief");
    expect(oneChatId(monos, true)).toBe("chat-chief");
    expect(isOneChatMono("chief", monos, true)).toBe(true);
    expect(isOneChatMono("lead", monos, true)).toBe(false);
    expect(isOneChat("chat-chief", monos, true)).toBe(true);
    // A chat it had before is still its chat, but it is not the one chat.
    expect(isOneChat("chat-old", monos, true)).toBe(false);
    expect(isOneChat("chat-lead", monos, true)).toBe(false);
    expect(isOneChat(null, monos, true)).toBe(false);
  });

  it("is off outside Dropwave, and with no Chief of Staff", () => {
    expect(oneChatMonoId(monos, false)).toBeUndefined();
    expect(isOneChat("chat-chief", monos, false)).toBe(false);
    expect(isOneChatMono("chief", monos, false)).toBe(false);
    expect(oneChatId([monos[0]], true)).toBeUndefined();
    expect(earlierChatIds([monos[0]], true)).toEqual([]);
  });

  it("has no one chat until the Chief of Staff's chat exists", () => {
    expect(oneChatId([{ id: "chief", name: "Chief of Staff", everyProject: true }], true)).toBeUndefined();
    expect(isOneChatMono("chief", [{ id: "chief", name: "Chief of Staff", everyProject: true }], true)).toBe(true);
  });

  it("keeps the side chats it had before, each once, never the one chat itself", () => {
    expect(earlierChatIds(monos, true)).toEqual(["chat-old"]);
    expect(earlierChatIds(monos, false)).toEqual([]);
  });

  it("names the project in front of a message sent from that project's home", () => {
    expect(aboutProject("  is the arena lit yet?  ", "EXO")).toBe("About EXO: is the arena lit yet?");
    expect(aboutProject("About exo: is the arena lit yet?", "EXO")).toBe("About exo: is the arena lit yet?");
    expect(aboutProject("what is left?", undefined)).toBe("what is left?");
    expect(aboutProject("   ", "EXO")).toBe("");
  });
});
