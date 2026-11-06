// SPDX-License-Identifier: Apache-2.0
// Design: HumanLayer packages/git-attribution attribute-pull-request (Apache-2.0).
// The upstream tree was not in the local sources checkout, so this is a rewrite.

import type { LedgerRow } from "./attribute-commit";

export type PrCredit = {
  agents: string[];
  tasks: { id: string; title: string }[];
};

/**
 * Agents and tasks behind a pull request's commits. A person's commit is
 * skipped. The same sha, agent, or task is listed once, in first-seen order.
 */
export function attributePullRequest(
  rows: readonly LedgerRow[],
  titles: Readonly<Record<string, string>> = {},
): PrCredit {
  const seenSha = new Set<string>();
  const agents: string[] = [];
  const seenAgent = new Set<string>();
  const tasks: { id: string; title: string }[] = [];
  const seenTask = new Set<string>();
  for (const row of rows) {
    if (seenSha.has(row.sha)) continue;
    seenSha.add(row.sha);
    if (row.tier === "person") continue;
    const agent = row.agent?.trim() ?? "";
    if (agent && !seenAgent.has(agent)) {
      seenAgent.add(agent);
      agents.push(agent);
    }
    const task = row.taskId?.trim() ?? "";
    if (task && !seenTask.has(task)) {
      seenTask.add(task);
      tasks.push({ id: task, title: titles[task] ?? task });
    }
  }
  return { agents, tasks };
}
