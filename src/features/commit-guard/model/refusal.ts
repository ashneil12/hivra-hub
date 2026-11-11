/** The refusal id a guard refusal message carries, or undefined. The id is only a key: the app's record gives the rest. */
export function refusalId(message: string): string | undefined {
  return /refusal ([0-9a-f]{12})\)\. /.exec(message)?.[1];
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
