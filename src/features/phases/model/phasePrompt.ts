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
  outline: "create-structure-outline",
  build: "implement-outline",
} as const;

type PhaseName = keyof typeof SKILL_FOR_PHASE;

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 60_000;

/** The task's own words, as they go in a worker's brief. */
export type TaskText = { title: string; description: string };

/** A task record: its id and the words a phase worker needs. */
export type PhaseTask = TaskText & { id: string };

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim().slice(0, max) : "";
}

/** The words a record carries, trimmed and capped. A record with neither is no text at all. */
export function taskText(value: unknown): TaskText | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const title = clean(record.title, TITLE_MAX);
  const description = clean(record.description, DESCRIPTION_MAX);
  if (!title && !description) return undefined;
  return { title, description };
}

type BriefDoc = { number: number; title: string; body: string };

type PromptWork = {
  taskId: string;
  path: string;
  docs: readonly BriefDoc[];
  /** WP-84: what the task asks, looked up when the run starts. Absent, the worker sees only its id. */
  task?: TaskText;
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

/** The task's id and words. A task the store could not be read for still names its id. */
function taskPart(work: PromptWork): string {
  const lines = [`Task: ${work.taskId}`];
  const title = clean(work.task?.title, TITLE_MAX);
  const description = clean(work.task?.description, DESCRIPTION_MAX);
  if (title) lines.push(`Title: ${title}`);
  if (description) lines.push("", description);
  return lines.join("\n");
}

/** The prompt for one phase run. The skill file is included when it is on disk. */
export function phasePrompt(work: PromptWork, run: PromptRun, text?: string, repo?: string): string {
  const folder = typeof repo === "string" ? repo.trim() : "";
  const parts = [
    PHASE_PREAMBLE,
    folder ? `The code is in ${folder}. That folder is the code, not an artifact directory.` : undefined,
    `Skill: ${run.skill}`,
    text?.trim() || undefined,
    taskPart(work),
    run.steering.length > 0 ? `The person's words:\n${run.steering.join("\n")}` : undefined,
    phaseBrief(work),
    run.docNumber != null ? `Edit document ${run.docNumber}. Do not start a new one.` : undefined,
  ];
  return parts.filter((part): part is string => Boolean(part)).join("\n\n");
}

/** One phase, a task record and the repository. The script prints this and nothing else. */
export function promptForPhase(phase: string, task: PhaseTask, repo: string, skillText?: string): string | undefined {
  const skill = skillNameFor(phase);
  const id = typeof task?.id === "string" ? task.id.trim() : "";
  const words = taskText(task);
  if (!skill || !id || id.length > 80 || !words || typeof repo !== "string" || !repo.trim()) return undefined;
  return phasePrompt(
    { taskId: id, path: "research-plan-build", docs: [], task: words },
    { skill, steering: [] },
    skillText,
    repo.trim(),
  );
}
