// The converter and the scorer, tested on hand-made rows and a three-line store. Pure: no disk, no network,
// no model. The policy's own word reader and id function are small stand-ins here, chosen so a test can say in
// one line what it expects.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  asText,
  asTexts,
  docForUser,
  memoriesForDocs,
  questionOf,
  snippetsOf,
  usableDocs,
  userTurn,
} from "./convert.mjs";
import {
  claimOracle,
  claimWeights,
  claimWords,
  coverage,
  evidenceHits,
  HIT_SHARE,
  judgeArm,
  lowerWords,
  MAX_TERMS,
  median,
  overlapRank,
  percent,
  questionTermsOf,
  sameWord,
  summarise,
} from "./score.mjs";
import { tinyItems } from "./testFixtures.mjs";

/** A readable stand-in for the policy's memoryId: the parts joined, so a test can see what made an id. */
const memoryId = (parts) => `mem-${parts.join("|")}`;

/** A readable stand-in for the policy's contentWords: lower-case words of three letters or more. */
const contentWords = (text) => (String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length >= 3);

// The converter.

test("a chat loses its speaker tag and the assistant's reply", () => {
  assert.equal(userTurn("Leo: I like tea. Assistant: Noted."), "I like tea.");
  assert.equal(userTurn("I like tea."), "I like tea.");
  assert.equal(userTurn("  Leo: spaced out  "), "spaced out");
  assert.equal(userTurn("Assistant: only a reply"), "", "a chat that opens with the assistant has no user turn");
});

test("a reply on its own line is cut, with the blank lines and spaces around it", () => {
  const chat = "Leo: I like tea and long walks.  \nAssistant: That sounds nice.\nDo you walk daily?";
  assert.equal(userTurn(chat), "I like tea and long walks.");
  assert.equal(userTurn("Leo: I like tea.\nAssistant: Noted."), "I like tea.");
  assert.equal(userTurn("Leo: I like tea. Assistant: Noted."), "I like tea.");
});

test("a chat that writes its line break as the two characters backslash and n gives up its reply too", () => {
  assert.equal(userTurn("Leo: I like tea.  \\nAssistant: Noted."), "I like tea.");
  assert.equal(userTurn("Leo: I like tea.\\n\\nAssistant: Noted."), "I like tea.");
});

test("a value that is not a chat becomes nothing, not a crash", () => {
  assert.equal(userTurn(undefined), "");
  assert.equal(userTurn(null), "");
  assert.equal(userTurn(42), "");
  assert.equal(userTurn(""), "");
});

test("a short chat is one snippet, an empty chat is none", () => {
  assert.deepEqual(snippetsOf("one fact"), ["one fact"]);
  assert.deepEqual(snippetsOf(""), []);
});

test("a long chat is cut at a sentence end, and every piece survives", () => {
  const first = "First sentence about the printer. ";
  const second = "Second sentence about the trip to the coast. ";
  const third = "Third sentence about the quiet street where I live.";
  const whole = first + second + third;
  const pieces = snippetsOf(whole, 60);
  assert.ok(pieces.length >= 2, "a chat over the limit is cut");
  assert.deepEqual(pieces.join(" "), whole);
  assert.ok(pieces[0].endsWith("."), "the first piece ends at a sentence, not mid-word");
  assert.ok(pieces.every((piece) => piece.length <= 61), "no piece is much longer than the limit");
});

test("a long chat with no sentence end is cut at a word, never mid-word", () => {
  const body = "alpha ".repeat(30).trim();
  const pieces = snippetsOf(body, 40);
  for (const piece of pieces) {
    assert.ok(piece === "alpha" || piece.startsWith("alpha "), `"${piece}" starts mid-word`);
  }
  assert.deepEqual(pieces.join(" "), body);
});

test("one memory per snippet, confirmed, with the chat as its source", () => {
  const docs = ["Leo: I like tea. Assistant: Noted.", "Leo: I dislike coffee."];
  const items = memoriesForDocs(docs, { memoryId });
  assert.equal(items.length, 2);
  for (const item of items) {
    assert.equal(item.state, "confirmed");
    assert.equal(item.mateId, "memory-eval");
    assert.equal(item.action, "add");
    assert.equal(item.source.kind, "import");
    assert.equal(item.createdAt, item.updatedAt);
  }
  assert.deepEqual(items.map((item) => item.source.ref), ["chat-0", "chat-1"]);
  assert.deepEqual(items.map((item) => item.source.label), ["chat 1", "chat 2"]);
});

test("the same words in two chats stay two memories, because each names its own chat", () => {
  const docs = ["Leo: I like tea.", "Leo: I like tea."];
  const items = memoriesForDocs(docs, { memoryId });
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.source.ref), ["chat-0", "chat-1"]);
});

test("a store already holding an id skips it rather than writing the same fact twice", () => {
  const same = (parts) => `mem-${parts.at(-1)}`; // an id that ignores everything but the text
  const docs = ["Leo: I like tea.", "Leo: I like tea."];
  assert.equal(memoriesForDocs(docs, { memoryId: same }).length, 1);
});

test("docs that are not a list, or hold no user turn, add nothing", () => {
  assert.deepEqual(memoriesForDocs(undefined, { memoryId }), []);
  assert.deepEqual(memoriesForDocs([null, "", "Assistant: hello"], { memoryId }), []);
});

test("memoriesForDocs needs the id function and says so", () => {
  assert.throws(() => memoriesForDocs(["Leo: tea"], {}), /memoryId function/);
});

test("a user's doc holds the memories and no other state", () => {
  const doc = docForUser(["Leo: I like tea."], { memoryId });
  assert.equal(doc.revision, 1);
  assert.equal(doc.generation, 1);
  assert.equal(doc.items.length, 1);
  assert.deepEqual(doc.doneTurns, []);
  assert.deepEqual(doc.imports, {});
});

test("column values are read whether they arrive as a string, bytes, or nothing", () => {
  assert.equal(asText("text"), "text");
  assert.equal(asText(Buffer.from("bytes")), "bytes");
  assert.equal(asText(new Uint8Array([104, 105])), "hi");
  assert.equal(asText(null), "");
  assert.equal(asText(7), "");
  assert.deepEqual(asTexts(["a", "", null, "b"]), ["a", "b"]);
  assert.deepEqual(asTexts("not a list"), []);
});

test("a question row with a blank question or a blank answer is dropped", () => {
  assert.equal(questionOf({ userId: 1, question: "", answer: "a", choices: [] }), undefined);
  assert.equal(questionOf({ userId: 1, question: "q", answer: " ", choices: [] }), undefined);
  assert.equal(questionOf({ userId: 1, question: "q", answer: "a", choices: [], hard: "true" }).hard, false);
});

test("a question row keeps its user, its answer, its choices and a true hard flag", () => {
  const question = questionOf({ userId: 7, question: " q ", answer: " a ", choices: ["a", "", "b"], hard: true });
  assert.deepEqual(question, { userId: 7, question: "q", answer: "a", choices: ["a", "b"], hard: true });
});

test("a user id that is not a whole number becomes no id, not NaN", () => {
  assert.equal(questionOf({ userId: "seven", question: "q", answer: "a" }).userId, undefined);
  assert.equal(questionOf({ userId: Number.NaN, question: "q", answer: "a" }).userId, undefined);
});

test("docs with no user turn are not worth storing", () => {
  assert.deepEqual(usableDocs(["Assistant: hello", null, "Leo: tea"]), ["Leo: tea"]);
  assert.deepEqual(usableDocs(["Assistant: hello", null, "   "]), []);
  assert.deepEqual(usableDocs(undefined), []);
});

// The scorer.

test("words are lower-cased, and one-letter pieces are not words", () => {
  assert.deepEqual(lowerWords("The Cat, a 9!"), ["the", "cat"]);
  assert.deepEqual(lowerWords("ÉTIENNE went home"), ["étienne", "went", "home"]);
});

test("two words match at four letters or more, never at three", () => {
  assert.equal(sameWord("walk", "walks"), true);
  assert.equal(sameWord("walks", "walk"), true);
  assert.equal(sameWord("cat", "cats"), false);
  assert.equal(sameWord("tea", "tea"), true);
});

test("the claim words are what the answer says and its distractors do not", () => {
  const answer = "I read the failure twice before touching code.";
  const choices = [answer, "I delete the test and rerun it.", "I ask a colleague to look.", "I wait for someone else."];
  const terms = claimWords(answer, choices, contentWords);
  assert.ok(terms.includes("failure"), "a word only the answer uses is a claim word");
  assert.ok(terms.includes("read"), "the answer's own verb is a claim word");
  assert.ok(!terms.includes("test"), "a word a distractor also uses is not a claim word");
  assert.ok(!terms.includes("before"), "a stopword is not a claim word");
});

test("claim words are capped so a long answer does not outvote a short one", () => {
  const answer = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
  const terms = claimWords(answer, [answer], contentWords);
  assert.equal(terms.length, MAX_TERMS);
  assert.deepEqual(terms, ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"]);
});

test("with no distractors every distinctive answer word is a claim word, in order", () => {
  assert.deepEqual(claimWords("quiet morning walk", ["quiet morning walk"], contentWords), ["quiet", "morning", "walk"]);
});

test("an empty answer claims nothing", () => {
  assert.deepEqual(claimWords("", ["a", "b"], contentWords), []);
});

test("claimWords needs the word reader and says so", () => {
  assert.throws(() => claimWords("a", [], undefined), /contentWords function/);
});

test("a word in every memory weighs one, a rare word weighs more", () => {
  const items = [
    { id: "a", text: "coffee and failure" },
    { id: "b", text: "coffee in the morning" },
    { id: "c", text: "coffee after lunch" },
  ];
  const weights = claimWeights(["coffee", "failure"], items);
  assert.equal(weights.get("coffee"), 1 + Math.log(4 / 4), "a word in every memory weighs one");
  assert.equal(weights.get("failure"), 1 + Math.log(4 / 2));
  assert.ok(weights.get("failure") > weights.get("coffee"));
  assert.equal(claimWeights(["absent"], items).get("absent"), 1 + Math.log(4 / 1));
});

test("a claim word the store never uses weighs the most", () => {
  const weights = claimWeights(["nothing"], tinyItems(memoryId));
  assert.equal(weights.get("nothing"), 1 + Math.log(4 / 1));
});

test("coverage counts the union of the shown lines, not one line", () => {
  const items = tinyItems(memoryId);
  const terms = ["failure", "coffee"];
  const weights = new Map([["failure", 1], ["coffee", 1]]);
  assert.equal(coverage(items, [items[0].id, items[1].id], terms, weights), 1);
  assert.equal(coverage(items, [items[0].id], terms, weights), 0.5);
  assert.equal(coverage(items, [items[2].id], terms, weights), 0);
  assert.equal(coverage(items, [], terms, weights), 0);
});

test("coverage weights a rare term more than a common one", () => {
  const items = tinyItems(memoryId);
  const terms = ["failure", "coffee"];
  const weights = new Map([["failure", 3], ["coffee", 1]]);
  assert.equal(coverage(items, [items[0].id], terms, weights), 0.75);
});

test("coverage ignores a term with no weight and an id the store does not hold", () => {
  const items = tinyItems(memoryId);
  assert.equal(coverage(items, ["missing"], ["failure"], new Map()), 0);
});

test("the exact measure only reports when the data names the evidence chat", () => {
  const items = tinyItems(memoryId);
  assert.equal(evidenceHits(items, [items[1].id], 1), true);
  assert.equal(evidenceHits(items, [items[0].id], 1), false);
  assert.equal(evidenceHits(items, [items[0].id], undefined), undefined);
});

test("a judged question uses the exact measure when it exists, the proxy otherwise", () => {
  const items = tinyItems(memoryId);
  const weights = new Map([["failure", 1]]);
  const exact = judgeArm(items, [items[0].id], ["failure"], weights, 1);
  assert.deepEqual([exact.hit, exact.exact], [false, false]);
  const proxy = judgeArm(items, [items[0].id], ["failure"], weights);
  assert.equal(proxy.hit, true, "the shown line carries the claim's whole weight");
  assert.equal(proxy.exact, undefined);
  assert.equal(proxy.lines, 1);
});

test("the proxy's threshold is half the claim's weight", () => {
  const items = tinyItems(memoryId);
  const weights = new Map([["failure", 1], ["coffee", 1]]);
  assert.equal(judgeArm(items, [items[0].id], ["failure", "coffee"], weights).share, 0.5);
  assert.equal(judgeArm(items, [items[0].id], ["failure", "coffee"], weights).hit, HIT_SHARE <= 0.5);
});

test("overlap ranks by the question's shared words and keeps the store's order on a tie", () => {
  const items = tinyItems(memoryId);
  assert.deepEqual(overlapRank(items, "coffee morning?", 3, contentWords), [items[1].id]);
  const two = overlapRank(items, "coffee walk?", 3, contentWords);
  assert.deepEqual(two, [items[1].id, items[2].id], "equal overlap keeps the store's order");
  assert.deepEqual(overlapRank(items, "a", 3, contentWords), [], "a question with no words finds nothing");
});

test("overlap gives nothing back when no line shares a word with the question", () => {
  const items = tinyItems(memoryId);
  assert.deepEqual(overlapRank(items, "quantum chromodynamics", 3, contentWords), []);
});

test("the ceiling finds the lines that carry the most claim words", () => {
  const items = tinyItems(memoryId);
  assert.deepEqual(claimOracle(items, ["failure"], 3), [items[0].id]);
  assert.deepEqual(claimOracle(items, ["nothing"], 3), []);
  assert.deepEqual(claimOracle(items, ["failure", "coffee"], 2), [items[0].id, items[1].id]);
});

test("question terms are the policy's words, three letters and up, capped", () => {
  assert.deepEqual(questionTermsOf("Email or call?", contentWords), ["email", "call"]);
  assert.throws(() => questionTermsOf("a", undefined), /contentWords function/);
});

test("the totals count a hit at three only when the arm showed three lines or fewer", () => {
  const judged = [
    { hit: true, lines: 3, share: 1 },
    { hit: true, lines: 4, share: 1 },
    { hit: false, lines: 0, share: 0 },
    { hit: false, lines: 2, share: 0.25 },
  ];
  const totals = summarise(judged);
  assert.equal(totals.questions, 4);
  assert.equal(totals.hit, 0.5, "a hit counts whatever the arm showed");
  assert.equal(totals.hitAt3, 0.25);
  assert.equal(totals.hitAt10, 0.5);
  assert.equal(totals.shown, 0.75);
  assert.equal(totals.meanLines, 2.25);
  assert.equal(totals.meanShare, 0.5625);
});

test("an empty arm summarises to zeros, not NaN", () => {
  const totals = summarise([]);
  assert.equal(totals.questions, 0);
  assert.equal(totals.hit, 0);
  assert.equal(totals.hitAt3, 0);
  assert.equal(totals.meanLines, 0);
});

test("the median is the middle, or the mean of the two middles", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), 0);
});

test("a share prints as a percentage with one decimal", () => {
  assert.equal(percent(0), "0.0%");
  assert.equal(percent(0.1234), "12.3%");
  assert.equal(percent(1), "100.0%");
});
