// WP-84: the prompt for one phase run. No node imports, so the app can use it.

/** These rules win over a skill that expects an artifact directory and a person waiting in the chat. */
export const PHASE_PREAMBLE = [
  "Hivra runs this phase. These rules win when the skill disagrees.",
  "There is no artifact directory, no ticket.md and no task.md.",
  "The query is the task, the person's words and the earlier documents.",
  "Never wait for the user. Put open questions in the document instead.",
  "When the skill says to ask the user which one, do not ask.",
  "The reply is the document.",
].join("\n");

export const SKILL_FOR_PHASE = {
  product: "product-document",
  technical: "technical-document",
  "research-questions": "research-questions",
  research: "research",
  design: "design-discussion",
  outline: "implement-outline",
  build: "implement-outline",
} as const;

type PhaseName = keyof typeof SKILL_FOR_PHASE;

type BriefDoc = { number: number; title: string; body: string };

type PromptWork = {
  taskId: string;
  path: string;
  docs: readonly BriefDoc[];
};

type PromptRun = {
  skill: string;
  steering: readonly string[];
  docNumber?: number;
};

/** A phase id, or a skill name. A path is not a skill. */
export function skillNameFor(phase: string): string | undefined {
  if (typeof phase !== "string") return undefined;
  const name = phase.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(name)) return undefined;
  if (Object.prototype.hasOwnProperty.call(SKILL_FOR_PHASE, name)) return SKILL_FOR_PHASE[name as PhaseName];
  return name;
}

/** For a phased task, these documents are the brief. A straight build keeps today's brief. */
export function phaseBrief(work: { path: string; docs: readonly BriefDoc[] }): string | undefined {
  if (work.path === "straight" || work.docs.length === 0) return undefined;
  return [...work.docs]
    .sort((a, b) => a.number - b.number)
    .map((doc) => `## ${doc.title}\n${doc.body}`)
    .join("\n\n");
}

/** The prompt for one phase run. The skill file is included when it is on disk. */
export function phasePrompt(work: PromptWork, run: PromptRun, text?: string, repo?: string): string {
  const folder = typeof repo === "string" ? repo.trim() : "";
  const parts = [
    PHASE_PREAMBLE,
    folder ? `The code is in ${folder}. That folder is the code, not an artifact directory.` : undefined,
    `Skill: ${run.skill}`,
    text?.trim() || undefined,
    `Task: ${work.taskId}`,
    run.steering.length > 0 ? `The person's words:\n${run.steering.join("\n")}` : undefined,
    phaseBrief(work),
    run.docNumber != null ? `Edit document ${run.docNumber}. Do not start a new one.` : undefined,
  ];
  return parts.filter((part): part is string => Boolean(part)).join("\n\n");
}

/** One phase, the task text and the repository. The script prints this and nothing else. */
export function promptForPhase(phase: string, task: string, repo: string, skillText?: string): string | undefined {
  const skill = skillNameFor(phase);
  if (!skill || typeof task !== "string" || !task.trim() || typeof repo !== "string" || !repo.trim()) return undefined;
  return phasePrompt({ taskId: task.trim(), path: "research-plan-build", docs: [] }, { skill, steering: [] }, skillText, repo.trim());
}
