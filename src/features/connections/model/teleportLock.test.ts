import { describe, expect, it } from "vitest";
import { assertChatAcceptsTurns, isChatLocked, lockChat, unlockChat } from "./teleportLock";

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

describe("WP-177 the lock follows the saved chat, so a restart keeps it", () => {
  it("a saved moved chat locks itself when it is read back", async () => {
    const { syncTeleportLock } = await import("./teleportLock");
    const moved = {
      id: "chat-restart",
      blocks: [{ id: "teleported-x", role: "system", text: "Moved to Studio box", notice: "teleported", startedAt: 1 }],
    } as never;
    syncTeleportLock(moved);
    expect(() => assertChatAcceptsTurns("chat-restart")).toThrow(/Nothing was sent/);
  });

  it("a saved chat frozen by a move that never finished locks too, and only a settle unlocks it", async () => {
    const { syncTeleportLock } = await import("./teleportLock");
    syncTeleportLock({ id: "chat-frozen", blocks: [{ id: "teleport-frozen-m9", role: "system", text: "", notice: "teleport-frozen" }] } as never);
    expect(isChatLocked("chat-frozen")).toBe(true);
    // H1: a render sync never unlocks: the lock is released only by the move's own steps.
    syncTeleportLock({ id: "chat-frozen", blocks: [] } as never);
    expect(isChatLocked("chat-frozen")).toBe(true);
    const { settleTeleportLock } = await import("./teleportLock");
    settleTeleportLock({ id: "chat-frozen", blocks: [] } as never);
    expect(isChatLocked("chat-frozen")).toBe(false);
  });
});
