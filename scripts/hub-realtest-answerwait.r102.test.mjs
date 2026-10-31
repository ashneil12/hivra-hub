// r102: a reply to an Inbox pick is not taken as the answer to Ash's next question.
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteAnswerSent, replySince } from "./hub-realtest-scenarios.mjs";

test("answering a pick moves the Mono's reply wait to the answer", () => {
  const sent = new Map([["tally-lead", 1000]]);
  const resolve = (m) => (m === "lead" ? "tally-lead" : m);
  noteAnswerSent(sent, { mono: "lead", row: 0 }, resolve, 5000);
  assert.equal(replySince(sent, "tally-lead", 0), 5000);
  // An old reply (finished at 3000, before the pick) can no longer meet the wait.
  const replies = [{ at: 3000, result: true }];
  assert.equal(replies.some((r) => r.at >= replySince(sent, "tally-lead", 0) && r.result), false);
});

test("answering by session moves that session's wait; nothing sent falls back to the step start", () => {
  const sent = new Map();
  noteAnswerSent(sent, { session: "s1" }, (m) => m, 7000);
  assert.equal(replySince(sent, "s1", 1), 7000);
  assert.equal(replySince(sent, "other", 42), 42);
});
