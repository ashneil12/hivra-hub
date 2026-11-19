// WP-240: the explicit path saves at once; the batch reads the person's own messages since a watermark, applies once,
// never rewrites what the person confirmed or edited, and is dropped when memory changed while it ran.
import { describe, expect, it } from "vitest";
import {
  applyBatch,
  BATCH_MAX_TRIES,
  BATCH_SIZE,
  batchPrompt,
  failBatch,
  parseBatchReply,
  planBatches,
  rememberNow,
  rulesBatchReply,
  runBatch,
  type BatchChat,
} from "./batch";
import { emptyDoc, memoryId, parseDoc, type MemoryDoc, type MemoryItem } from "./doc";

const NOW = Date.parse("2026-11-01T09:00:00Z");

function chat(blocks: BatchChat["blocks"], sessionId = "s1", mateId = "notes-lead"): BatchChat {
  return { mateId, sessionId, blocks };
}

const TWO = chat([
  { id: "u1", role: "user", text: "I always review on Friday mornings." },
  { id: "a1", role: "assistant", text: "Noted." },
  { id: "u2", role: "user", text: "We moved the standup to 10am." },
  { id: "a2", role: "assistant", text: "Got it." },
]);

function fact(text: string, extra: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: memoryId(["notes-lead", "add", text.toLowerCase()]),
    mateId: "notes-lead",
    action: "add",
    text,
    state: "unreviewed",
    source: { kind: "turn", ref: "old", label: "old" },
    evidence: text,
    support: 1,
    against: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

/** A tiny store with the app's compare-and-swap: a write lands only on the revision it read. */
function store(initial: MemoryDoc, opts: { loseFirstAck?: boolean } = {}) {
  let disk: MemoryDoc = { ...initial };
  let lose = opts.loseFirstAck ?? false;
  return {
    get: () => disk,
    set: (doc: MemoryDoc) => {
      disk = doc;
    },
    load: async () => parseDoc(JSON.parse(JSON.stringify(disk))) as MemoryDoc,
    save: async (revision: number, next: MemoryDoc) => {
      if (revision !== disk.revision) return false;
      disk = { ...JSON.parse(JSON.stringify(next)), revision: revision + 1 };
      if (lose) {
        // The write landed, but the answer was lost: the caller thinks it failed and tries again.
        lose = false;
        return false;
      }
      return true;
    },
  };
}

describe("planning a batch", () => {
  it("reads the person's messages only, numbered, and nothing past the watermark twice", () => {
    const [plan] = planBatches(emptyDoc(), [TWO]);
    expect(plan.messages.map((message) => [message.m, message.id])).toEqual([
      [1, "u1"],
      [2, "u2"],
    ]);
    expect(plan.marks).toEqual({ "notes-lead:s1": "u2" });
    const moved: MemoryDoc = { ...emptyDoc(), reflected: { "notes-lead:s1": "u2" } };
    expect(planBatches(moved, [TWO])).toEqual([]);
    const half: MemoryDoc = { ...emptyDoc(), reflected: { "notes-lead:s1": "u1" } };
    expect(planBatches(half, [TWO])[0].messages.map((message) => message.id)).toEqual(["u2"]);
  });

  it("reads at most BATCH_SIZE messages a call, and says more are waiting", () => {
    const blocks = Array.from({ length: BATCH_SIZE + 5 }, (_, i) => ({ id: `u${i}`, role: "user", text: `Message number ${i}` }));
    const [plan] = planBatches(emptyDoc(), [chat(blocks)]);
    expect(plan.messages).toHaveLength(BATCH_SIZE);
    expect(plan.more).toBe(true);
    expect(plan.marks["notes-lead:s1"]).toBe(`u${BATCH_SIZE - 1}`);
  });

  it("passes over a secret and a turn already settled, and still moves the watermark past them", () => {
    const doc: MemoryDoc = { ...emptyDoc(), doneTurns: ["notes-lead:a1"] };
    const blocks = [
      { id: "u1", role: "user", text: "Remember that I like tea." },
      { id: "a1", role: "assistant", text: "Saved." },
      { id: "u2", role: "user", text: "my key is sk-ant-api03-abcdefghijklmnopqrst" },
      { id: "a2", role: "assistant", text: "Don't paste keys." },
    ];
    const [plan] = planBatches(doc, [chat(blocks)]);
    expect(plan.messages).toEqual([]);
    expect(plan.marks).toEqual({ "notes-lead:s1": "u2" });
  });

  it("sends only the person's words, never a reply, and says how to cite them", () => {
    const [plan] = planBatches(emptyDoc(), [TWO]);
    const prompt = batchPrompt(plan, [{ id: "mem-0000000000000000", text: "Likes tea" }]);
    expect(prompt).toContain('{"m":1,"text":"I always review on Friday mornings."}');
    expect(prompt).not.toContain("Noted.");
    expect(prompt).toContain("A question, or a what-if, confirms nothing.");
    expect(prompt).toContain("mem-0000000000000000: Likes tea");
  });
});

describe("reading a batch reply", () => {
  it("takes an array, a changes list or one object, and leaves out what it cannot read", () => {
    const one = '{"kind":"add","m":1,"text":"Reviews on Friday","evidence":"review on Friday"}';
    expect(parseBatchReply(`[${one}]`)).toHaveLength(1);
    expect(parseBatchReply(`{"changes":[${one}]}`)).toHaveLength(1);
    expect(parseBatchReply(one)).toHaveLength(1);
    expect(parseBatchReply(`Sure!\n\`\`\`json\n[${one}, {"kind":"add","text":"no m"}]\n\`\`\``)).toHaveLength(1);
    expect(parseBatchReply("not json")).toBeUndefined();
  });
});

describe("applying a batch", () => {
  it("stores a fact grounded in the message it names, with its details, and moves the watermark", () => {
    const [plan] = planBatches(emptyDoc(), [TWO]);
    const reply = JSON.stringify([
      { kind: "add", m: 2, text: "Standup is at 10am", evidence: "moved the standup to 10am", details: { kind: "fact", validFrom: "2026-11-01", entities: ["standup"] } },
      // The evidence is in message 1, not message 2: not grounded.
      { kind: "add", m: 2, text: "Reviews on Friday", evidence: "review on Friday mornings" },
      { kind: "add", m: 9, text: "Nowhere", evidence: "nowhere" },
    ]);
    const { doc, outcomes } = applyBatch(emptyDoc(), plan, reply, { now: NOW, via: "cheap" });
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["stored", "dropped", "dropped"]);
    expect(doc.items).toHaveLength(1);
    expect(doc.items[0]).toMatchObject({ text: "Standup is at 10am", kind: "fact", validFrom: "2026-11-01", entities: ["standup"], state: "unreviewed", support: 1 });
    expect(doc.items[0].source.ref).toBe("u2");
    expect(doc.reflected).toEqual({ "notes-lead:s1": "u2" });
    expect(doc.health?.turns).toBe(2);
  });

  it("a repeat from another message adds support, so a fact said twice is Learned, not a second row", () => {
    const [plan] = planBatches(emptyDoc(), [
      chat([
        { id: "u1", role: "user", text: "I drink tea, not coffee." },
        { id: "u2", role: "user", text: "Like I said, I drink tea." },
      ]),
    ]);
    const reply = JSON.stringify([
      { kind: "add", m: 1, text: "Drinks tea", evidence: "I drink tea" },
      { kind: "add", m: 2, text: "Drinks tea", evidence: "I drink tea" },
      // The same message again is not a second mention.
      { kind: "add", m: 2, text: "Drinks tea", evidence: "drink tea" },
    ]);
    const { doc } = applyBatch(emptyDoc(), plan, reply, { now: NOW });
    expect(doc.items).toHaveLength(1);
    expect(doc.items[0].support).toBe(2);
  });

  it("never rewrites a confirmed or edited fact", () => {
    const confirmed = fact("Reviews on Friday", { state: "confirmed", support: 3 });
    const edited = fact("Standup is at 9am", { state: "edited" });
    const base: MemoryDoc = { ...emptyDoc(), items: [confirmed, edited] };
    const [plan] = planBatches(base, [TWO]);
    const reply = JSON.stringify([
      { kind: "update", m: 2, targetId: edited.id, text: "Standup is at 10am", evidence: "moved the standup to 10am" },
      { kind: "add", m: 1, text: "Reviews on Friday", evidence: "review on Friday", details: { kind: "plan", validTo: "2020-01-01" } },
    ]);
    const { doc } = applyBatch(base, plan, reply, { now: NOW });
    const after = (id: string) => doc.items.find((item) => item.id === id);
    expect(after(edited.id)).toMatchObject({ text: "Standup is at 9am", state: "edited" });
    expect(after(confirmed.id)).toMatchObject({ text: "Reviews on Friday", state: "confirmed" });
    expect(after(confirmed.id)?.kind).toBeUndefined();
    expect(after(confirmed.id)?.validTo).toBeUndefined();
    // The change to the edited fact waits for the person, as a proposal.
    expect(doc.items.some((item) => item.action === "update" && item.state === "unreviewed" && item.targetId === edited.id)).toBe(true);
  });

  it("applies nothing on a doc whose watermark moved since the plan", () => {
    const [plan] = planBatches(emptyDoc(), [TWO]);
    const moved: MemoryDoc = { ...emptyDoc(), reflected: { "notes-lead:s1": "u2" } };
    const reply = JSON.stringify([{ kind: "add", m: 2, text: "Standup is at 10am", evidence: "moved the standup to 10am" }]);
    expect(applyBatch(moved, plan, reply, { now: NOW }).doc).toBe(moved);
  });

  it("the rules tier reads each message with the rules, no model", () => {
    const [plan] = planBatches(emptyDoc(), [chat([{ id: "u1", role: "user", text: "No, that's wrong. I asked for the approved policy." }])]);
    const ops = parseBatchReply(rulesBatchReply(plan)) ?? [];
    expect(ops).toHaveLength(1);
    expect(ops[0].m).toBe(1);
  });
});

describe("running a batch", () => {
  const reply = JSON.stringify([{ kind: "add", m: 2, text: "Standup is at 10am", evidence: "moved the standup to 10am" }]);

  it("applies once when the compare-and-swap answer is lost", async () => {
    const disk = store(emptyDoc(), { loseFirstAck: true });
    const base = await disk.load();
    const [plan] = planBatches(base, [TWO]);
    const run = await runBatch(disk.load, disk.save, plan, base, async () => ({ ok: true, text: reply }), { now: NOW });
    expect(disk.get().items).toHaveLength(1);
    expect(disk.get().items[0].support).toBe(1);
    expect(disk.get().reflected).toEqual({ "notes-lead:s1": "u2" });
    expect(disk.get().revision).toBe(1);
    expect(run.status).toBe("dropped");
    // A second run finds nothing left to read.
    expect(planBatches(await disk.load(), [TWO])).toEqual([]);
  });

  it("drops the batch when memory changed while the model ran", async () => {
    const disk = store(emptyDoc());
    const base = await disk.load();
    const [plan] = planBatches(base, [TWO]);
    const run = await runBatch(
      disk.load,
      disk.save,
      plan,
      base,
      async () => {
        // The person deletes something meanwhile.
        disk.set({ ...disk.get(), revision: disk.get().revision + 1 });
        return { ok: true, text: reply };
      },
      { now: NOW },
    );
    expect(run.status).toBe("dropped");
    expect(disk.get().items).toEqual([]);
    expect(disk.get().reflected).toBeUndefined();
  });

  it("tries a call that gets no answer BATCH_MAX_TRIES times, then passes its messages over", async () => {
    const disk = store(emptyDoc());
    for (let i = 1; i <= BATCH_MAX_TRIES; i++) {
      const base = await disk.load();
      const [plan] = planBatches(base, [TWO]);
      const run = await runBatch(disk.load, disk.save, plan, base, async () => ({ ok: false, kind: "timeout", reason: "slow" }), { now: NOW });
      expect(run.status).toBe("deferred");
      if (i < BATCH_MAX_TRIES) expect(disk.get().batchTries).toBe(i);
    }
    expect(disk.get().batchTries).toBeUndefined();
    expect(disk.get().reflected).toEqual({ "notes-lead:s1": "u2" });
    expect(disk.get().health?.deferred).toBe(BATCH_MAX_TRIES);
  });

  it("failBatch leaves a doc whose watermark moved alone", () => {
    const [plan] = planBatches(emptyDoc(), [TWO]);
    const moved: MemoryDoc = { ...emptyDoc(), reflected: { "notes-lead:s1": "u1" } };
    expect(failBatch(moved, plan, NOW)).toBe(moved);
  });
});

describe("the explicit path", () => {
  const ctx = { mateId: "notes-lead", turnId: "a1", user: "Remember that the deploy window is Tuesday.", assistant: "OK", now: NOW };

  it("saves 'remember that …' at once, as confirmed, with a one-line reply, and marks the turn done", () => {
    const result = rememberNow(emptyDoc(), ctx);
    expect(result.outcome.status).toBe("stored");
    expect(result.doc.items).toHaveLength(1);
    expect(result.doc.items[0]).toMatchObject({ text: "The deploy window is Tuesday.", state: "confirmed", via: "rules" });
    expect(result.reply).toBe("Remembered: The deploy window is Tuesday.");
    expect(result.doc.doneTurns).toEqual(["notes-lead:a1"]);
  });

  it("leaves everything else to the batch", () => {
    const doc = emptyDoc();
    const result = rememberNow(doc, { ...ctx, user: "No, that's wrong. Use the approved policy." });
    expect(result.doc).toBe(doc);
    expect(result.reply).toBeUndefined();
  });
});

describe("an old doc", () => {
  it("loads unchanged, with none of the new fields added", () => {
    const old = {
      revision: 4,
      generation: 2,
      items: [fact("Likes tea", { state: "confirmed" })],
      doneTurns: ["notes-lead:a1"],
      imports: {},
      livedDays: ["2026-10-01"],
    };
    expect(parseDoc(JSON.parse(JSON.stringify(old)))).toEqual(old);
  });
});
