// SPDX-License-Identifier: Apache-2.0
// Hivra WP-86. The activity log's one sentence. No commit message.

function one(value: string | null | undefined): string {
  return (value ?? "").replace(/[\r\n]+/g, " ").replace(/[\t\f\v ]+/g, " ").trim();
}

/** `commit by <agent> for <task>`. A missing name uses the plain fallback. */
export function commitLine(agent: string | null | undefined, task: string | null | undefined): string {
  const who = one(agent) || "an agent";
  const what = one(task) || "a task";
  return `commit by ${who} for ${what}`;
}
