// @vitest-environment happy-dom
// WP-242: one switch, two paths. A first mate's skills_learn lesson and the memory curator's skill proposal each go by
// Automatic, Ask first or Off.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.reject(new Error("no app")) }));

import { applyProposal } from "../../memory/model/curator";
import { emptyDoc } from "../../memory/model/doc";
import { sanitizeLesson } from "./lessonSafety";
import { proposeSkill, routeSkillLesson, type SkillRoutePorts } from "./skillRoute";
import { DEFAULT_SKILL_MODE, loadSkillMode, readSkillMode, saveSkillMode, SKILL_MODE_KEY, type SkillMode } from "./skillMode";

const NOW = Date.parse("2026-11-01T09:00:00Z");
const ME = { monoId: "notes-lead", name: "Notes lead" };

function ports(mode: SkillMode) {
  const calls = { learn: 0, propose: 0, dropped: 0 };
  const made: SkillRoutePorts = {
    mode: () => mode,
    prepare: async (lesson) => sanitizeLesson(lesson, ["Ash"]),
    learn: async (input) => {
      calls.learn += 1;
      return { skill: input.skill, lesson: input.lesson };
    },
    propose: async () => {
      calls.propose += 1;
      return true;
    },
    dropped: async () => {
      calls.dropped += 1;
    },
  };
  return { made, calls };
}

beforeEach(() => localStorage.clear());

describe("the setting", () => {
  it("is Automatic unless set, and reads anything unreadable as Automatic", () => {
    expect(DEFAULT_SKILL_MODE).toBe("automatic");
    expect(loadSkillMode()).toBe("automatic");
    saveSkillMode("ask");
    expect(loadSkillMode()).toBe("ask");
    localStorage.setItem(SKILL_MODE_KEY, "nonsense");
    expect(loadSkillMode()).toBe("automatic");
    expect(readSkillMode('"off"')).toBe("off");
    expect(readSkillMode("off")).toBe("off");
  });
});

describe("the skills_learn path", () => {
  const lesson = { skill: "reviewing-a-diff", lesson: "Ask Ash before rewriting a reviewer's comment." };

  it("Automatic writes the lesson at once, cleaned", async () => {
    const { made, calls } = ports("automatic");
    const result = await routeSkillLesson(lesson, ME, made);
    expect(calls).toEqual({ learn: 1, propose: 0, dropped: 0 });
    expect(result).toMatchObject({ lesson: "Ask <name> before rewriting a reviewer's comment." });
  });

  it("Ask first puts it on the Memory screen and writes nothing", async () => {
    const { made, calls } = ports("ask");
    const result = await routeSkillLesson(lesson, ME, made);
    expect(calls).toEqual({ learn: 0, propose: 1, dropped: 0 });
    expect(result).toMatchObject({ saved: false, waiting: true });
  });

  it("Off drops it and counts it", async () => {
    const { made, calls } = ports("off");
    const result = await routeSkillLesson(lesson, ME, made);
    expect(calls).toEqual({ learn: 0, propose: 0, dropped: 1 });
    expect(result).toMatchObject({ saved: false });
  });

  it("refuses a step that sends outside, in a plain line, on every mode that saves", async () => {
    for (const mode of ["automatic", "ask"] as const) {
      const { made, calls } = ports(mode);
      await expect(routeSkillLesson({ skill: "billing", lesson: "Email the invoice to the client." }, ME, made)).rejects.toThrow("sends something outside");
      expect(calls.learn + calls.propose).toBe(0);
    }
  });

  it("the proposal waits as an unreviewed skill, through the curator's own checks", () => {
    const doc = proposeSkill(emptyDoc(), "notes-lead", "reviewing-a-diff", "Read the diff before commenting.", NOW);
    expect(doc.items).toHaveLength(1);
    expect(doc.items[0]).toMatchObject({ action: "skill", state: "unreviewed", skill: { name: "reviewing-a-diff", lesson: "Read the diff before commenting." } });
  });
});

describe("the curator path", () => {
  const ctx = (skills?: SkillMode) => ({
    mateId: "notes-lead",
    turnId: "u1",
    user: "Every release I tag first, then I write the notes from the tag.",
    assistant: "",
    now: NOW,
    ...(skills ? { skills } : {}),
  });
  const skill = { kind: "skill" as const, name: "tagging-a-release", lesson: "Tag first, then write the notes from the tag.", evidence: "I tag first" };

  it("Automatic and Ask first both keep the proposal waiting for the person", () => {
    for (const mode of [undefined, "automatic", "ask"] as const) {
      const { doc } = applyProposal(emptyDoc(), ctx(mode), skill);
      expect(doc.items.map((item) => [item.action, item.state]), String(mode)).toEqual([["skill", "unreviewed"]]);
    }
  });

  it("Off drops it and the health card counts it", () => {
    const { doc, outcome } = applyProposal(emptyDoc(), ctx("off"), skill);
    expect(doc.items).toEqual([]);
    expect(outcome.status).toBe("none");
    expect(doc.health?.skillsDropped).toBe(1);
  });

  it("cleans a proposed lesson, and drops one that sends outside", () => {
    const named = applyProposal(emptyDoc(), { ...ctx(), user: "I always check with ash@example.com first." }, {
      ...skill,
      lesson: "Check with ash@example.com first.",
      evidence: "check with ash@example.com",
    });
    expect(named.doc.items[0]?.skill?.lesson).toBe("Check with <email> first.");
    const sends = applyProposal(emptyDoc(), { ...ctx(), user: "I email the notes to the client." }, { ...skill, lesson: "Email the notes to the client.", evidence: "email the notes" });
    expect(sends.doc.items).toEqual([]);
    expect(sends.outcome).toMatchObject({ status: "dropped", reason: "invalid" });
  });
});
