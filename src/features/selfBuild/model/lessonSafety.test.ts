// WP-242: a lesson is cleaned before it is saved, a step that sends outside is left out, an edit changes exactly one
// passage, and at most 40 learned skills stay.
import { describe, expect, it } from "vitest";
import { digestOf, evictions, LEARNED_CAP, noteLearned, parseRegistry, type LearnedRegistry } from "./learnedSkills";
import { prepareLesson, replaceOnce, sanitizeLesson, SENDS_OUTSIDE } from "./lessonSafety";

describe("cleaning a lesson", () => {
  it("replaces emails, home paths, account ids and the person's name with placeholders", () => {
    const result = sanitizeLesson(
      "Ask Ash before editing /Users/ash/Projects/site/config.json; billing for cus_9f8e7d6c and order 123456789 goes to ash@example.com, ping @ashl.",
      ["Ash"],
    );
    expect(result).toEqual({
      ok: true,
      lesson: "Ask <name> before editing <home>/Projects/site/config.json; billing for <account id> and order <account id> goes to <email>, ping <name>.",
    });
  });

  it("keeps an ordinary lesson as it is", () => {
    expect(sanitizeLesson("Read the diff before commenting, and keep a 120000 ms timeout.")).toEqual({
      ok: true,
      lesson: "Read the diff before commenting, and keep a 120000 ms timeout.",
    });
    expect(sanitizeLesson("Shared helpers live in src/shared; post-merge, run the tests.").ok).toBe(true);
  });

  it("leaves out a step that sends something outside", () => {
    for (const lesson of ["Email the invoice to the client when it is ready.", "Run the report, then post it to the team channel.", "Share the link with the vendor."]) {
      expect(sanitizeLesson(lesson), lesson).toEqual({ ok: false, reason: SENDS_OUTSIDE });
    }
  });

  it("refuses a lesson that is nothing but personal details", () => {
    expect(sanitizeLesson("ash@example.com").ok).toBe(false);
  });
});

describe("the cheap tier's rewrite", () => {
  it("takes the model's sentence, cleaned again", async () => {
    const result = await prepareLesson("Check with Dana before you merge.", {
      ask: async () => ({ ok: true, text: "Check with <name> before you merge, cc dana@example.com." }),
    });
    expect(result).toEqual({ ok: true, lesson: "Check with <name> before you merge, cc <email>." });
  });

  it("drops what the model says sends outside", async () => {
    const result = await prepareLesson("Forward the summary every Friday.", { ask: async () => ({ ok: true, text: "DROP" }) });
    expect(result).toEqual({ ok: false, reason: SENDS_OUTSIDE });
  });

  it("falls back to the regex pass when the model is off, fails or is late", async () => {
    const regex = sanitizeLesson("Ask ash@example.com first.");
    expect(await prepareLesson("Ask ash@example.com first.")).toEqual(regex);
    expect(await prepareLesson("Ask ash@example.com first.", { ask: async () => ({ ok: false, kind: "timeout", reason: "x" }) })).toEqual(regex);
    const slow = () => new Promise<{ ok: true; text: string }>((resolve) => setTimeout(() => resolve({ ok: true, text: "late" }), 100));
    expect(await prepareLesson("Ask ash@example.com first.", { ask: slow, deadlineMs: 10 })).toEqual(regex);
  });
});

describe("an edit changes exactly one passage", () => {
  const text = "## Lessons\n\n- Read the diff.\n- Run the tests.\n- Read the diff.\n";
  it("refuses none and several, with a plain line", () => {
    expect(replaceOnce(text, "- Ship it.", "- x")).toEqual({ ok: false, reason: "That passage is not in the skill, so nothing was changed." });
    expect(replaceOnce(text, "- Read the diff.", "- x").ok).toBe(false);
  });
  it("changes the one passage that matches", () => {
    expect(replaceOnce(text, "- Run the tests.", "- Run the tests twice.")).toEqual({ ok: true, text: text.replace("- Run the tests.", "- Run the tests twice.") });
  });
});

describe("at most 40 learned skills", () => {
  const files = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`skill-${i}`, `# skill ${i}\n`]));
  const registryFor = (current: Record<string, string>): LearnedRegistry =>
    Object.keys(current).reduce((reg, name, i) => noteLearned(reg, name, 1000 + i, current[name]), {} as LearnedRegistry);

  it("moves out the least recently used first, never the one just written", () => {
    const current = files(LEARNED_CAP + 2);
    const registry = registryFor(current);
    expect(evictions(registry, current, "skill-41").evict).toEqual(["skill-0", "skill-1"]);
    expect(evictions(registry, current, "skill-0").evict).toEqual(["skill-1", "skill-2"]);
  });

  it("never moves one the person edited", () => {
    const current = files(LEARNED_CAP + 1);
    const registry = registryFor(current);
    const edited = { ...current, "skill-0": "# skill 0\n\nMy own note.\n" };
    expect(evictions(registry, edited, "skill-40").evict).toEqual(["skill-1"]);
  });

  it("forgets a skill whose file is gone, and moves nothing while under the cap", () => {
    const current: Record<string, string | undefined> = files(LEARNED_CAP + 1);
    const registry = registryFor(current as Record<string, string>);
    current["skill-3"] = undefined;
    const result = evictions(registry, current, "skill-40");
    expect(result.evict).toEqual([]);
    expect(result.registry["skill-3"]).toBeUndefined();
  });

  it("reads its record as untrusted", () => {
    const good = { usedAt: 5, digest: digestOf("x") };
    expect(parseRegistry(JSON.stringify({ "a-skill": good, "../bad": good, other: { usedAt: "no", digest: "x" } }))).toEqual({ "a-skill": good });
    expect(parseRegistry("not json")).toEqual({});
  });
});
