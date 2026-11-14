// r78 (c02): "hows it going, anything need me" to a busy coding-team chat gets the app's line at once.
import { describe, expect, it } from "vitest";
import type { Block, Session } from "../../sessions/model/session";
import type { Delegation } from "./delegations";
import { isStatusQuestion, statusReply, statusReplyChange } from "./statusReply";

const chat = (blocks: Block[], over: Partial<Session> = {}): Session =>
  ({ id: "team-1", busy: true, blocks, ...over }) as unknown as Session;
const ash = (id: string, text: string): Block => ({ id, role: "user", text }) as Block;
const said = (text: string): Block => ({ id: `a-${text.length}`, role: "assistant", text }) as Block;
const row = (id: string, title: string, state: Delegation["state"], createdAt = 10): Delegation =>
  ({ id, title, state, ownerSession: "team-1", childSession: `c-${id}`, createdAt, updatedAt: createdAt }) as unknown as Delegation;

describe("status questions", () => {
  it("reads Ash's short check-ins, not new work", () => {
    for (const t of ["hows it going, anything need me", "how's it going?", "any update", "where are we", "done yet?"]) expect(isStatusQuestion(t)).toBe(true);
    for (const t of ["add a GET /health endpoint", "1 fix the bug\n2 how's it going", "[MonoCode report] status"]) expect(isStatusQuestion(t)).toBe(false);
  });
});

describe("statusReply", () => {
  const rows = [row("t1", "GET /health", "running"), row("t2", "Shared tally type", "completed"), row("t3", "README", "running")];

  it("a busy chat asked how it's going: who is working and who is back, at once", () => {
    const block = statusReply(chat([ash("u1", "do the list"), said("On it."), ash("u2", "hows it going, anything need me")]), rows, new Set(), 0, 100);
    expect(block?.id).toBe("status-reply-u2");
    expect(block?.text).toBe("Right now: 2 working (GET /health, README), 1 back (Shared tally type). Nothing needs you yet. The full answer comes when this turn ends.");
  });

  it("a question queued behind the turn counts; no workers yet says so", () => {
    const block = statusReply(chat([ash("u1", "do the list")], { queuedMessages: [{ id: "q1", text: "any update?", attachments: [] }] }), [], new Set());
    expect(block?.text).toMatch(/^No workers out yet/);
  });

  it("the turn's own text still being written after the question is not a reply (r80 c02)", () => {
    const writing = { ...said("All five are running"), streaming: true } as Block;
    expect(statusReply(chat([ash("u2", "hows it going, anything need me"), writing]), rows, new Set(), 0, 100)?.id).toBe("status-reply-u2");
  });

  it("never when the chat is idle, already answered, already noted, or the message is work", () => {
    const asked = [ash("u2", "how's it going?")];
    expect(statusReply(chat(asked, { busy: false }), rows, new Set())).toBeUndefined();
    expect(statusReply(chat([...asked, said("Two running.")]), rows, new Set())).toBeUndefined();
    expect(statusReply(chat(asked), rows, new Set(["status-reply-u2"]))).toBeUndefined();
    expect(statusReply(chat([ash("u3", "also add delete")]), rows, new Set())).toBeUndefined();
  });
});

describe("statusReplyChange (r80: nothing stale stays showing)", () => {
  const asked = [ash("u1", "do the list"), said("On it."), ash("u2", "hows it going, anything need me")];
  const first = statusReply(chat(asked), [row("t1", "GET /health", "running"), row("t2", "README", "running")], new Set(), 0, 100)!;

  it("follows the workers as they report back", () => {
    const later = [row("t1", "GET /health", "completed"), row("t2", "README", "running")];
    const change = statusReplyChange(chat([...asked, first]), later, 0, 200);
    expect(change && "update" in change && change.update.text).toBe("Right now: 1 working (README), 1 back (GET /health). Nothing needs you yet. The full answer comes when this turn ends.");
    expect(change && "update" in change && change.update.id).toBe(first.id);
  });

  it("says nothing when nothing changed", () => {
    expect(statusReplyChange(chat([...asked, first]), [row("t1", "GET /health", "running"), row("t2", "README", "running")], 0, 200)).toBeUndefined();
  });

  it("goes once the chat's own reply lands, or its turn ends", () => {
    expect(statusReplyChange(chat([...asked, first, said("Two of five are back; nothing needs you.")]), [], 0, 200)).toEqual({ remove: first.id });
    expect(statusReplyChange(chat([...asked, first], { busy: false }), [], 0, 200)).toEqual({ remove: first.id });
  });

  it("a tool step or a note after it is not the reply", () => {
    const tool = { id: "x", role: "assistant", text: "", tool: { title: "Bash" } } as unknown as Block;
    expect(statusReplyChange(chat([...asked, first, tool]), [], 0, 200)).not.toEqual({ remove: first.id });
  });
});

it("does not mistake work on a status control for a status question", () => {
  for (const text of ["Add a progress bar", "Fix the status badge", "Please update the progress display", "Can you build a status page?"]) expect(isStatusQuestion(text)).toBe(false);
  for (const text of ["status?", "Any progress?", "How is it going?", "Can you update me on progress?", "Please update me on the status", "Update us on the work"]) expect(isStatusQuestion(text)).toBe(true);
});
