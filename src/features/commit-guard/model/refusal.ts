/** A secret the commit guard found on a line of a file. The value is never part of the finding. */
export interface SecretFinding {
  file: string;
  line: number;
}

const SECRET_REFUSAL = /^Possible secret in (.+):(\d+)\. /;
/** The guard's own name for a finding in a commit message: there is no file line to allow. */
const MESSAGE_FINDING = "a commit message";

/** The file and line a secret refusal names, or undefined for any other message. */
export function secretFinding(message: string): SecretFinding | undefined {
  const match = SECRET_REFUSAL.exec(message);
  if (!match || match[1] === MESSAGE_FINDING) return undefined;
  const line = Number(match[2]);
  if (!Number.isSafeInteger(line) || line < 1) return undefined;
  return { file: match[1], line };
}

const GUARD_REFUSALS = [
  "Possible secret in ",
  "Left out ",
  "Refused to push ",
  "Refused to land ",
  "The secret check did not finish in time",
  "This change is too large for the secret check",
];

/** Whether a message is a refusal the commit guard raised (shown in the guard's own panel, not as an alert). */
export function isGuardRefusal(message: string): boolean {
  return GUARD_REFUSALS.some((start) => message.startsWith(start));
}
