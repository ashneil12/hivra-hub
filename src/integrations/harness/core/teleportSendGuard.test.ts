import { describe, expect, it } from "vitest";
import { lockChat, unlockChat } from "../../../features/connections/model/teleportLock";
import { compactHarnessContext, rewindHarnessLastTurn, sendHarnessTurn, steerHarnessTurn } from "./registry";

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

describe("WP-177 LOW I: rewind and steer refuse a locked chat too", () => {
  it("rewindHarnessLastTurn does not roll back a moved chat's provider thread", async () => {
    lockChat("chat-rewind-locked");
    await expect(
      rewindHarnessLastTurn({ sessionId: "chat-rewind-locked", harness: "codex", cwd: "/tmp/x" } as never),
    ).rejects.toThrow(/Nothing was sent/);
    unlockChat("chat-rewind-locked");
  });

  it("steerHarnessTurn does not inject into a moved chat", async () => {
    lockChat("chat-steer-locked");
    await expect(steerHarnessTurn({ sessionId: "chat-steer-locked", harness: "codex", text: "x" } as never)).rejects.toThrow(
      /Nothing was sent/,
    );
    unlockChat("chat-steer-locked");
  });
});
