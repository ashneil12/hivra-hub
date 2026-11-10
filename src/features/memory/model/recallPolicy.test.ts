import { describe, expect, it, vi } from "vitest";
import { memoryId, type MemoryDoc, type MemoryItem } from "./doc";
import { LivedClock, fadeOf } from "./fade";
import {
  RECALL_FADE_WEIGHT,
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

describe("fade lowers the score", () => {
  const MESSAGE = "How do you like to write commit messages for a branch?";
  const DAY_MS = 86_400_000;

  /** Every date from `from` to `to`, as the doc keeps its lived days. */
  function days(from: string, to: string): string[] {
    const out: string[] = [];
    for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += DAY_MS) {
      out.push(new Date(at).toISOString().slice(0, 10));
    }
    return out;
  }

  it("scores a memory that has faded all the way below the same memory fresh", () => {
    const fresh = item("Likes small commits");
    const faded = item("Likes small commits", { fade: 0, lastUsedAt: NOW });
    const decision = decide([fresh, faded], MESSAGE);
    const freshScore = candidateFor(decision, fresh.id)!.score;
    const fadedScore = candidateFor(decision, faded.id)!.score;
    expect(fadedScore).toBeLessThan(freshScore);
    expect(freshScore - fadedScore).toBeCloseTo(RECALL_FADE_WEIGHT, 3);
  });

  it("lowers the score further the more the memory has faded", () => {
    const strengths = [1, 0.6, 0.2];
    const items = strengths.map((fade) => item("Likes small commits", { fade, lastUsedAt: NOW }));
    const decision = decide(items, MESSAGE);
    const scores = items.map((memory) => candidateFor(decision, memory.id)!.score);
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
  });

  it("leaves a memory at full strength exactly where it was", () => {
    const memory = item("Likes small commits");
    const candidate = candidateFor(decide([memory], MESSAGE), memory.id)!;
    const summed =
      0.7 * candidate.parts.lexical + 0.15 * candidate.parts.recency + 0.1 * candidate.parts.tier + 0.05 * candidate.parts.evidence;
    expect(candidate.fade).toBe(1);
    expect(candidate.score).toBeCloseTo(summed, 3);
  });

  it("reads the fade from the lived days since the memory was last used", () => {
    const used = Date.parse("2025-11-01T00:00:00Z");
    const stale = item("Likes small commits", { lastUsedAt: used });
    const today = item("Likes small commits", { lastUsedAt: NOW });
    const store = { ...doc([stale, today]), livedDays: days("2025-10-01", "2026-03-01") };
    const decision = recallDecision({ doc: store, mateId: MATE, message: MESSAGE, now: NOW, mode: "automatic" });
    const staleRow = candidateFor(decision, stale.id)!;
    const todayRow = candidateFor(decision, today.id)!;
    expect(staleRow.fade).toBeCloseTo(fadeOf(store, stale, NOW), 4);
    expect(staleRow.fade).toBeLessThan(0.5);
    expect(todayRow.fade).toBe(1);
    expect(staleRow.score).toBeLessThan(todayRow.score);
  });

  it("does not lower a fact the person wrote themselves, which does not fade", () => {
    const used = Date.parse("2024-01-01T00:00:00Z");
    const own = item("Likes small commits", { state: "edited", lastUsedAt: used });
    const store = { ...doc([own]), livedDays: days("2024-01-01", "2026-03-01") };
    const decision = recallDecision({ doc: store, mateId: MATE, message: MESSAGE, now: NOW, mode: "automatic" });
    expect(candidateFor(decision, own.id)!.fade).toBe(1);
  });

  it("lets a middling match drop under the floor once it has faded, and keeps a strong one", () => {
    const middling = item("Likes small commits");
    const middlingFaded = item("Likes small commits", { fade: 0, lastUsedAt: NOW });
    const strong = item("Write commit messages like a pro on every branch", { fade: 0, lastUsedAt: NOW });
    const decision = decide([middling, middlingFaded, strong], MESSAGE);
    expect(candidateFor(decision, middling.id)!.reason).toBeUndefined();
    expect(candidateFor(decision, middlingFaded.id)!.reason).toBe("below_threshold");
    expect(decision.picked).toContain(strong.id);
  });

  it("ranks the fresher of two facts that fit equally well above the faded one", () => {
    // The id breaks a tie, so the faded one is the one that would have won it.
    // Two sentences, not one saved twice: the same sentence is one line, however many copies there are.
    const [first, second] = [item("Write commit messages on a branch"), item("On a branch, write commit messages")].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const faded = { ...first, fade: 0.1, lastUsedAt: NOW };
    const decision = decide([faded, second], MESSAGE);
    expect(decision.picked).toEqual([second.id, faded.id]);
  });
});

describe("one decision across Monos", () => {
  const MESSAGE = "What do you remember about writing small commits on a branch?";
  const B = "b-lead";
  const C = "c-lead";

  const a1 = item("Writing small commits on every branch");
  const a2 = item("Likes small commits");
  const b1 = item("Remember to write small commits", { mateId: B });
  const b2 = item("Branch names follow the ticket", { mateId: B });
  const c1 = item("Small commits keep every branch reviewable", { mateId: C });
  const c2 = item("Writing notes for a branch", { mateId: C });
  const store = [a1, a2, b1, b2, c1, c2];

  function across(extra: Partial<Parameters<typeof recallDecision>[0]> = {}): RecallDecision {
    return decide(store, MESSAGE, { mateIds: [MATE, B, C], ...extra });
  }

  it("shows at most three memories for every Mono together, not three each", () => {
    const decision = across();
    expect(decision.picked).toHaveLength(RECALL_MAX_LINES);
    expect(decision.picked).toHaveLength(3);
  });

  it("picks the three strongest wherever they live", () => {
    const decision = across();
    expect(decision.picked[0]).toBe(a1.id);
    expect([...decision.picked].sort()).toEqual([a1.id, b1.id, c1.id].sort());
    expect(candidateFor(decision, a2.id)!.reason).toBe("held_back");
    expect(candidateFor(decision, c2.id)!.reason).toBe("held_back");
  });

  it("scores every memory of every Mono it reads, and says whose each one is", () => {
    const decision = across();
    expect(decision.candidates.map((candidate) => candidate.id).sort()).toEqual(store.map((memory) => memory.id).sort());
    expect(candidateFor(decision, b1.id)!.mateId).toBe(B);
    expect(candidateFor(decision, a1.id)!.mateId).toBe(MATE);
  });

  it("reads the Mono the turn belongs to first, and always", () => {
    const decision = across({ mateIds: [C, B] });
    expect(decision.mateId).toBe(MATE);
    expect(decision.mateIds).toEqual([MATE, C, B]);
    expect(candidateFor(decision, a1.id)).toBeDefined();
  });

  it("does not read a Mono it was not given", () => {
    const decision = across({ mateIds: [MATE, B] });
    expect(candidateFor(decision, c1.id)).toBeUndefined();
    expect(candidateFor(decision, c2.id)).toBeUndefined();
  });

  it("reads only the Mono the turn belongs to when no others are given", () => {
    const decision = decide(store, MESSAGE);
    expect(decision.mateIds).toEqual([MATE]);
    expect(decision.candidates.map((candidate) => candidate.id).sort()).toEqual([a1.id, a2.id].sort());
  });

  it("counts a crowd across every Mono, so alike scores from different Monos still show one line", () => {
    // Three different facts that score alike, one under each Mono: the question did not single one out.
    const alike = [MATE, B, C].map((mateId, n) => item(`Note ${n} about the atlas schedule timing question`, { mateId }));
    const decision = decide(alike, "atlas schedule timing question", { mateIds: [MATE, B, C] });
    expect(decision.broad).toBe(true);
    expect(decision.picked).toHaveLength(1);
  });

  it("does not send a memory twice, whichever Mono it belongs to", () => {
    const decision = across({ exclude: new Set([a1.id, b1.id]) });
    expect(decision.picked).not.toContain(a1.id);
    expect(decision.picked).not.toContain(b1.id);
    expect(candidateFor(decision, b1.id)!.reason).toBe("already_shown");
    expect(decision.picked).toContain(c1.id);
  });

  it("stops with no memories when none of the Monos has any", () => {
    const decision = decide([], MESSAGE, { mateIds: [MATE, B, C] });
    expect(decision.stop).toBe("no_memories");
  });
});

describe("the same fact saved under several Monos", () => {
  const MESSAGE = "What do you remember about writing small commits on a branch?";
  const B = "b-lead";
  const C = "c-lead";
  const SAME = "Writing small commits on every branch";
  const MONTH = 30 * 86_400_000;

  // The turn's own copy is a month older, so it scores a little under the other two: keeping it is the rule
  // at work, not a tie broken by id.
  const own = item(SAME, { updatedAt: NOW - MONTH });
  const inB = item(SAME, { mateId: B });
  const inC = item(SAME, { mateId: C });
  const other1 = item("Remember to write small commits", { mateId: B });
  const other2 = item("Small commits keep every branch reviewable", { mateId: C });
  const store = [own, inB, inC, other1, other2];

  const across = (items: MemoryItem[] = store, extra: Partial<Parameters<typeof recallDecision>[0]> = {}) =>
    decide(items, MESSAGE, { mateIds: [MATE, B, C], ...extra });
  const textsOf = (decision: RecallDecision) =>
    decision.picked.map((id) => store.find((memory) => memory.id === id)!.text);

  it("shows the sentence once and fills the other lines with different facts", () => {
    const decision = across();
    const texts = textsOf(decision);
    expect(decision.broad).toBe(false);
    expect(texts).toHaveLength(3);
    expect(new Set(texts).size).toBe(3);
    expect([...texts].sort()).toEqual([SAME, other1.text, other2.text].sort());
  });

  it("keeps the copy under the Mono the turn belongs to, even when another copy scores higher", () => {
    const decision = across();
    expect(candidateFor(decision, inB.id)!.score).toBeGreaterThan(candidateFor(decision, own.id)!.score);
    expect(decision.picked).toContain(own.id);
    expect(decision.picked).not.toContain(inB.id);
    expect(decision.picked).not.toContain(inC.id);
  });

  it("keeps the best-scoring copy when the turn's own Mono has none", () => {
    const older = item(SAME, { mateId: B, updatedAt: NOW - MONTH });
    const fresh = item(SAME, { mateId: C });
    const decision = across([older, fresh, other1, other2]);
    expect(decision.picked).toContain(fresh.id);
    expect(decision.picked).not.toContain(older.id);
  });

  it("says in the trace that the other copies were left out as copies", () => {
    const decision = across();
    expect(candidateFor(decision, inB.id)).toMatchObject({ picked: false, reason: "duplicate" });
    expect(candidateFor(decision, inC.id)).toMatchObject({ picked: false, reason: "duplicate" });
    expect(tallyRejections(decision).get("duplicate")).toBe(2);
    for (const candidate of decision.candidates) expect(Boolean(candidate.picked) !== Boolean(candidate.reason)).toBe(true);
  });

  it("reads a copy that differs only in case and spacing as the same sentence", () => {
    const spaced = item("  writing  SMALL commits on every   branch ", { mateId: B });
    const decision = across([own, spaced, other1, other2]);
    expect(decision.picked).toContain(own.id);
    expect(candidateFor(decision, spaced.id)!.reason).toBe("duplicate");
  });

  it("does not call two different facts copies of each other", () => {
    const decision = across([own, other1, other2]);
    expect(decision.picked).toHaveLength(3);
    expect(tallyRejections(decision).get("duplicate")).toBeUndefined();
  });

  it("names the copies it left out, so the caller can mark them shown with the line", () => {
    const decision = across();
    expect([...decision.copiesShown].sort()).toEqual([inB.id, inC.id].sort());
  });

  it("does not list a copy of a line that was not shown this turn", () => {
    // Three other facts score as high as the sentence, so the turn shows one line and the sentence waits for a later turn.
    const crowd = [1, 2, 3].map((n) => item(`Writing small commits on every branch of project ${n}`));
    const decision = across([own, inB, ...crowd, other1]);
    expect(candidateFor(decision, own.id)!.reason).toBe("held_back");
    expect(candidateFor(decision, inB.id)!.reason).toBe("duplicate");
    expect(decision.copiesShown).toEqual([]);
  });

  it("never brings a copy back on the turns after, once the caller marks what was shown", () => {
    let shown = new Set<string>();
    const first = across(store, { exclude: shown });
    expect(first.picked).toHaveLength(3);
    shown = new Set([...first.picked, ...first.copiesShown]);
    for (const turn of [2, 3]) {
      const next = across(store, { exclude: shown });
      expect(next.picked, `turn ${turn}`).toEqual([]);
      for (const id of [own.id, inB.id, inC.id]) expect(next.picked).not.toContain(id);
      shown = new Set([...shown, ...next.picked, ...next.copiesShown]);
    }
  });

  it("does not bring a copy back even when the caller only marked the picked ids as shown", () => {
    const first = across();
    const next = across(store, { exclude: new Set(first.picked) });
    expect(next.picked).toEqual([]);
    expect(candidateFor(next, own.id)!.reason).toBe("already_shown");
  });

  it("does not bring a copy back when a copy saved later says what was already shown", () => {
    const later = item(SAME, { mateId: C });
    const next = across([...store, later], { exclude: new Set(across().picked) });
    expect(next.picked).toEqual([]);
    expect(candidateFor(next, later.id)!.reason).not.toBe("held_back");
  });

  it("does not bring a copy back when the copy that was shown has since been deleted", () => {
    const first = across();
    const shown = new Set([...first.picked, ...first.copiesShown]);
    const next = across([inB, inC, other1, other2], { exclude: shown });
    expect(next.picked).not.toContain(inB.id);
    expect(next.picked).not.toContain(inC.id);
  });

  it("dedupes before the crowd rule, so three copies and two facts are not one crowded line", () => {
    const decision = across();
    expect(decision.broad).toBe(false);
  });

  it("still shows the one line when three copies are all there is", () => {
    const decision = across([own, inB, inC]);
    expect(decision.picked).toEqual([own.id]);
    expect(decision.broad).toBe(false);
  });

  it("dedupes an explicit search too", () => {
    const decision = across(store, { mode: "explicit" });
    expect(textsOf(decision).filter((text) => text === SAME)).toHaveLength(1);
  });
});

describe("the lived-day clock inside a decision", () => {
  const MESSAGE = "How do you like to write commit messages for a branch?";
  const OLD = NOW - 20 * 86_400_000;

  it("works out the moment of the decision once, and reads only each memory's last use after that", () => {
    const items = Array.from({ length: 40 }, (_, n) =>
      item(`Commit messages for a branch, number ${n}`, { createdAt: OLD, updatedAt: OLD }),
    );
    const spy = vi.spyOn(LivedClock.prototype, "at");
    try {
      decide(items, MESSAGE);
      const atNow = spy.mock.calls.filter(([moment]) => new Date(moment as Date | number).getTime() === NOW);
      expect(atNow).toHaveLength(1);
      expect(spy).toHaveBeenCalledTimes(items.length + 1);
    } finally {
      spy.mockRestore();
    }
  });
});
