/** The refusal id a guard refusal message carries, or undefined. The id is only a key: the app's record gives the rest. */
export function refusalId(message: string): string | undefined {
  return /refusal ([0-9a-f]{12})\)\. /.exec(message)?.[1];
}

const GUARD_REFUSALS = [
  "Possible secret in ",
  "Left out ",
  "Refused to push ",
  "Refused to land ",
  "Refused to commit ",
  "The secret check did not finish in time",
  "This change is too large for the secret check",
  "The secret check read output",
  "The push's list of refs",
];

/** Whether a message is a refusal the commit guard raised (shown in the guard's own panel, not as an alert). */
export function isGuardRefusal(message: string): boolean {
  return GUARD_REFUSALS.some((start) => message.startsWith(start));
}

/** What the refusal card says for a recorded refusal (WP-248: a whole tracked approvals file, or one line). */
export interface RefusalWords {
  headline: string;
  why: string;
  button: string;
  allowed: string;
}

/** The card's words for a recorded refusal. A whole-file refusal is a tracked approvals file; Allow keeps it in that one repository. */
export function refusalWords(view: {
  file: string;
  folder: string;
  line: number;
  commit: string;
  wholeFile?: boolean;
}): RefusalWords {
  if (view.wholeFile) {
    return {
      headline: `Blocked: ${view.file} in ${view.folder} is an agent's saved approvals, and this repository tracks it. It can hold passwords typed in commands.`,
      why: `The safe fix is to untrack it (git rm --cached ${view.file}) and change any password it held. Allow it only if this repository must keep it; no other repository or file is allowed.`,
      button: "Allow this file in this repository",
      allowed: "Allowed. This repository may keep this file; its lines are still checked for secrets.",
    };
  }
  return {
    headline: `Blocked: a possible secret is on line ${view.line} of ${view.file} in ${view.folder} (commit ${view.commit}). The value is not shown.`,
    why: "If it is a test value, allow this line. Nothing else in the file is allowed.",
    button: "Allow this line",
    allowed: "Allowed. The next push checks this line again and lets it through.",
  };
}
