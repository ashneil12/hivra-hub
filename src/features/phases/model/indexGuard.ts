// WP-84: these skills run only when the first mate names them. They stay out of the always-on index.

export const RPI_SKILL_NAMES = [
  "research-questions",
  "research",
  "design-discussion",
  "implement-outline",
  "create-plan",
  "create-structure-outline",
  "describe-pr",
  "implement-plan",
  "iterate-implementation",
  "iterate-plan",
  "iterate-research-questions",
  "iterate-research",
  "iterate-design",
  "iterate-outline",
  "iterate-product",
  "iterate-technical",
  "product-document",
  "technical-document",
  "review-artifact-comments",
  "diagnosing-bugs",
  "rpi-tdd",
  "grill-me",
] as const;

/** Left out on purpose. Hivra already has its own versions of these. */
export const LEFT_OUT_SKILLS = ["ci-commit", "configure-workspaces", "setup-worktree"] as const;

/** Skills with invokeOnly set are not part of the index a session always reads. */
export function alwaysOnNames(entries: readonly { name?: unknown; invokeOnly?: unknown }[]): string[] {
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry || entry.invokeOnly === true) continue;
    if (typeof entry.name !== "string" || !entry.name.trim()) continue;
    names.push(entry.name);
  }
  return names;
}
