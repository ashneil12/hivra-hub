import { describe, expect, it, vi } from "vitest";
import { newSession, type Block, type QueuedMessage, type Session } from "./session";
import {
  approvalBlocksCarry,
  carryPastApproval,
  parksForApproval,
  pendingApprovalBlocks,
} from "./approvalCarry";
import { canDispatchQueuedHead, canSteerQueuedHead } from "./messageQueue";
import { deliverQueuedFollowUp } from "./queuedFollowUp";

const queued = (id: string): QueuedMessage => ({ id, text: id, attachments: [] });

function chat(blocks: Block[], patch: Partial<Session> = {}): Session {
  return {
    ...newSession("claude", "/tmp/project"),
    busy: true,
    turnReady: true,
    queuedMessages: [queued("next")],
    queueStatus: "active",
    blocks,
    ...patch,
  };
}

function tool(decided?: "allow" | "deny" | "cancelled", id = "tool"): Block {
  return {
    id,
    role: "tool",
    text: "Run tests",
    tool: { title: "Bash", command: "npm test" },
    approval: decided ? { requestId: 1, decided } : { requestId: 1 },
  };
}

const user = (id: string, patch: Partial<Block> = {}): Block => ({
  id,
  role: "user",
  text: id,
  ...patch,
});

const missingRecord: Block = { id: "ask", role: "approval", text: "Run tests" };

describe("carryPastApproval (WP-146)", () => {
  it("leaves the session waiting while an approval is pending", () => {
    expect(carryPastApproval({ decided: undefined })).toBe("wait");
    expect(approvalBlocksCarry(chat([user("go"), tool()]))).toBe(true);
    expect(canSteerQueuedHead(chat([user("go"), tool()]))).toBe(false);
  });

  it("still waits when an earlier approval is open behind a later allow", () => {
    const session = chat([user("go"), tool(undefined, "a"), tool("allow", "b")]);
    expect(approvalBlocksCarry(session)).toBe(true);
    expect(canSteerQueuedHead(session)).toBe(false);
  });

  it("continues once the approval was allowed", () => {
    expect(carryPastApproval({ decided: "allow" })).toBe("continue");
    expect(approvalBlocksCarry(chat([user("go"), tool("allow")]))).toBe(false);
    expect(canSteerQueuedHead(chat([user("go"), tool("allow")]))).toBe(true);
  });

  it("does not hold a message on a denial: the turn goes on without that call", () => {
    expect(carryPastApproval({ decided: "deny" })).toBe("continue");
    expect(carryPastApproval({ decided: "cancelled" })).toBe("continue");
    const denied = chat([user("go"), tool("deny")]);
    expect(approvalBlocksCarry(denied)).toBe(false);
    expect(canSteerQueuedHead(denied)).toBe(true);
  });

  it("fails closed when the approval record is missing", () => {
    expect(carryPastApproval(null)).toBe("wait");
    const missing = chat([user("go"), missingRecord]);
    expect(approvalBlocksCarry(missing)).toBe(true);
    expect(canSteerQueuedHead(missing)).toBe(false);
    expect(pendingApprovalBlocks(missing)).toBe(true);
    const hidden = chat([user("go"), missingRecord, tool("allow")]);
    expect(approvalBlocksCarry(hidden)).toBe(true);
    expect(canSteerQueuedHead(hidden)).toBe(false);
  });

  it("does not treat a finished turn's old card as still open", () => {
    const idle = chat([user("go"), tool()], { busy: false });
    expect(approvalBlocksCarry(idle)).toBe(false);
    expect(canDispatchQueuedHead(idle)).toBe(true);
  });

  it("still sends a follow-up when nothing is waiting on approval", () => {
    const plain = chat([user("go on")]);
    expect(approvalBlocksCarry(plain)).toBe(false);
    expect(canSteerQueuedHead(plain)).toBe(true);
  });
});

describe("only approvals after Ash's last message count (WP-146)", () => {
  it("an old deny plus a new busy turn still steers", () => {
    const session = chat([
      user("first"),
      tool("deny"),
      { id: "a1", role: "assistant", text: "Understood, skipping that." },
      user("second"),
      { id: "a2", role: "assistant", text: "Working on it." },
    ]);
    expect(approvalBlocksCarry(session)).toBe(false);
    expect(canSteerQueuedHead(session)).toBe(true);
  });

  it("an old open card before his last message is history, not a hold", () => {
    expect(approvalBlocksCarry(chat([user("first"), tool(), user("second")]))).toBe(false);
    expect(
      canSteerQueuedHead(chat([user("first"), missingRecord, user("second")])),
    ).toBe(true);
  });

  it("a new open card after his last message still holds, whatever came before it", () => {
    const session = chat([user("first"), tool("deny", "old"), user("second"), tool(undefined, "new")]);
    expect(approvalBlocksCarry(session)).toBe(true);
    expect(canSteerQueuedHead(session)).toBe(false);
  });

  it("a saved draft is not a message he sent", () => {
    const session = chat([user("go"), tool(), user("half typed", { draft: true })]);
    expect(approvalBlocksCarry(session)).toBe(true);
  });

  it("holds when the chat has no message of his at all", () => {
    expect(approvalBlocksCarry(chat([tool()]))).toBe(true);
    expect(approvalBlocksCarry(chat([missingRecord]))).toBe(true);
    expect(approvalBlocksCarry(chat([tool("deny")]))).toBe(false);
  });

  it("delivers a queued follow-up on a turn that only has an old deny behind it", async () => {
    const session = chat([user("first"), tool("deny"), user("second")]);
    const message = session.queuedMessages![0]!;
    const steer = vi.fn(async () => {});
    const delivered = vi.fn();
    const sent = await deliverQueuedFollowUp({
      message,
      current: () => session,
      isCurrentTurn: () => true,
      prepare: async () => message.text,
      steer,
      delivered,
      deferred: vi.fn(),
      failed: vi.fn(),
    });
    expect(sent).toBe(true);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  it("does not deliver a queued follow-up while a new card is open, and delivers it once decided", async () => {
    let session = chat([user("first"), tool()]);
    const message = session.queuedMessages![0]!;
    const steer = vi.fn(async () => {});
    const attempt = () =>
      deliverQueuedFollowUp({
        message,
        current: () => session,
        isCurrentTurn: () => true,
        prepare: async () => message.text,
        steer,
        delivered: vi.fn(),
        deferred: vi.fn(),
        failed: vi.fn(),
      });
    expect(await attempt()).toBe(false);
    expect(steer).not.toHaveBeenCalled();
    session = { ...session, blocks: [user("first"), tool("deny")] };
    expect(await attempt()).toBe(true);
    expect(steer).toHaveBeenCalledTimes(1);
  });
});

describe("parksForApproval: the send path's question (WP-146)", () => {
  it("parks a new message behind an open card", () => {
    expect(parksForApproval(chat([user("go"), tool()]))).toBe(true);
    expect(parksForApproval(chat([user("go"), missingRecord]))).toBe(true);
  });

  it("does not park for a deny, an allow or an old card", () => {
    expect(parksForApproval(chat([user("go"), tool("deny")]))).toBe(false);
    expect(parksForApproval(chat([user("go"), tool("allow")]))).toBe(false);
    expect(parksForApproval(chat([user("old"), tool(), user("new")]))).toBe(false);
  });

  it("leaves the background-tasks branch alone: with only background work left the agent reads it now", () => {
    const session = chat([user("go"), tool()], { backgroundTasks: ["dev server"] });
    expect(approvalBlocksCarry(session)).toBe(true);
    expect(parksForApproval(session)).toBe(false);
    expect(parksForApproval({ ...session, backgroundTasks: [] })).toBe(true);
  });
});
