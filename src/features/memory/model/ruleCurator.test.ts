// WP-103: the rules tier. The correction rule's cases come first, ported from Row-Bot's own test corpus
// (tests/subsystem/learning/test_learning_corrections.py, Apache-2.0); the fact detector and the Hivra-only
// guards follow.

import { describe, expect, it } from "vitest";
import { freshDoc, settleTurn, type CuratorContext } from "./curator";
import { judge, ownWords, ruleProposal, rulesAnswer, withdraws } from "./ruleCurator";

const NOW = Date.parse("2026-03-01T00:00:00Z");
const SECRET = "sk-ant-api03-abcdefghijklmnopqrst";

// Row-Bot's labelled examples, unchanged.
const CORRECTIONS = [
  "No, use the 2026 agreement.",
  "That's not right - the fee is 85 EUR.",
  "Hmm, not quite: the rota changed in March.",
  "Wrong file. I asked for the approved policy.",
  "You used the old policy.",
  "That is the draft, not the approved handbook.",
  "Coldharbour Dairy delivers Mondays and Thursdays - Thursday was missing.",
  "It's 5C max. I need the approved limit, not the unapproved draft.",
  "I asked for one event, not two.",
  "It should be 5C, not 8C.",
  "`tools/release_6.py` wasn't written. Implement it there.",
  "Nope, the meeting is at 11.",
];
const NOT_CORRECTIONS = [
  "Now do the same for March.",
  "Thanks! Can you also add the totals?",
  "No worries, next: archive the newsletter.",
  "No thanks, that is all.",
  "What about the other client?",
  "Is the total including VAT?",
  "Great. Which entries are missing from the rota?",
  "Find the wrong date in the invoice log.",
  "Check which deliveries were missing last week.",
  "Perfect, that works.",
  "Can you schedule a meeting with Eli on Friday?",
  "Not now, maybe later.",
  "Lovely - now turn it into a CSV.",
  "The supplier list was updated yesterday, please read it again and tell me who delivers dairy.",
];
const AMBIGUOUS = [
  "Actually, can you also include Mondays?",
  "Wait, before that, read the handbook.",
  "Is that right? It seems high.",
  "No, you were right, never mind.",
];

function ctx(extra: Partial<CuratorContext> = {}): CuratorContext {
  return { mateId: "notes-lead", turnId: "turn-1", user: "", assistant: "", now: NOW, ...extra };
}

describe("Row-Bot's correction rule", () => {
  it("confirms only messages that say the reply was wrong", () => {
    expect(CORRECTIONS.filter((text) => judge(text) !== "correction")).toEqual([]);
    expect(NOT_CORRECTIONS.filter((text) => judge(text) === "correction")).toEqual([]);
    expect(new Set(AMBIGUOUS.map(judge))).toEqual(new Set(["ambiguous"]));
    // No false positives across the corpus, which is the rule's whole point.
    expect([...NOT_CORRECTIONS, ...AMBIGUOUS].filter((text) => judge(text) === "correction")).toEqual([]);
  });

  it("reads the opening words the way Row-Bot does", () => {
    expect(judge("")).toBe("not");
    expect(judge("   ")).toBe("not");
    expect(judge("`tools/release_6.py` wasn't written. Implement it there.")).toBe("correction");
    expect(judge("(no, the other file)")).toBe("correction");
    expect(judge("NO, THE OTHER FILE")).toBe("correction");
    expect(judge("No, that’s wrong.")).toBe("correction");
    expect(judge("No, you were right, never mind.")).toBe("ambiguous");
    expect(withdraws("Never mind, you were right.")).toBe(true);
    expect(withdraws("Thanks, that works.")).toBe(false);
  });

  it("a defect in the first two sentences counts, but a question about one does not", () => {
    expect(judge("The total is missing the VAT line.")).toBe("correction");
    expect(judge("Which entries are missing from the rota?")).toBe("not");
    expect(judge("Find the wrong date in the invoice log.")).toBe("not");
    expect(judge("The rota is fine. The second sheet is missing.")).toBe("correction");
    // A bare question opening is not a correction even when a later sentence names a defect after a cut.
    expect(judge("No, the meeting is at 11.")).toBe("correction");
  });
});

describe("the person's own words", () => {
  it("leaves out code fences, pasted blocks, quotes and blockquotes", () => {
    const text = [
      "Remember that we ship on Fridays.",
      "```ts",
      "const always = 'never';",
      "```",
      "> always use tabs",
      "    indent is four spaces",
      'She said "always use pnpm" in the meeting.',
      "Never use force push.",
    ].join("\n");
    const own = ownWords(text);
    expect(own).toContain("Remember that we ship on Fridays.");
    expect(own).toContain("Never use force push.");
    expect(own).not.toContain("const always");
    expect(own).not.toContain("always use tabs");
    expect(own).not.toContain("indent is four");
    expect(own).not.toContain("always use pnpm");
  });

  it("drops everything after an unclosed fence, which is a cut-off paste", () => {
    expect(ownWords("Thanks.\n```\nsome code")).not.toContain("some code");
  });
});

describe("a fact from an explicit signal", () => {
  it("takes 'remember that', 'remember:' and 'from now on' from the person's message", () => {
    expect(ruleProposal({ user: "Remember that the release branch is called ship." })).toMatchObject({
      kind: "add",
      text: "The release branch is called ship.",
    });
    expect(ruleProposal({ user: "remember: use pnpm in this project" })).toMatchObject({
      kind: "add",
      text: "Use pnpm in this project",
    });
    expect(ruleProposal({ user: "From now on, reviews happen on Friday." })).toMatchObject({
      kind: "add",
      text: "Reviews happen on Friday.",
    });
  });

  it("takes 'always' and 'never' at the start of a sentence, and nothing after a question mark or a retraction", () => {
    expect(ruleProposal({ user: "Always use pnpm, not npm." })).toMatchObject({ kind: "add", text: "Always use pnpm, not npm." });
    expect(ruleProposal({ user: "Never force push to main." })).toMatchObject({ kind: "add", text: "Never force push to main." });
    expect(ruleProposal({ user: "Always use pnpm?" })).toEqual({ kind: "none" });
    expect(ruleProposal({ user: "Never mind, the draft was fine." })).toEqual({ kind: "none" });
    expect(ruleProposal({ user: "I always use pnpm." })).toEqual({ kind: "none" });
  });

  it("quotes the sentence as the evidence, and keeps the marker off the fact", () => {
    const proposal = ruleProposal({ user: "Morning. Remember that the fee is 85 EUR." });
    expect(proposal).toEqual({ kind: "add", text: "The fee is 85 EUR.", evidence: "Remember that the fee is 85 EUR." });
  });

  it("never reads the assistant's message, a quote, a code fence or a pasted block", () => {
    expect(ruleProposal({ user: "Thanks.", assistant: "Remember that the sky is green." })).toEqual({ kind: "none" });
    expect(ruleProposal({ user: 'He wrote "always use pnpm" in the doc.', assistant: "" })).toEqual({ kind: "none" });
    expect(ruleProposal({ user: "```\nalways use pnpm\n```" })).toEqual({ kind: "none" });
    expect(ruleProposal({ user: "> always use pnpm" })).toEqual({ kind: "none" });
    expect(ruleProposal({ user: "    never touch the prod keys" })).toEqual({ kind: "none" });
    expect(ruleProposal({})).toEqual({ kind: "none" });
  });

  it("does not take a secret, an empty fact or a single word", () => {
    expect(ruleProposal({ user: `Remember that the key is ${SECRET}` })).toEqual({ kind: "none" });
    expect(ruleProposal({ user: "Remember that." })).toEqual({ kind: "none" });
    expect(ruleProposal({ user: "Remember: x" })).toEqual({ kind: "none" });
    expect(ruleProposal({ user: "Remember: the" })).toEqual({ kind: "none" });
  });

  it("takes a bulleted instruction, and the first signal when there are several", () => {
    expect(ruleProposal({ user: "- Remember that the sky is blue.\n- Remember that the sea is wet." })).toMatchObject({
      kind: "add",
      text: "The sky is blue.",
    });
  });
});

describe("a fact from a correction", () => {
  it("becomes one proposal quoting the person's words", () => {
    expect(ruleProposal({ user: "No, use the 2026 agreement." })).toEqual({
      kind: "add",
      text: "Use the 2026 agreement.",
      evidence: "No, use the 2026 agreement.",
    });
    expect(ruleProposal({ user: "You used the old policy." })).toMatchObject({
      kind: "add",
      evidence: "You used the old policy.",
    });
    expect(ruleProposal({ user: "Wrong file. I asked for the approved policy." })).toMatchObject({
      kind: "add",
      text: "I asked for the approved policy.",
      evidence: "Wrong file. I asked for the approved policy.",
    });
  });

  it("does not propose from thanks, agreement, questions, retractions or the assistant's line", () => {
    for (const text of NOT_CORRECTIONS.concat(AMBIGUOUS)) {
      expect(ruleProposal({ user: text }), text).toEqual({ kind: "none" });
    }
    expect(ruleProposal({ user: "Thanks.", assistant: "No, use the 2026 agreement." })).toEqual({ kind: "none" });
  });

  it("does not propose from a correction inside a code fence or a quote", () => {
    expect(ruleProposal({ user: "```\nNo, use the 2026 agreement.\n```" })).toEqual({ kind: "none" });
    expect(ruleProposal({ user: 'He said "No, use the 2026 agreement."' })).toEqual({ kind: "none" });
  });

  it("does not propose from a correction whose words are a secret", () => {
    expect(ruleProposal({ user: `No, use ${SECRET}.` })).toEqual({ kind: "none" });
  });
});

describe("the rules answer", () => {
  it("has the same shape the curator's own reply does, and settles through settleTurn unchanged", () => {
    const answer = rulesAnswer({ user: "Remember that the release branch is called ship." });
    expect(answer).toEqual({
      kind: "reply",
      text: JSON.stringify({ kind: "add", text: "The release branch is called ship.", evidence: "Remember that the release branch is called ship." }),
    });
    const settled = settleTurn(
      freshDoc(),
      ctx({ user: "Remember that the release branch is called ship." }),
      answer,
    );
    expect(settled.outcome).toMatchObject({ status: "stored" });
    expect(settled.doc.items[0]).toMatchObject({
      action: "add",
      state: "unreviewed",
      text: "The release branch is called ship.",
      source: { kind: "turn", ref: "turn-1" },
      evidence: "Remember that the release branch is called ship.",
    });
    expect(settled.doc.doneTurns).toEqual(["notes-lead:turn-1"]);
  });

  it("says none, so a quiet turn finishes without an item", () => {
    const settled = settleTurn(freshDoc(), ctx({ user: "Thanks, that works." }), rulesAnswer({ user: "Thanks, that works." }));
    expect(settled.outcome).toMatchObject({ status: "none" });
    expect(settled.doc.items).toEqual([]);
    expect(settled.doc.doneTurns).toHaveLength(1);
  });

  it("keeps the quote inside the turn, so the evidence check still passes", () => {
    const user = "No, use the 2026 agreement.";
    const settled = settleTurn(freshDoc(), ctx({ user }), rulesAnswer({ user }));
    expect(settled.outcome.status).toBe("stored");
    expect(settled.doc.items[0].evidence).toBe(user);
  });
});
