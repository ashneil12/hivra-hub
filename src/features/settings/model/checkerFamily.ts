// SC-5: which model family checks a finished task. The rule is the app's own setting (checker_family_rule, kept in the app's
// database; src-tauri/src/firstmate/checker_family.rs), never a project's file.

export const CHECKER_FAMILY_RULES = ["different", "any"] as const;
export type CheckerFamilyRule = (typeof CHECKER_FAMILY_RULES)[number];

/** What the app uses until the person chooses. */
export const DEFAULT_CHECKER_FAMILY_RULE: CheckerFamilyRule = "different";

export const CHECKER_FAMILY_WORDS: Record<CheckerFamilyRule, { label: string; description: string }> = {
  different: {
    label: "A different model family",
    description:
      "A task done on Claude is checked by Codex or Grok, and any other task by Claude. If only one family is signed in, a different model of it checks and the task says so.",
  },
  any: {
    label: "Any model",
    description: "The strongest checker that is signed in, whichever model did the work.",
  },
};

/** A stored or returned word as a rule. Anything this build doesn't know is not one: it is never guessed. */
export function readCheckerFamilyRule(value: unknown): CheckerFamilyRule | null {
  return typeof value === "string" && (CHECKER_FAMILY_RULES as readonly string[]).includes(value)
    ? (value as CheckerFamilyRule)
    : null;
}
