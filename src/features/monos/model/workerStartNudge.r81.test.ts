// r81 (c02 r80): "Five workers start now" stood with none started, and "always run npm test" was saved 3 minutes late.
import { describe, expect, it } from "vitest";
import { newSession, type Block, type Session } from "../../sessions/model/session";
import { notStartedNote, SAVE_RULE_PREFIX, standingRuleNudge, workerStartNudge } from "./workerStartNudge";

const ash = (text: string, id = "u1"): Block => ({ id, role: "user", text, startedAt: 1_000 });
const said = (text: string): Block => ({ id: `a-${text.length}`, role: "assistant", text });
const remember: Block = { id: "t9", role: "tool", text: "", tool: { kind: "mcp__ashos__ash_remember", title: "mcp__ashos__ash_remember", status: "completed" } };
const chat = (blocks: Block[], extra: Partial<Session> = {}): Session => ({ ...newSession("claude", "/p"), id: "team", blocks, ...extra });
const dump = "ok few things for tally. 1 add a GET /health. 2 reject a negative bump. from now on always run npm test before you call something done";

it("a claim that workers started, with none started, gets a true line beside the app's nudge", () => {
  const nudge = workerStartNudge(chat([ash(dump), said("Six asks.\n1. Health\n2. Bump\n3. Types\nFive workers start now.")]), [], new Set())!;
  const note = notStartedNote(nudge);
  expect(note.id).toBe("not-started-u1");
  expect(note.role).toBe("system");
  expect(note.text).toMatch(/^No worker had started when that reply was written/);
});

it("a standing rule not saved once the turn is over: one app message to save it in his words", () => {
  const nudge = standingRuleNudge(chat([ash(dump), said("Five jobs. The npm test rule is saved after the handoff.")]), new Set());
  expect(nudge?.id).toBe("save-rule-u1");
  expect(nudge?.text.startsWith(SAVE_RULE_PREFIX)).toBe(true);
  expect(nudge?.text).toContain("from now on always run npm test before you call something done");
  expect(nudge?.text).toContain("ash_remember");
});

it("not when it was saved, while it works, once nudged, before it replied, or with no rule in his words", () => {
  const replied = [ash(dump), said("Five jobs.")];
  expect(standingRuleNudge(chat([...replied, remember]), new Set())).toBeUndefined();
  expect(standingRuleNudge(chat(replied, { busy: true }), new Set())).toBeUndefined();
  expect(standingRuleNudge(chat(replied), new Set(["u1"]))).toBeUndefined();
  expect(standingRuleNudge(chat([ash(dump)]), new Set())).toBeUndefined();
  expect(standingRuleNudge(chat([ash("the board always shows this week"), said("Got it.")]), new Set())).toBeUndefined();
});

describe("r83: the standing rule goes out flagged with Ash's message", () => {
  it("flags his rule so the first turn saves it, and nothing else", async () => {
    const { standingRuleSendNote } = await import("./workerStartNudge");
    const note = standingRuleSendNote("fix the board. from now on always run npm test before u say anything is done");
    expect(note).toContain("ash_remember");
    expect(note).toContain("from now on always run npm test");
    expect(standingRuleSendNote("fix the board and the readme")).toBeUndefined();
    expect(standingRuleSendNote("[MonoCode save rule] from now on always run npm test")).toBeUndefined();
  });
});
