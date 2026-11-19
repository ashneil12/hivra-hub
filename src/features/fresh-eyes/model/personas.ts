// WP-144: reviewer personas for a plan, before anyone writes code.
// Ideas from google/elephant-goldfish-model (Apache-2.0). These prompts are
// rewritten. No prompt text from that project is included.

export const PERSONAS = ["design-critic", "readiness", "zoom-out"] as const;

export type Persona = (typeof PERSONAS)[number];

/** What one reviewer is asked to break. Each one starts with no earlier context. */
export const PERSONA_BRIEF: Record<Persona, string> = {
  "design-critic":
    "You are a design critic with no earlier context. Read only the plan below. Name a contradiction, a missing definition of done, or a step that cannot be built as written. If the plan holds, reply with exactly NO CONCERNS.",
  readiness:
    "You are checking whether this plan is ready to build. You have no earlier context. Name a missing step, an unstated assumption, or an empty input that would make the work fail. If it is ready, reply with exactly NO CONCERNS.",
  "zoom-out":
    "You are looking at this plan from outside. You have no earlier context. Name a step that solves the wrong problem, or one that makes later work impossible. If the plan is aimed right, reply with exactly NO CONCERNS.",
};

export function personasFor(count: number): Persona[] {
  const n = count === 1 || count === 3 ? count : 2;
  return Array.from({ length: n }, (_, index) => PERSONAS[index % PERSONAS.length]);
}
