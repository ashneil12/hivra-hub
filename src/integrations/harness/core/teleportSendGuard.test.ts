import { describe, expect, it } from "vitest";
import { lockChat, unlockChat } from "../../../features/connections/model/teleportLock";
import { compactHarnessContext, sendHarnessTurn } from "./registry";

describe("WP-177 the send and compact paths refuse a locked chat before anything is sent", () => {
  it("sendHarnessTurn rejects for a moved or frozen chat, and the message says nothing was sent", async () => {
    lockChat("chat-send-locked");
    await expect(
      sendHarnessTurn({ sessionId: "chat-send-locked", harness: "claude", text: "hi", cwd: "/tmp/x" } as never),
    ).rejects.toThrow(/Nothing was sent/);
    unlockChat("chat-send-locked");
  });

  it("compactHarnessContext rejects for a locked chat", async () => {
    lockChat("chat-compact-locked");
    await expect(
      compactHarnessContext({ sessionId: "chat-compact-locked", harness: "claude", cwd: "/tmp/x" } as never),
    ).rejects.toThrow(/Nothing was sent/);
    unlockChat("chat-compact-locked");
  });
});
