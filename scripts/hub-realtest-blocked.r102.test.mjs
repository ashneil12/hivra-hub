// r102 (6): a run blocked before Ash's question (Quit refused, a chat still running at the cap) is recorded as
// BLOCKED-BEFORE-QUESTION and counts neither way; the quit waits up to its cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockedGrade, BLOCKED_BEFORE_QUESTION } from "./hub-realtest-grade.mjs";
import { quitThenReopen } from "./hub-realtest-scenarios.mjs";

test("a blocked run is not graded PARTIAL", () => {
  const g = blockedGrade({ blockedBeforeQuestion: "a chat was still running after 900s" });
  assert.equal(g.grade, BLOCKED_BEFORE_QUESTION);
  assert.match(g.summary, /counts neither/);
  assert.equal(blockedGrade({}), null);
});

test("quit waits while chats run, then reports busy at the cap", async () => {
  let asked = 0;
  const act = async () => (asked++, { ok: false, busy: true, error: "1 chat(s) still running" });
  const r = await quitThenReopen({ act, pid: 1, alive: () => true, until: async () => false, launch: async () => ({}), idleMs: 40, everyMs: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.busy, true);
  assert.ok(asked >= 2, `asked ${asked} times`);
});

test("quit goes through once the chat finished within the cap", async () => {
  let asked = 0;
  const act = async () => (++asked < 3 ? { ok: false, busy: true, error: "busy" } : { ok: true });
  const r = await quitThenReopen({ act, pid: 1, alive: () => false, until: async (f) => f(), launch: async () => ({ pid: 2 }), idleMs: 1000, everyMs: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.pid, 2);
});
