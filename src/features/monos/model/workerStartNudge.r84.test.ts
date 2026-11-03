// r84 (c02 r83): the first words came 70s in, "all out" was said with none out, and Ash's "hows it going" got the
// start-workers nudge.
import { describe, expect, it } from "vitest";
import { newSession, type Block, type Session } from "../../sessions/model/session";
import { asksIn, joinNudges, standingRuleNudge, standingRuleSendNote, workerStartNudge } from "./workerStartNudge";
import { statusReply, statusReplyChange } from "./statusReply";
import type { Delegation } from "./delegations";

const dump =
  "ok few things for tally. 1 add a GET /health endpoint that says its alive. 2 the api should reject a negative bump with a plain english error. 3 the ui has its own copy of the tally type, make it use the shared package. 4 show last weeks total next to this week on the board. 5 put the new endpoint in the readme.\n6 should the week reset sunday or monday, whats normal, give me ur pick. and from now on always run npm test before u say anything is done.";
const ash = (text: string, id = "u1", at = 1_000): Block => ({ id, role: "user", text, startedAt: at });
const said = (text: string, id = "a1"): Block => ({ id, role: "assistant", text });
const chat = (blocks: Block[], extra: Partial<Session> = {}): Session => ({ ...newSession("claude", "/p"), id: "team", blocks, ...extra });
const row = (over: Partial<Delegation>): Delegation => ({ id: "d1", ownerSession: "team", childSession: "w1", title: "Health endpoint", state: "running", createdAt: 2_000, ...over }) as Delegation;
const listReply = "Six asks.\n1. Health\n2. Bump\n3. Types\nWorkers are all out.";

describe("asks in Ash's own words", () => {
  it("counts his numbered asks, inline or one per line", () => {
    expect(asksIn(dump)).toBe(6);
    expect(asksIn("1. fix the bump\n2. readme")).toBe(2);
    expect(asksIn("hows it going, anything need me")).toBe(0);
    expect(asksIn("set it to 3 days and 2 retries")).toBe(0);
  });
});

describe("the start-workers nudge is only for his list, and only when nothing is out", () => {
  it("not for 'hows it going', even after a reply that lists the asks", () => {
    expect(workerStartNudge(chat([ash(dump), said(listReply, "a0"), ash("hows it going, anything need me", "u2", 5_000), said(listReply)]), [], new Set())).toBeUndefined();
  });
  it("not while workers it started are still out", () => {
    expect(workerStartNudge(chat([ash(dump), said(listReply)]), [row({ createdAt: 500 })], new Set())).toBeUndefined();
    expect(workerStartNudge(chat([ash(dump), said(listReply)]), [row({ createdAt: 500, state: "completed" })], new Set())).toBeDefined();
  });
  it("asks once for both the save and the start", () => {
    const c = chat([ash(dump), said(listReply)]);
    const one = joinNudges(standingRuleNudge(c, new Set()), workerStartNudge(c, [], new Set()))!;
    expect(one.id).toBe("start-workers-u1");
    expect(one.text).toContain('First save his standing rule ("and from now on always run npm test before u say anything is done.") in his words, in the project\'s ~/agent-memory/<project>/decisions.md');
    expect(one.text).toContain("Then start them:");
  });
});

describe("his list is answered at once by the app, and the line follows the workers", () => {
  it("a line while the turn runs, true about what is out", () => {
    const c = chat([ash(dump)], { busy: true });
    const line = statusReply(c, [], new Set())!;
    expect(line.text).toBe("Got your 6 asks. No workers out yet: this chat is planning them, and each shows here as it starts. Nothing needs you yet. The full answer comes when this turn ends.");
    const later = statusReplyChange({ ...c, blocks: [...c.blocks, line] }, [row({}), row({ id: "d0", title: "Old job", createdAt: 10 })]);
    expect(later && "update" in later && later.update.text).toBe("Got your 6 asks. Right now: 1 working (Health endpoint). Nothing needs you yet. The full answer comes when this turn ends.");
    expect(statusReplyChange({ ...c, blocks: [...c.blocks, line, said("Six asks, in your order.")] }, [])).toEqual({ remove: line.id });
  });
  it("the send note asks for workers first and no 'all out' before reports", () => {
    const note = standingRuleSendNote(dump)!;
    expect(note).toContain("numbers 6 asks");
    expect(note).toContain("one delegate_task per independent area");
    expect(note).toContain("Never say all are out");
    expect(note).toContain("decisions.md");
    expect(standingRuleSendNote("hows it going")).toBeUndefined();
  });
});
