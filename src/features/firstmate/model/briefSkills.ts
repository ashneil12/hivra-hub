// WP-41: which pstack skills a brief names, by the kind of work. Names only; the session index has the paths.

export type BriefTask = "code" | "design" | "writing" | "debug" | "measure" | "review";

/** Code changes get the verify and test skills, design work the design ones, and so on. */
export const BRIEF_SKILLS: Record<BriefTask, readonly string[]> = {
  code: [
    "tdd",
    "principle-test-behavior-not-implementation",
    "principle-prove-it-works",
    "show-me-your-work",
  ],
  design: [
    "architect",
    "principle-experience-first",
    "principle-exhaust-the-design-space",
    "principle-type-system-discipline",
    "make-bot-ui",
  ],
  writing: ["technical-writing", "unslop", "principle-minimize-reader-load"],
  debug: ["principle-fix-root-causes", "why", "how"],
  measure: ["benchmark-checklist", "principle-explain-the-number"],
  review: ["interrogate", "correct", "principle-prove-it-works"],
};

const ORDER: { task: BriefTask; pattern: RegExp }[] = [
  { task: "measure", pattern: /\b(?:benchmark|perf|performance|speedup|latency|profil(?:e|ing)|measure)\b/i },
  { task: "design", pattern: /\b(?:design|ui|ux|layout|architect)\b/i },
  { task: "writing", pattern: /\b(?:writ(?:e|ing)|docs|documentation|copy|prose|readme)\b/i },
  { task: "debug", pattern: /\b(?:bugs?|crash|error|failing|broken|debug|fix)\b/i },
  { task: "review", pattern: /\b(?:review|audit|critique)\b/i },
  { task: "code", pattern: /\b(?:code|implement|refactor|change|add|tests?|function|file|\.ts)\b/i },
];

/** The kind of work a brief is, or none when the words don't say. Earlier kinds win. */
export function classifyBriefTask(text: string): BriefTask | undefined {
  const plain = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return ORDER.find((entry) => entry.pattern.test(plain))?.task;
}

/** The brief section for that kind of work. Skill names only, never a path. */
export function briefSkillsSection(task: BriefTask): string | undefined {
  const skills = BRIEF_SKILLS[task];
  if (!skills?.length) return undefined;
  return [
    "## Skills",
    `Read each of these pstack skills and follow it. Their SKILL.md paths are in the pstack index on this session: ${skills.join(", ")}.`,
  ].join("\n");
}
