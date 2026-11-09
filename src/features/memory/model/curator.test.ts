import { describe, expect, it } from "vitest";
import { curateTurn, freshDoc, settleTurn, type CuratorAsk, type CuratorContext } from "./curator";
import { acceptItem, rejectItem } from "./review";

const NOW = Date.parse("2026-03-01T00:00:00Z");
const SECRET = "sk-ant-api03-abcdefghijklmnopqrst";

function ctx(extra: Partial<CuratorContext> = {}): CuratorContext {
  return {
    mateId: "notes-lead",
    turnId: "turn-1",
    user: "Please keep reviews async. I like small commits.",
    assistant: "I'll keep reviews async.",
    now: NOW,
    ...extra,
  };
}

const ask =
  (text: string) =>
  async (): Promise<CuratorAsk> => ({ ok: true, text });

describe("curateTurn", () => {
  it("stores one unreviewed fact, and ignores a second", async () => {
    const reply = JSON.stringify([
      { kind: "add", text: "Likes small commits", evidence: "I like small commits" },
      { kind: "add", text: "Reviews stay async", evidence: "keep reviews async" },
    ]);
    const result = await curateTurn(freshDoc(), ctx(), ask(reply));
    expect(result.outcome.status).toBe("stored");
    expect(result.doc.items).toHaveLength(1);
    expect(result.doc.items[0]).toMatchObject({ action: "add", state: "unreviewed", text: "Likes small commits" });
    expect(result.doc.doneTurns).toEqual(["notes-lead:turn-1"]);
    const again = await curateTurn(result.doc, ctx(), ask(reply));
    expect(again.doc.items).toHaveLength(1);
    expect(again.outcome.status).toBe("none");
  });

  it("treats an empty reply as no fact, and prose as not a fact", async () => {
    const empty = await curateTurn(freshDoc(), ctx(), ask("  "));
    expect(empty.outcome).toMatchObject({ status: "none" });
    expect(empty.doc.items).toEqual([]);
    expect(empty.doc.doneTurns).toHaveLength(1);
    const prose = await curateTurn(freshDoc(), ctx({ turnId: "turn-2" }), ask("I think they like commits."));
    expect(prose.outcome).toMatchObject({ status: "dropped", reason: "invalid" });
    expect(prose.doc.items).toEqual([]);
  });

  it("keeps a skill as a proposal until the person accepts or rejects it", async () => {
    const reply = JSON.stringify({
      kind: "skill",
      name: "Reviewing a diff",
      lesson: "Read the diff before commenting.",
      evidence: "I like small commits",
    });
    const result = await curateTurn(freshDoc(), ctx(), ask(reply));
    expect(result.doc.items[0]).toMatchObject({ action: "skill", state: "unreviewed", skill: { name: "reviewing-a-diff" } });
    const accepted = acceptItem(result.doc, result.doc.items[0].id, NOW);
    expect(accepted.skill).toEqual({ name: "reviewing-a-diff", lesson: "Read the diff before commenting." });
    expect(accepted.doc.items[0].state).toBe("confirmed");
    const rejected = rejectItem(result.doc, result.doc.items[0].id);
    expect(rejected.items).toEqual([]);
    expect(acceptItem(accepted.doc, result.doc.items[0].id, NOW).skill).toBeUndefined();
  });

  it("does not change a fact when it proposes an update or a removal", async () => {
    const first = await curateTurn(
      freshDoc(),
      ctx(),
      ask(JSON.stringify({ kind: "add", text: "Likes small commits", evidence: "I like small commits" })),
    );
    const id = first.doc.items[0].id;
    const confirmed = acceptItem(first.doc, id, NOW).doc;
    const update = settleTurn(
      confirmed,
      ctx({ turnId: "turn-2" }),
      { kind: "reply", text: JSON.stringify({ kind: "update", targetId: id, text: "Likes tiny commits", evidence: "small commits" }) },
    );
    expect(update.doc.items.find((item) => item.id === id)?.text).toBe("Likes small commits");
    expect(update.doc.items.some((item) => item.action === "update" && item.state === "unreviewed")).toBe(true);
    const removal = settleTurn(
      confirmed,
      ctx({ turnId: "turn-3" }),
      { kind: "reply", text: JSON.stringify({ kind: "remove", targetId: id, evidence: "small commits" }) },
    );
    expect(removal.doc.items.find((item) => item.id === id)?.state).toBe("confirmed");
    expect(removal.doc.items.some((item) => item.action === "remove")).toBe(true);
  });

  it("does not finish the turn when the model times out, is unreachable, or throws", async () => {
    const timeout = await curateTurn(freshDoc(), ctx(), async () => ({ ok: false, kind: "timeout", reason: "slow" }));
    expect(timeout.outcome.status).toBe("deferred");
    expect(timeout.doc.doneTurns).toEqual([]);
    const away = await curateTurn(freshDoc(), ctx(), async () => ({ ok: false, kind: "unreachable", reason: "down" }));
    expect(away.outcome.status).toBe("deferred");
    expect(away.doc.doneTurns).toEqual([]);
    const thrown = await curateTurn(freshDoc(), ctx(), async () => {
      throw new Error("socket");
    });
    expect(thrown.outcome.status).toBe("deferred");
    expect(thrown.doc.doneTurns).toEqual([]);
  });

  it("drops a secret without sending it or storing it", async () => {
    let sent = "";
    const result = await curateTurn(freshDoc(), ctx({ user: `my key is ${SECRET}` }), async (prompt) => {
      sent = prompt;
      return { ok: true, text: JSON.stringify({ kind: "add", text: SECRET, evidence: SECRET }) };
    });
    expect(sent).toBe("");
    expect(result.outcome).toMatchObject({ status: "dropped", reason: "secret" });
    expect(JSON.stringify(result.doc)).not.toContain(SECRET);
    expect(JSON.stringify(result.doc)).not.toContain("sk-ant");
  });

  it("drops a fact whose evidence is not in the turn, and counts a fact it sees again as a use", async () => {
    const madeUp = await curateTurn(
      freshDoc(),
      ctx(),
      ask(JSON.stringify({ kind: "add", text: "Works on Sundays", evidence: "every Sunday" })),
    );
    expect(madeUp.outcome).toMatchObject({ status: "dropped", reason: "ungrounded" });
    expect(madeUp.doc.items).toEqual([]);
    const once = await curateTurn(
      freshDoc(),
      ctx(),
      ask(JSON.stringify({ kind: "add", text: "Likes small commits", evidence: "I like small commits" })),
    );
    const twice = await curateTurn(
      { ...once.doc, doneTurns: [] },
      ctx({ turnId: "turn-9", now: NOW + 86_400_000 }),
      ask(JSON.stringify({ kind: "add", text: "Likes small commits", evidence: "small commits" })),
    );
    // WP-100: the same fact again is a use, so the row is kept, its support grows, and its fade is topped up.
    expect(twice.outcome).toMatchObject({ status: "stored" });
    expect(twice.doc.items).toHaveLength(1);
    expect(twice.doc.items[0]).toMatchObject({
      text: "Likes small commits",
      support: 2,
      fade: 1,
      lastUsedAt: NOW + 86_400_000,
    });
    // The first row's own fields are kept; only the use changes.
    expect(twice.doc.items[0].createdAt).toBe(once.doc.items[0].createdAt);
    expect(twice.doc.items[0].state).toBe(once.doc.items[0].state);
  });

  it("writes down which engine wrote the memory, and leaves it off when the turn had none", async () => {
    const withEngine = await curateTurn(
      freshDoc(),
      ctx({ by: "codex" }),
      ask(JSON.stringify({ kind: "add", text: "Likes small commits", evidence: "I like small commits" })),
    );
    expect(withEngine.doc.items[0].by).toBe("codex");
    const without = await curateTurn(
      freshDoc(),
      ctx({ turnId: "turn-2" }),
      ask(JSON.stringify({ kind: "add", text: "Likes small commits", evidence: "I like small commits" })),
    );
    expect(without.doc.items[0].by).toBeUndefined();
    const nonsense = await curateTurn(
      freshDoc(),
      ctx({ turnId: "turn-3", by: "Codex!" }),
      ask(JSON.stringify({ kind: "add", text: "Likes small commits", evidence: "I like small commits" })),
    );
    expect(nonsense.doc.items[0].by).toBeUndefined();
  });

  it("applies a late reply onto the doc as it is now, still only once", () => {
    const answer = {
      kind: "reply" as const,
      text: JSON.stringify({ kind: "add", text: "Likes small commits", evidence: "I like small commits" }),
    };
    const first = settleTurn(freshDoc(), ctx(), answer);
    const raced = settleTurn(first.doc, ctx(), answer);
    expect(raced.doc.items).toHaveLength(1);
    expect(raced.outcome.status).toBe("none");
  });

  it("keeps the tier that wrote the memory, on every item it writes", async () => {
    const reply = JSON.stringify({ kind: "add", text: "Likes small commits", evidence: "I like small commits" });
    for (const via of ["rules", "cheap", "crew"] as const) {
      const result = await curateTurn(freshDoc(), ctx({ via }), ask(reply));
      expect(result.doc.items[0].via, via).toBe(via);
    }
    // A turn with no tier, or one this build does not know, still keeps the fact and says nothing about the tier.
    expect((await curateTurn(freshDoc(), ctx({ turnId: "no-tier" }), ask(reply))).doc.items[0].via).toBeUndefined();
    const unknown = await curateTurn(freshDoc(), ctx({ turnId: "bad-tier", via: "model" as unknown as "crew" }), ask(reply));
    expect(unknown.doc.items[0]).toMatchObject({ text: "Likes small commits" });
    expect(unknown.doc.items[0].via).toBeUndefined();
    // A skill and an update carry it too.
    const skill = JSON.stringify({
      kind: "skill",
      name: "Reviewing a diff",
      lesson: "Read the diff before commenting.",
      evidence: "I like small commits",
    });
    expect((await curateTurn(freshDoc(), ctx({ via: "cheap" }), ask(skill))).doc.items[0].via).toBe("cheap");
    const first = await curateTurn(freshDoc(), ctx({ via: "rules" }), ask(reply));
    const id = first.doc.items[0].id;
    const update = JSON.stringify({ kind: "update", targetId: id, text: "Likes tiny commits", evidence: "I like small commits" });
    const changed = await curateTurn(first.doc, ctx({ turnId: "turn-2", via: "crew" }), ask(update));
    expect(changed.doc.items.find((item) => item.action === "update")?.via).toBe("crew");
  });
});
