import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
}));
import { copyBlocks, newMoveId } from "./teleportLocal";
import { planFromSession } from "./teleportMove";
import { recapChatFrom } from "./teleportRecap";
import { moveResultMessage } from "../ui/teleportCopy";
import type { Session } from "../../sessions/model/session";
import { deliverQueuedFollowUp } from "../../sessions/model/queuedFollowUp";
import { lockChat, unlockChat } from "./teleportLock";

describe("WP-177 round 2", () => {
  it("a copy drops a Lead, a path and an app request, and keeps tool output", () => {
    const blocks = copyBlocks(
      JSON.stringify([
        {
          id: "u1",
          role: "user",
          text: "hi",
          orchestrationLeadId: "lead-1",
          internal: true,
          appRequestId: "req-1",
          monoNote: { kind: "room", from: "x" },
          attachments: [{ path: "/Users/ash/secret.txt" }],
        },
        { id: "t1", role: "tool", text: "", tool: { detail: "x".repeat(600), paths: ["/tmp/a"], title: "Read" } },
      ]),
    );
    expect(blocks[0]).not.toHaveProperty("orchestrationLeadId");
    expect(blocks[0]).not.toHaveProperty("attachments");
    expect(blocks[0]).not.toHaveProperty("appRequestId");
    expect(blocks[0]).not.toHaveProperty("monoNote");
    expect(blocks[1].tool?.detail).toHaveLength(600);
    expect(blocks[1].tool).not.toHaveProperty("paths");
  });

  it("a move id is not the clock", () => {
    expect(newMoveId()).not.toMatch(/^move-\d+$/);
  });

  it("a partial move back says this Mac has the chat", () => {
    expect(moveResultMessage({ status: "partial" }, "back")).toContain("This Mac has the chat");
    expect(moveResultMessage({ status: "partial" }, "out")).toContain("The host has the chat");
  });

  it("a recap starts clean and queues the brief for the model", () => {
    const next = recapChatFrom({
      id: "old",
      harness: "claude",
      model: "m",
      modelSettings: { effort: "low" },
      runtimeMode: "default",
      title: "Parser",
      cwd: "/projects/parser",
      orchestrationLeadId: "lead-9",
      automationId: "auto-1",
      blocks: [
        { id: "b1", role: "user", text: "Please fix the parser" },
        { id: "b2", role: "assistant", text: "Fixed the tokenizer edge case" },
      ],
    } as unknown as Session);
    expect(next.orchestrationLeadId).toBeUndefined();
    expect(next.automationId).toBeUndefined();
    expect(next.blocks[0].text).toContain("Please fix the parser");
    expect(next.queuedMessages?.[0]?.text).toBe(next.blocks[0].text);
  });

  it("a Lead chat is not planned for a move", async () => {
    const session = {
      id: "lead-chat",
      harness: "claude",
      model: "m",
      modelSettings: {},
      runtimeMode: "default",
      title: "Lead",
      cwd: "/tmp",
      orchestrationLeadId: "someone",
      blocks: [{ id: "u", role: "user", text: "go" }],
    } as unknown as Session;
    const planned = await planFromSession(session, "this-mac", "host-a");
    expect(planned.ok).toBe(false);
  });

  it("a queued turn does not run while the chat is frozen", async () => {
    lockChat("chat-frozen");
    let steered = false;
    const message = { id: "q1", text: "still going", attachments: [] };
    const ran = await deliverQueuedFollowUp({
      message,
      current: () =>
        ({
          id: "chat-frozen",
          queuedMessages: [message],
          blocks: [],
          busy: true,
          turnReady: true,
        }) as unknown as Session,
      isCurrentTurn: () => true,
      prepare: async () => undefined,
      steer: async () => {
        steered = true;
      },
      delivered: () => undefined,
      deferred: () => undefined,
      failed: () => undefined,
    });
    unlockChat("chat-frozen");
    expect(ran).toBe(false);
    expect(steered).toBe(false);
  });
});
