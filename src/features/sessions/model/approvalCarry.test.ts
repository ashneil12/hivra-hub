import { describe, expect, it } from "vitest";
import { newSession, type Block, type Session } from "./session";
import {
  approvalBlocksCarry,
  carryPastApproval,
  pendingApprovalBlocks,
} from "./approvalCarry";
import { canDispatchQueuedHead, canSteerQueuedHead } from "./messageQueue";
import type { QueuedMessage } from "./session";

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

function tool(decided?: "allow" | "deny" | "cancelled"): Block {
  return {
    id: "tool",
    role: "tool",
    text: "Run tests",
    tool: { title: "Bash", command: "npm test" },
    approval: decided ? { requestId: 1, decided } : { requestId: 1 },
  };
}

describe("carryPastApproval (WP-146)", () => {
  it("leaves the session waiting while an approval is pending", () => {
    expect(carryPastApproval({ decided: undefined })).toBe("wait");
    expect(carryPastApproval({ decided: undefined }, true)).toBe("wait");
    expect(approvalBlocksCarry(chat([tool()]))).toBe(true);
    expect(approvalBlocksCarry(chat([tool()]), true)).toBe(true);
    expect(canSteerQueuedHead(chat([tool()]))).toBe(false);
  });

  it("still waits when an earlier approval is open behind a later allow", () => {
    const session = chat([tool(), tool("allow")]);
    expect(approvalBlocksCarry(session)).toBe(true);
    expect(approvalBlocksCarry(session, true)).toBe(true);
    expect(canSteerQueuedHead(session)).toBe(false);
  });

  it("does not continue on a denial unless that continue is its own explicit step", () => {
    expect(carryPastApproval({ decided: "deny" })).toBe("wait");
    expect(carryPastApproval({ decided: "deny" }, true)).toBe("continue");
    expect(approvalBlocksCarry(chat([tool("deny")]))).toBe(true);
    expect(approvalBlocksCarry(chat([tool("deny")]), true)).toBe(false);
    expect(canSteerQueuedHead(chat([tool("deny")]))).toBe(false);
  });

  it("continues once the approval was allowed", () => {
    expect(carryPastApproval({ decided: "allow" })).toBe("continue");
    expect(approvalBlocksCarry(chat([tool("allow")]))).toBe(false);
    expect(canSteerQueuedHead(chat([tool("allow")]))).toBe(true);
  });

  it("fails closed when the approval record is missing", () => {
    expect(carryPastApproval(null)).toBe("wait");
    expect(carryPastApproval(null, true)).toBe("wait");
    const missing = chat([{ id: "ask", role: "approval", text: "Run tests" }]);
    expect(approvalBlocksCarry(missing)).toBe(true);
    expect(approvalBlocksCarry(missing, true)).toBe(true);
    expect(canSteerQueuedHead(missing)).toBe(false);
    expect(pendingApprovalBlocks(missing)).toBe(true);
    const hidden = chat([
      { id: "ask", role: "approval", text: "Run tests" },
      tool("allow"),
    ]);
    expect(approvalBlocksCarry(hidden, true)).toBe(true);
    expect(canSteerQueuedHead(hidden)).toBe(false);
  });

  it("continues after a denial once a later approval was allowed", () => {
    const session = chat([tool("deny"), tool("allow")]);
    expect(approvalBlocksCarry(session)).toBe(false);
    expect(canSteerQueuedHead(session)).toBe(true);
  });

  it("does not treat a finished turn's old card as still open", () => {
    const idle = chat([tool()], { busy: false });
    expect(approvalBlocksCarry(idle)).toBe(false);
    expect(canDispatchQueuedHead(idle)).toBe(true);
  });

  it("still sends a follow-up when nothing is waiting on approval", () => {
    const plain = chat([{ id: "u", role: "user", text: "go on" }]);
    expect(approvalBlocksCarry(plain)).toBe(false);
    expect(canSteerQueuedHead(plain)).toBe(true);
  });
});
