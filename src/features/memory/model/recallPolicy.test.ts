import { describe, expect, it } from "vitest";
import { memoryId, type MemoryDoc, type MemoryItem } from "./doc";
import {
  RECALL_MAX_LINES,
  buildQuery,
  recallDecision,
  recencyComponent,
  tallyRejections,
  type RecallDecision,
} from "./recallPolicy";

const NOW = Date.parse("2026-03-01T00:00:00Z");
const MATE = "notes-lead";
/** Two memories can read the same; the store still gives each its own id. */
let serial = 0;

function item(text: string, extra: Partial<MemoryItem> = {}): MemoryItem {
  serial += 1;
  return {
    id: memoryId([MATE, extra.action ?? "add", text.toLowerCase(), String(serial)]),
    mateId: MATE,
    action: "add",
    text,
    state: "confirmed",
    source: { kind: "turn", ref: "turn-1", label: "turn-1" },
    evidence: text,
    support: 1,
    against: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

function doc(items: MemoryItem[]): MemoryDoc {
  return { revision: 1, generation: 1, items, doneTurns: [], imports: {} };
}

function decide(items: MemoryItem[], message: string, extra: Partial<Parameters<typeof recallDecision>[0]> = {}): RecallDecision {
  return recallDecision({ doc: doc(items), mateId: MATE, message, now: NOW, mode: "automatic", ...extra });
}

function candidateFor(decision: RecallDecision, id: string) {
  return decision.candidates.find((candidate) => candidate.id === id);
}

describe("the skip gates", () => {
  const store = [item("Likes small commits")];

  it("says nothing for an empty message", () => {
    expect(decide(store, "   ").stop).toBe("empty_message");
  });

  it("says nothing for a greeting", () => {
    expect(decide(store, "hi there").stop).toBe("greeting_only");
    expect(decide(store, "hello hello").stop).toBe("greeting_only");
    expect(decide(store, "thanks!").stop).toBe("greeting_only");
  });

  it("still recalls for a greeting with a real question after it", () => {
    expect(decide(store, "hi, how do you like to write commit messages?").stop).toBeUndefined();
  });

  it("says nothing for a question about the app itself", () => {
    expect(decide(store, "what model are you using?").stop).toBe("runtime_request");
    expect(decide(store, "show me the debug logs please").stop).toBe("runtime_request");
    expect(decide(store, "what is the app version now").stop).toBe("runtime_request");
  });

  it("still recalls when the same words are about the person's work", () => {
    // "review" is a anchor, so this is not a runtime question even though it says "settings".
    expect(decide(store, "where are my review settings kept?").stop).not.toBe("runtime_request");
  });

  it("says nothing for a turn that carried only a file", () => {
    const message = 'Attached file (read from disk): "/tmp/report.pdf"';
    expect(decide(store, message).stop).toBe("file_only_turn");
    const folder = 'Attached folder (list or read the files inside from this path): "/tmp/reports"';
    expect(decide(store, folder).stop).toBe("file_only_turn");
  });

  it("still recalls for a file turn that says what the work is", () => {
    const message = 'Please fix my build error\n\nAttached file (read from disk): "/tmp/report.pdf"';
    expect(decide(store, message).stop).not.toBe("file_only_turn");
  });

  it("says nothing for fewer than four content words", () => {
    expect(decide(store, "sounds good today").stop).toBe("too_few_words");
    expect(decide(store, "the and for with").stop).toBe("too_few_words");
  });

  it("says nothing when the Mono has no memories", () => {
    expect(decide([], "how do you like to write commit messages?").stop).toBe("no_memories");
  });

  it("does not run the gates for an explicit search", () => {
    const found = decide([item("Crew keeps the notes.")], "notes", { mode: "explicit" });
    expect(found.stop).toBeUndefined();
    expect(found.picked).toHaveLength(1);
  });
});

describe("the query", () => {
  it("joins the latest message with earlier ones and stops at the limit", () => {
    expect(buildQuery("  one  ", ["two", "three"])).toBe("one two three");
    expect(buildQuery("first", ["second"], 8)).toBe("first");
  });

  it("is the message itself when there is nothing earlier", () => {
    expect(buildQuery("What did I say about commits?")).toBe("What did I say about commits?");
  });
});

describe("the score", () => {
  it("puts a hit in the fact above a hit in where it came from", () => {
    const inFact = item("Name remote branches after the ticket.");
    const inLabel = item("Unrelated thing entirely.", {
      source: { kind: "turn", ref: "turn-9", label: "remote branch picker" },
    });
    const decision = decide([inFact, inLabel], "What name do I pick for a remote branch?");
    const fact = candidateFor(decision, inFact.id)!;
    const label = candidateFor(decision, inLabel.id)!;
    expect(fact.matchedField).toBe("fact");
    expect(label.matchedField).toBe("label");
    expect(fact.parts.lexical).toBeGreaterThan(label.parts.lexical);
    expect(fact.score).toBeGreaterThan(label.score);
  });

  it("returns the parts the screen shows, adding up to the score", () => {
    const memory = item("Likes small commits");
    const decision = decide([memory], "How do you like to write commit messages for a branch?");
    const candidate = candidateFor(decision, memory.id)!;
    expect(Object.keys(candidate.parts).sort()).toEqual(["evidence", "lexical", "recency", "tier"]);
    const summed =
      0.7 * candidate.parts.lexical + 0.15 * candidate.parts.recency + 0.1 * candidate.parts.tier + 0.05 * candidate.parts.evidence;
    expect(candidate.score).toBeCloseTo(summed, 3);
  });

  it("scores an edited fact above a confirmed one, and an import below both", () => {
    const confirmed = item("Likes small commits");
    const edited = item("Likes small commits", { state: "edited" });
    const imported = item("Likes small commits", { source: { kind: "import", ref: "chat-1", label: "old chat" } });
    const decision = decide([confirmed, edited, imported], "How do you like to write commit messages for a branch?");
    expect(candidateFor(decision, edited.id)!.parts.tier).toBe(1);
    expect(candidateFor(decision, confirmed.id)!.parts.tier).toBe(0.75);
    expect(candidateFor(decision, imported.id)!.parts.tier).toBe(0.7);
  });

  it("counts the evidence of a confirmed fact higher than an unproven one", () => {
    const proven = item("Likes small commits", { support: 9, against: 0 });
    const unproven = item("Likes small commits", { support: 0, against: 0 });
    const decision = decide([proven, unproven], "How do you like to write commit messages for a branch?");
    expect(candidateFor(decision, proven.id)!.parts.evidence).toBeGreaterThan(candidateFor(decision, unproven.id)!.parts.evidence);
  });

  it("keeps a fresh memory at 1 and an old one at 0.7", () => {
    expect(recencyComponent(NOW, NOW)).toBe(1);
    expect(recencyComponent(NOW - 400 * 86_400_000, NOW)).toBe(0.7);
    expect(recencyComponent(NOW + 10_000, NOW)).toBe(1);
  });
});

describe("the rejection reasons", () => {
  it("leaves out a proposal nobody has reviewed", () => {
    const unreviewed = item("Likes small commits", { state: "unreviewed" });
    const decision = decide([unreviewed], "How do you like to write commit messages for a branch?");
    expect(candidateFor(decision, unreviewed.id)!.reason).toBe("needs_review");
  });

  it("leaves out a skill and any other non-fact", () => {
    const skill = item("Read the diff before commenting.", {
      action: "skill",
      skill: { name: "reviewing-a-diff", lesson: "Read the diff before commenting." },
    });
    const decision = decide([skill], "What do you think about commenting on a diff before merging it?");
    expect(candidateFor(decision, skill.id)!.reason).toBe("not_a_fact");
  });

  it("leaves out a fact with a removal waiting on the person", () => {
    const fact = item("Likes small commits");
    const removal = item("Remove: likes small commits", { action: "remove", state: "unreviewed", targetId: fact.id });
    const decision = decide([fact, removal], "How do you like to write commit messages for a branch?");
    expect(candidateFor(decision, fact.id)!.reason).toBe("archived");
  });

  it("leaves out a fact with an update waiting, unless the person asked about the old one", () => {
    const fact = item("Likes small commits");
    const update = item("Likes medium commits", { action: "update", state: "unreviewed", targetId: fact.id });
    const decision = decide([fact, update], "How do you like to write commit messages for a branch?");
    expect(candidateFor(decision, fact.id)!.reason).toBe("superseded");
    const asked = decide([fact, update], "What was my previous habit about writing commit messages?");
    expect(candidateFor(asked, fact.id)!.reason).not.toBe("superseded");
  });

  it("leaves out a fact that looks like a secret", () => {
    const secret = item("The deploy key is sk-ant-api03-abcdefghijklmnopqrst");
    const decision = decide([secret], "Where is my deploy key for the release app?");
    expect(candidateFor(decision, secret.id)!.reason).toBe("secret");
  });

  it("leaves out a memory that shares only one word", () => {
    const oneWord = item("Likes small commits");
    const decision = decide([oneWord], "Do you always want the release notes too?");
    expect(candidateFor(decision, oneWord.id)!.reason).toBe("too_few_shared_words");
  });
});

describe("the rare-word rule", () => {
  /** Twenty facts, all of them holding "always", so that word stops being distinctive. */
  function crowdedStore(extra: MemoryItem[]): MemoryItem[] {
    const filler = Array.from({ length: 20 }, (_, index) => item(`Always keep file ${index} tidy`));
    return [...filler, ...extra];
  }

  it("does not count a word held by more than a quarter of the store", () => {
    const target = item("Always check the postgres migrations");
    const decision = decide(crowdedStore([target]), "always check postgres migrations please");
    expect(candidateFor(decision, target.id)!.reason).toBeUndefined();
  });

  it("leaves out a memory whose only shared word is a common one", () => {
    const target = item("Always keep the kettle warm");
    const decision = decide(crowdedStore([target]), "always check postgres migrations please");
    expect(candidateFor(decision, target.id)!.reason).toBe("too_few_shared_words");
  });

  it("does not measure shares in a store too small to have one", () => {
    const target = item("Always keep the kettle warm");
    const decision = decide([target], "always keep the kettle warm please");
    expect(candidateFor(decision, target.id)!.reason).toBeUndefined();
  });

  it("is not applied to an explicit search", () => {
    const target = item("Always keep the kettle warm");
    const decision = decide(crowdedStore([target]), "kettle always", { mode: "explicit" });
    expect(decision.picked[0]).toBe(target.id);
  });
});

describe("the cap", () => {
  it("shows at most three memories", () => {
    const best = item("Write commit messages like a pro on every branch");
    const close = [1, 2, 3].map((n) => item(`Write commit messages on a branch for note ${n}`));
    const far = item("Commit messages matter");
    const decision = decide([best, ...close, far], "How do you like to write commit messages for a branch?");
    expect(decision.broad).toBe(false);
    expect(decision.picked).toHaveLength(RECALL_MAX_LINES);
    expect(decision.picked).toHaveLength(3);
    const held = decision.candidates.filter((candidate) => candidate.reason === "held_back");
    expect(held).toHaveLength(2);
  });

  it("does not send a memory the conversation has already shown", () => {
    const shown = item("Likes small commits");
    const other = item("Reviews of small branches happen on Fridays");
    const decision = decide([shown, other], "Do you like small commits and reviews of branches?", {
      exclude: new Set([shown.id]),
    });
    expect(decision.picked).not.toContain(shown.id);
    expect(decision.picked).toEqual([other.id]);
    expect(candidateFor(decision, shown.id)!.reason).toBe("already_shown");
  });
});

describe("the broad-query rule", () => {
  it("shows one line when several memories score alike", () => {
    const items = [1, 2, 3].map((n) => item(`Note ${n} about the atlas schedule timing question`));
    const decision = decide(items, "atlas schedule timing question");
    expect(decision.broad).toBe(true);
    expect(decision.picked).toHaveLength(1);
  });

  it("shows every strong match when one memory clearly leads", () => {
    const strong = item("The atlas schedule timing question is settled by the Friday review");
    const weak = item("Atlas schedule");
    const other = item("Timing");
    const decision = decide([strong, weak, other], "How is the atlas schedule timing question settled?");
    expect(decision.broad).toBe(false);
    expect(decision.picked[0]).toBe(strong.id);
    expect(decision.picked).toHaveLength(2);
  });
});

describe("the trace", () => {
  it("gives every memory of the Mono either picked or a reason", () => {
    const picked = item("Likes small commits");
    const unreviewed = item("Likes medium commits", { state: "unreviewed" });
    const decision = decide([picked, unreviewed], "How do you like to write commit messages for a branch?");
    for (const candidate of decision.candidates) {
      expect(Boolean(candidate.picked) !== Boolean(candidate.reason)).toBe(true);
      expect(candidate.score).toBeGreaterThanOrEqual(0);
    }
    expect(tallyRejections(decision).get("needs_review")).toBe(1);
  });

  it("leaves out another Mono's memory entirely", () => {
    const mine = item("Likes small commits");
    const theirs = item("Likes small commits", { mateId: "other-lead" } as Partial<MemoryItem>);
    const decision = decide([mine, theirs], "How do you like to write commit messages for a branch?");
    expect(decision.candidates.map((candidate) => candidate.id)).toEqual([mine.id]);
  });

  it("counts a shared word as met when one word starts the other", () => {
    const memory = item("Reviews happen on Fridays after the sync");
    const decision = decide([memory], "How do you like to review branches after a sync?");
    expect(candidateFor(decision, memory.id)!.parts.lexical).toBeGreaterThan(0);
  });
});

describe("Row-Bot cases carried over", () => {
  it("picks the concrete fact for a personal question and leaves an unrelated one alone", () => {
    const target = item("The user's code word is rosebud.");
    const unrelated = item("The user likes green tea.");
    const decision = decide([target, unrelated], "What is my rosebud code word?");
    expect(decision.picked[0]).toBe(target.id);
    expect(decision.candidates.length).toBe(2);
  });

  it("answers a question about a subject with the fact that names it", () => {
    const parent = item("The Telegram messaging service.");
    const target = item("Streaming responses through Telegram.");
    const decision = decide([parent, target], "What do you remember about Telegram streaming?");
    expect(decision.picked[0]).toBe(target.id);
  });

  it("records why a turn with nothing valid recalled nothing", () => {
    const unreviewed = item("Likes small commits", { state: "unreviewed" });
    const decision = decide([unreviewed], "How do you like to write commit messages for a branch?");
    expect(decision.stop).toBe("no_valid_candidates");
    expect(decision.candidates[0].reason).toBe("needs_review");
  });
});
