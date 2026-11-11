// WP-242: where a first mate's `skills_learn` lesson goes, by the one setting in Settings > Memory.
//   Automatic: into the skill at once, with Undo in Bot changes (today's behaviour).
//   Ask first: onto the Memory screen as a skill proposal, which writes the lesson only when the person accepts it.
//   Off: nowhere; the Memory screen's health card counts it.
// Every lesson is prepared first (lessonSafety.ts): the cheap model's rewrite when that tier is on, the regex pass
// always.

import { applyProposal } from "../../memory/model/curator";
import type { MemoryDoc } from "../../memory/model/doc";
import { noteSkillDropped } from "../../memory/model/health";
import { cheapAsk, cheapProblem } from "../../memory/model/cheapAsk";
import { loadMemoryDoc, saveMemoryDoc } from "../../memory/model/memoryStore";
import { commitDoc } from "../../memory/model/review";
import { loadMemoryTier } from "../../memory/model/tier";
import { isValidSkillName, slugSkillName } from "../../skills/model/skills";
import { forUser, userName } from "../../hub/model/userName";
import { prepareLesson, type LessonCheck } from "./lessonSafety";
import { learnSkillLesson } from "./skillLearn";
import { loadSkillMode, type SkillMode } from "./skillMode";

export type SkillLessonInput = { skill: string; lesson: string; from?: string; replace?: string };

export type SkillRoutePorts = {
  mode: () => SkillMode;
  prepare: (lesson: string) => Promise<LessonCheck>;
  learn: (input: SkillLessonInput & { by: string }) => Promise<unknown>;
  /** Puts the lesson on the Memory screen for the person's Accept. False when it could not be saved. */
  propose: (mateId: string, skill: string, lesson: string) => Promise<boolean>;
  /** Counts one dropped lesson on the health card. */
  dropped: () => Promise<void>;
};

/** The doc with this lesson waiting as a skill proposal for this first mate, by the curator's own checks. */
export function proposeSkill(doc: MemoryDoc, mateId: string, skill: string, lesson: string, now: number): MemoryDoc {
  return applyProposal(
    doc,
    { mateId, turnId: `lesson-${now}`, user: lesson, assistant: "", now, skills: "ask" },
    { kind: "skill", name: skill, lesson, evidence: lesson },
  ).doc;
}

export async function routeSkillLesson(input: SkillLessonInput, me: { monoId: string; name: string }, ports: SkillRoutePorts): Promise<unknown> {
  const mode = ports.mode();
  if (mode === "off") {
    try {
      await ports.dropped();
    } catch {
      // The count is a nicety; the answer is the same.
    }
    return { saved: false, note: forUser("Skill learning is off in Settings → Memory, so that lesson was not saved. Tell Ash in one line if it matters.") };
  }
  const skill = slugSkillName(input.skill);
  if (!isValidSkillName(skill)) throw new Error('skill must be lowercase letters, numbers and hyphens, like "reviewing-a-diff".');
  // One plain sentence, as skillLearn.plainLesson makes it (not imported: tests stand that module in).
  const plain = input.lesson
    .replace(/\s+/g, " ")
    .replace(/^[-*•\d.\s]+/, "")
    .trim()
    .slice(0, 400);
  if (!plain) throw new Error(forUser("lesson must be the one plain sentence to keep, in Ash's words where you can."));
  const prepared = await ports.prepare(plain);
  if (!prepared.ok) throw new Error(prepared.reason);
  if (mode === "ask") {
    if (input.replace !== undefined) throw new Error(forUser("With skill learning on Ask first, a lesson can only be proposed, not changed in place. Send it without replace."));
    const saved = await ports.propose(me.monoId, skill, prepared.lesson);
    if (!saved) throw new Error("That lesson could not be put up for Ash this time. Try again later.");
    return { saved: false, waiting: true, skill, lesson: prepared.lesson, note: forUser("It waits in Settings → Memory for Ash to accept; nothing is in the skill yet.") };
  }
  return ports.learn({ ...input, skill, lesson: prepared.lesson, by: me.name });
}

/** The ports the app uses: the saved setting, the cheap model when that tier is on, the real skill file and memory. */
export function realSkillPorts(): SkillRoutePorts {
  return {
    mode: loadSkillMode,
    prepare: (lesson) => {
      const tier = loadMemoryTier();
      const ask = tier.tier === "cheap" && tier.model && !cheapProblem(tier.model) ? cheapAsk(tier.model) : undefined;
      const name = userName();
      return prepareLesson(lesson, { ...(ask ? { ask } : {}), names: name ? [name] : [] });
    },
    learn: (input) => learnSkillLesson(input),
    propose: async (mateId, skill, lesson) => {
      const now = Date.now();
      const result = await commitDoc(loadMemoryDoc, saveMemoryDoc, (doc) => proposeSkill(doc, mateId, skill, lesson, now));
      return result.applied || result.doc.items.some((item) => item.action === "skill" && item.skill?.name === skill && item.skill.lesson === lesson);
    },
    dropped: async () => {
      await commitDoc(loadMemoryDoc, saveMemoryDoc, noteSkillDropped);
    },
  };
}
