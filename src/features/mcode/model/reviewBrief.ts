// WP-117: a reviewer for a finished diff sees only the diff, the requirement and the test results.
// Nothing here starts a skill. A first mate calls one by name.

/** A diff longer than this is refused whole. A cut diff would look like the whole change. */
export const DIFF_MAX = 200_000;
const REQUIREMENT_MAX = 20_000;
const RESULTS_MAX = 80_000;

/** The three skills. Names stay stable; they are not in the always-on index. */
export const MCODE_SKILL_NAMES = [
  "subagent-split-check",
  "independent-review",
  "taste-to-checks",
] as const;

export type McodeSkillName = (typeof MCODE_SKILL_NAMES)[number];

/**
 * When a first mate may name each skill. Naming is the call. Merge never does it.
 * subagent-split-check: before spawning crew.
 * independent-review: a clean-context review of a finished diff.
 * taste-to-checks: when the same correction has been made twice.
 */
export const MCODE_CALLS: Record<McodeSkillName, string> = {
  "subagent-split-check": "before spawning crew",
  "independent-review": "a clean-context review of a finished diff",
  "taste-to-checks": "when the same correction has been made twice",
};

/** Merge, delivery and the completion gates do not start these skills. */
export const AUTO_RUN_ON_MERGE = false;

function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!text || text.length > max) return undefined;
  return text;
}

/**
 * The brief for independent-review. Extra fields are dropped, including any author conversation.
 * A missing piece, a non-string, or a value over its cap returns nothing: a timeout in the test
 * results is still text and is included, but a blank result is not a result.
 */
export function independentReviewBrief(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const diff = clean(record.diff, DIFF_MAX);
  const requirement = clean(record.requirement, REQUIREMENT_MAX);
  const testResults = clean(record.testResults, RESULTS_MAX);
  if (!diff || !requirement || !testResults) return undefined;
  return [
    "Skill: independent-review",
    "You were not in the author's conversation. Review only the requirement, the diff and the test results below.",
    `## Requirement\n${requirement}`,
    `## Diff\n${diff}`,
    `## Test results\n${testResults}`,
  ].join("\n\n");
}
