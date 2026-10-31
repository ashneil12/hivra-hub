// r100: B5 reports list every ask by number with its state, and label transcript-only repeats.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { askLedger, asksSection, renderedVsRaw } from "./hub-realtest-asks.mjs";

const scenario = JSON.parse(fs.readFileSync(new URL("../tests/realtest/scenarios/b5-restart-blind.json", import.meta.url), "utf8"))
  .scenarios.find((s) => s.id === "b5-dump-restart-blind");

test("the B5 scenario holds exactly 40 asks, each findable in what Ash sent", () => {
  assert.equal(scenario.asks.length, 40);
  const sent = JSON.stringify(scenario.steps ?? scenario).toLowerCase();
  for (const ask of scenario.asks) assert.ok(ask.keys.some((k) => sent.includes(k.toLowerCase().split(" ")[0])), `ask ${ask.n} ${ask.ask}`);
});

test("each ask gets the bucket its paragraph sits under; one not named is MISSING", () => {
  const asks = [
    { n: 1, place: "hub", ask: "inbox rows", keys: ["inbox row"] },
    { n: 2, place: "x", ask: "android reply", keys: ["android"] },
    { n: 3, place: "hivra", ask: "gif", keys: ["gif"] },
  ];
  const answer = "Of 3: 1 done, 1 waiting on you, 1 lost.\nDone:\nThe Android reply, draft only.\nWaiting on you:\nShorter inbox rows in the preview.";
  assert.deepEqual(askLedger(asks, answer).map((a) => a.state), ["waiting on you", "done", "MISSING"]);
});

test("repeats only in the raw transcript are labelled as such", () => {
  const transcript = "- +1s [tally-lead chat] Needs the user: Which key? / My pick: N\n- +9s [tally-lead chat] x\nNeeds the user: Which key?\n";
  const note = renderedVsRaw({ views: [{ mainText: "Which key? I'd go with N" }] }, transcript);
  assert.match(note, /writes 1 open question\(s\) more than once/);
  assert.match(note, /rendered chat shows 0 marker/);
  assert.match(note, /transcript-only/);
  assert.ok(asksSection({ asks: [], views: [] }, "").length > 0);
});
