/** A secret the commit guard found on a line of a file. The value is never part of the finding. */
export interface SecretFinding {
  /** The refusal's id: the one thing the Allow button sends. The app keeps what it names. */
  id: string;
  file: string;
  line: number;
  /** The repository the refusal is for, when the app named it. */
  folder: string | null;
  /** The commit the line came from (short), or "none". */
  commit: string;
}

const SECRET_REFUSAL = /^Possible secret in (.+?):(\d+)(?: in (.+?))? \(commit ([0-9a-f]{1,64}|none), refusal ([0-9a-f]{12})\)\. /;

/** The finding a secret refusal names, or undefined for any other message (a commit message, a file name, or none). */
export function secretFinding(message: string): SecretFinding | undefined {
  const match = SECRET_REFUSAL.exec(message);
  if (!match) return undefined;
  const line = Number(match[2]);
  if (!Number.isSafeInteger(line) || line < 1) return undefined;
  return { file: match[1], line, folder: match[3] ?? null, commit: match[4], id: match[5] };
}

const GUARD_REFUSALS = [
  "Possible secret in ",
  "Left out ",
  "Refused to push ",
  "Refused to land ",
  "The secret check did not finish in time",
  "This change is too large for the secret check",
  "The secret check read output",
  "The push's list of refs",
];

/** Whether a message is a refusal the commit guard raised (shown in the guard's own panel, not as an alert). */
export function isGuardRefusal(message: string): boolean {
  return GUARD_REFUSALS.some((start) => message.startsWith(start));
}
