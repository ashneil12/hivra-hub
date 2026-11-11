import { describe, expect, it, vi } from "vitest";
import { newSession, type Block, type QueuedMessage, type Session } from "./session";
import {
  approvalBlocksCarry,
  carryPastApproval,
  parksForApproval,
} from "./approvalCarry";
import { canDispatchQueuedHead, canSteerQueuedHead } from "./messageQueue";
import { deliverQueuedFollowUp } from "./queuedFollowUp";
import { followUpWhenBusy } from "./cantDo";
import { waitingOnYouLine } from "./approvalWait";
import { appendSteerUser, appendUser, applyHarnessEvent } from "../../../integrations/harness/core/apply";

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
    // The queued follow-up steers the running turn, and a message he sends now does not park either.
    expect(canSteerQueuedHead(session)).toBe(true);
    expect(parksForApproval(session)).toBe(false);
  });

  it("an old decided card is history, and so is an old record-less one", () => {
    expect(approvalBlocksCarry(chat([user("first"), tool("allow"), user("second")]))).toBe(false);
    // Nothing ever settles a card whose record never arrived, so one from before his last message is history.
    expect(approvalBlocksCarry(chat([user("first"), missingRecord, user("second")]))).toBe(false);
    expect(
      canSteerQueuedHead(chat([user("first"), missingRecord, user("second")])),
    ).toBe(true);
  });

  it("an open card that sits before his last message still holds (it is this turn's)", () => {
    // A card attaches to the tool block it belongs to, which can sit before a message he steered in.
    expect(approvalBlocksCarry(chat([user("first"), tool(), user("second")]))).toBe(true);
    expect(canSteerQueuedHead(chat([user("first"), tool(), user("second")]))).toBe(false);
  });

  it("a new open card after his last message still holds, whatever came before it", () => {
    const session = chat([user("first"), tool("deny", "old"), user("second"), tool(undefined, "new")]);
    expect(approvalBlocksCarry(session)).toBe(true);
    expect(canSteerQueuedHead(session)).toBe(false);
  });

  it("a saved draft is not a message he sent", () => {
    const session = chat([user("go"), missingRecord, user("half typed", { draft: true })]);
    expect(approvalBlocksCarry(session)).toBe(true);
  });

  it("a hidden note the app wrote is not a message he sent: it does not hide a record-less card", () => {
    const note = user("note from the room", { internal: true });
    expect(approvalBlocksCarry(chat([user("go"), missingRecord, note]))).toBe(true);
    expect(canSteerQueuedHead(chat([user("go"), missingRecord, note]))).toBe(false);
    // His own message after it still ends the stretch.
    expect(approvalBlocksCarry(chat([user("go"), missingRecord, note, user("next")]))).toBe(false);
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
    expect(parksForApproval(chat([user("old"), tool("allow"), user("new")]))).toBe(false);
    expect(parksForApproval(chat([user("old"), missingRecord, user("new")]))).toBe(false);
  });

  it("an old deny plus a new busy turn does not park", () => {
    const session = chat([user("first"), tool("deny"), user("second")]);
    expect(parksForApproval(session)).toBe(false);
  });

  it("leaves the background-tasks branch alone: with only background work left the agent reads it now", () => {
    const session = chat([user("go"), tool()], { backgroundTasks: ["dev server"] });
    expect(approvalBlocksCarry(session)).toBe(true);
    expect(parksForApproval(session)).toBe(false);
    expect(parksForApproval({ ...session, backgroundTasks: [] })).toBe(true);
  });

  it("a queued follow-up keeps the same precedence: background work steers it, no background work holds it", () => {
    const session = chat([user("go"), tool()], { backgroundTasks: ["dev server"] });
    expect(canSteerQueuedHead(session)).toBe(true);
    expect(canSteerQueuedHead({ ...session, backgroundTasks: [] })).toBe(false);
    // Background work alone changes nothing for a chat with no open card.
    expect(canSteerQueuedHead(chat([user("go")], { backgroundTasks: ["dev server"] }))).toBe(true);
    expect(canSteerQueuedHead(chat([user("go")], { backgroundTasks: [] }))).toBe(true);
  });
});

describe("an open card counts wherever it sits (WP-146)", () => {
  // A card attaches to the tool block it belongs to by call id, and that block can sit before Ash's last message.
  const started = (session: Session, callId: string, title: string): Session =>
    applyHarnessEvent(session, { type: "tool.started", callId, title, kind: "execute", status: "pending" });
  const asked = (session: Session, requestId: number, callId: string, title: string): Session =>
    applyHarnessEvent(session, { type: "approval.requested", requestId, callId, title, kind: "execute" });
  const withQueue = (session: Session): Session => ({
    ...session,
    turnReady: true,
    queuedMessages: [queued("next")],
    queueStatus: "active",
  });

  function expectHeld(session: Session, command: string) {
    expect(approvalBlocksCarry(session)).toBe(true);
    expect(parksForApproval(session)).toBe(true);
    expect(canSteerQueuedHead(withQueue(session))).toBe(false);
    expect(waitingOnYouLine(session.blocks)).toContain(command);
  }

  it("a permission request that arrives after Ash steers still holds", () => {
    let session = appendUser(newSession("claude", "/repo"), "write it");
    session = started(session, "w1", "Write a.ts");
    session = appendSteerUser(session, "and add a test");
    session = asked(session, 1, "w1", "Write a.ts");
    // The card sits before his last message.
    expect(session.blocks.map((block) => block.role)).toEqual(["user", "tool", "user"]);
    expectHeld(session, "Write a.ts");
  });

  it("the second card of a parallel batch attaches to its earlier block and still holds", () => {
    let session = appendUser(newSession("claude", "/repo"), "run both");
    session = started(session, "a", "Run npm test");
    session = started(session, "b", "Run npm build");
    session = asked(session, 1, "a", "Run npm test");
    session = applyHarnessEvent(session, { type: "approval.resolved", requestId: 1, decision: "allow" });
    session = appendSteerUser(session, "carry on");
    session = asked(session, 2, "b", "Run npm build");
    expectHeld(session, "npm build");
  });

  it("a steer through the background-tasks branch does not bury the card", () => {
    let session = appendUser(newSession("claude", "/repo"), "start it");
    session = started(session, "s1", "Run npm start");
    session = asked(session, 1, "s1", "Run npm start");
    const withBackground = { ...session, backgroundTasks: ["dev server"] };
    // Only background work is left: the message goes in now, as before.
    expect(parksForApproval(withBackground)).toBe(false);
    session = appendSteerUser(withBackground, "how is it going");
    // Once the background work is gone the card is still open.
    session = { ...session, backgroundTasks: [] };
    expect(session.blocks.map((block) => block.role)).toEqual(["user", "tool", "user"]);
    expectHeld(session, "npm start");
  });

  it("a card from an earlier turn is settled when the next turn starts, so it never haunts", () => {
    let session = appendUser(newSession("claude", "/repo"), "run it");
    session = started(session, "a", "Run npm test");
    session = asked(session, 1, "a", "Run npm test");
    session = appendUser({ ...session, busy: false }, "never mind");
    expect(approvalBlocksCarry(session)).toBe(false);
    expect(parksForApproval(session)).toBe(false);
    expect(waitingOnYouLine(session.blocks)).toBeNull();
  });
});

describe("a queued message is never queued twice behind an open card (WP-146)", () => {
  it("already queued and parked stays; a new one is queued", () => {
    const base = {
      setting: "steer" as const,
      onlyBackgroundWork: false,
      mono: false,
      steerable: true,
      cannotRedirect: false,
      compacting: false,
    };
    expect(followUpWhenBusy({ ...base, mustWait: true, alreadyQueued: true })).toBe("stay");
    expect(followUpWhenBusy({ ...base, mustWait: true, alreadyQueued: false })).toBe("queue");
    // The background-tasks branch still hands a queued message over when nothing parks it.
    expect(followUpWhenBusy({ ...base, mustWait: false, onlyBackgroundWork: true, alreadyQueued: true })).toBe("steer");
  });
});
