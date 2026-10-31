// r101 (5): repeated asks are dropped from the raw transcript as well as the rendered view.
import assert from "node:assert/strict";
import { test } from "node:test";
import { transcript } from "./hub-realtest-scenarios.mjs";

const empty = { sends: [], room: [], otherRooms: [], texts: [], answers: [], marks: [], faults: [], views: [], delegations: [], metrics: {}, notes: [] };
const scenario = { id: "b5", title: "dump", bench: ["B5"], criteria: "" };

test("an ask a chat already asked shows once in transcript.md", () => {
  const ask = "Needs Ash: May Hivra publish a privacy page?\nMy pick: Yes, a short one.";
  const texts = [
    { t: 1, who: "hivra-lead", text: `Got it.\n\n${ask}` },
    { t: 2, who: "hivra-lead", text: `Privacy draft is done.\n\n${ask}` },
    { t: 3, who: "tally-lead", text: ask },
  ];
  const md = transcript(scenario, { ...empty, texts }, 0);
  assert.equal(md.match(/May Hivra publish a privacy page\?/g)?.length, 2, "once per chat");
  assert.match(md, /Privacy draft is done\. \[transcript note, not in the chat: 1 Needs Ash line it asked before not repeated here\]/);
  assert.equal(md.match(/My pick: Yes, a short one\./g)?.length, 2);
});
