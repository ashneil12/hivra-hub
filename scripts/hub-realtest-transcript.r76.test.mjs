// r76: s13's grader saw the Lead's 40-item reply end at "28. T" and failed it as cut off. The app had the whole reply;
// the bench's transcript clipped every chat line at 1200 characters without saying so.
import assert from "node:assert/strict";
import { test } from "node:test";
import { transcript } from "./hub-realtest-scenarios.mjs";

const empty = { sends: [], room: [], otherRooms: [], texts: [], answers: [], marks: [], faults: [], views: [], delegations: [], metrics: {}, notes: [] };
const scenario = { id: "s13", title: "dump", bench: ["B5"], criteria: "" };

test("a long chat reply reaches the grader whole", () => {
  const reply = Array.from({ length: 40 }, (_, i) => `${i + 1}. item number ${i + 1} handled with a short plain note.`).join(" ");
  assert.ok(reply.length > 1200 && reply.length < 6000);
  const text = transcript(scenario, { ...empty, texts: [{ t: 1, who: "tally-lead", text: reply }] }, 0);
  assert.ok(text.includes("40. item number 40"), "the last item is in the transcript");
});

test("a reply past the cap says the harness clipped it", () => {
  const text = transcript(scenario, { ...empty, texts: [{ t: 1, who: "tally-lead", text: "x".repeat(9000) }] }, 0);
  assert.match(text, /clipped by the test harness/);
});
