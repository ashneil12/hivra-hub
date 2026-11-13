// PT-4: when the running checker runs. The rule is the app's own setting (checker_when_rule, kept in the app's database beside
// checker_family_rule; src-tauri/src/firstmate/checker_when.rs), never a project's file. The words match the Rust side's
// `WhenRule::word`, and a test keeps them from drifting apart.

export const CHECKER_WHEN_RULES = ["follow-mode", "every-code-change", "risky-only", "off"] as const;
export type CheckerWhenRule = (typeof CHECKER_WHEN_RULES)[number];

/** What a person who never chose gets: the running checker follows each project's testing mode. One constant. */
export const DEFAULT_CHECKER_WHEN_RULE: CheckerWhenRule = "follow-mode";

/** One plain line under each choice. The longer explanation is behind More. */
export const CHECKER_WHEN_WORDS: Record<CheckerWhenRule, { label: string; description: string }> = {
  "follow-mode": {
    label: "Follow the testing mode",
    description: "Full checks every code change. Test at ship and Light check risky changes only. The ship check always has it.",
  },
  "every-code-change": {
    label: "Every code change",
    description: "Every code change gets it, in every mode but No testing, and so does the ship check.",
  },
  "risky-only": {
    label: "Only risky changes",
    description: "Only a change to a protected or security path gets it. The ship check keeps the quick review.",
  },
  off: {
    label: "Off",
    description: "Only the quick one-turn check, everywhere.",
  },
};

/** The heading and the one line under it. */
export const CHECKER_WHEN_TITLE = "When the checker runs";
export const CHECKER_WHEN_HINT = "The checker is a model from another family that re-runs a task's checks on a read-only copy.";

/** Behind More: what it costs and what it never overrides. */
export const CHECKER_WHEN_DETAILS =
  "Each task it checks takes about two model calls from another family, and the ship check takes the same once for everything that landed. A risky change is one to a protected or security path. No testing never runs the checker, whatever you pick here. Who the checker is comes from Who checks the work.";

/** A stored or returned word as a rule. Anything this build doesn't know is not one: it is never guessed. */
export function readCheckerWhenRule(value: unknown): CheckerWhenRule | null {
  return typeof value === "string" && (CHECKER_WHEN_RULES as readonly string[]).includes(value)
    ? (value as CheckerWhenRule)
    : null;
}
