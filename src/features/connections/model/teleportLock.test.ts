import { describe, expect, it } from "vitest";
import { assertChatAcceptsTurns, lockChat, unlockChat } from "./teleportLock";

describe("WP-177 send lock on a moving or moved chat", () => {
  it("a chat that is not locked takes a turn", () => {
    expect(() => assertChatAcceptsTurns("chat-free")).not.toThrow();
  });

  it("a locked chat refuses the turn before anything is sent, and says so", () => {
    lockChat("chat-lock");
    expect(() => assertChatAcceptsTurns("chat-lock")).toThrow(/Nothing was sent/);
    unlockChat("chat-lock");
    expect(() => assertChatAcceptsTurns("chat-lock")).not.toThrow();
  });

  it("locks are per chat", () => {
    lockChat("chat-a");
    expect(() => assertChatAcceptsTurns("chat-b")).not.toThrow();
    unlockChat("chat-a");
  });
});
