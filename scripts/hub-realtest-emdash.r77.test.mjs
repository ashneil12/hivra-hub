// r77: the em dash check reads what the app saved (sealed blocks, cleaned by withoutEmDashes), not the raw stream.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runChecks, savedChatTexts } from "./hub-realtest-scenarios.mjs";

const texts = [
  { session: "lead", who: "tally-lead", text: "Done — tests pass." },
  { session: "w1", who: "worker of tally-lead", text: "raw — worker" },
];

test("saved text is read for em dashes, the stream only when nothing was saved", async () => {
  const blocks = {
    lead: [
      { role: "user", text: "go — now", startedAt: 5 },
      { role: "assistant", text: "Done: tests pass.", startedAt: 10 },
      { role: "assistant", text: "older — line", startedAt: 1 },
    ],
  };
  const saved = await savedChatTexts({ sessionBlocks: async (id) => blocks[id] ?? [] }, texts, 5);
  assert.deepEqual(saved, [{ who: "tally-lead", session: "lead", text: "Done: tests pass." }]);
  const base = { room: [], events: [], memoryCalls: [] };
  assert.equal(runChecks({}, { ...base, texts, saved }).emDashes.count, 0);
  assert.equal(runChecks({}, { ...base, texts, saved }).emDashes.read, "saved");
  assert.equal(runChecks({}, { ...base, texts }).emDashes.count, 1);
  const withDash = await savedChatTexts({ sessionBlocks: async () => [{ role: "assistant", text: "Kept — this one", startedAt: 9 }] }, texts, 5);
  assert.equal(runChecks({}, { ...base, texts, saved: withDash }).emDashes.count, 1);
});
