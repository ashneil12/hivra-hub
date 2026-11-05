// WP-84: the prompt for one phase run. No node imports, so the app can use it.

import { phaseBrief, type Run, type Work } from "./machine";

/** The prompt for one phase run. The skill file is included when it is on disk. */
export function phasePrompt(work: Work, run: Run, text?: string): string {
  const parts = [
    `Skill: ${run.skill}`,
    text?.trim() || undefined,
    `Task: ${work.taskId}`,
    run.steering.length > 0 ? `The person's words:\n${run.steering.join("\n")}` : undefined,
    phaseBrief(work),
    run.docNumber != null ? `Edit document ${run.docNumber}. Do not start a new one.` : undefined,
  ];
  return parts.filter((part): part is string => Boolean(part)).join("\n\n");
}
