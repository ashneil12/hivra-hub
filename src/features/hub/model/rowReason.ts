// A Being built row says why it's stuck in plain words. Exit codes, signals, paths and other developer text stay in
// the Lead's chat (Critiquito on the D5 shot, 22 Oct: "Three tries, all exit 7: …" read as a log line).

const WORDS: Record<string, number> = { two: 2, twice: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** Developer text a row never shows: exit codes, signals, errno names, stack traces, paths, code spans, hashes. */
const DEV =
  /\bexit(?:ed)?(?:\s+with)?(?:\s+(?:code|status))?\s*\d+\b|\b(?:exit|status|error)\s+code\s*\d+\b|\bcode\s+\d+\b|\bsignal\s+\w+|\berrno\b|\bstderr\b|\bstdout\b|\bstack\s*trace\b|\btraceback\b|\bpanicked\b|`[^`]*`|(?:^|\s)(?:~|\.{0,2})\/[\w.-]+\/[\w./-]*|\b[0-9a-f]{12,40}\b|\bHTTP\s*\d{3}\b|\b[45]\d\d\b(?=\s*(?:error|status|response))/i;

/** Errno and signal names (ENOSPC, SIGKILL): capitals only, so "email" or "Sign-ups" never count. */
const DEV_NAMES = /\b(?:E[A-Z]{3,}|SIG[A-Z]{2,})\b/;

/** How many times it failed, when the reason says ("Three tries", "crashed 4 times", "failed twice"). */
function timesOf(text: string): number | undefined {
  const m = text.match(/\b(\d+|two|three|four|five|six|seven|eight|nine|ten)\s+(?:tries|times|attempts|retries|runs)\b/i);
  if (m) return /^\d+$/.test(m[1]) ? Number(m[1]) : WORDS[m[1].toLowerCase()];
  if (/\btwice\b/i.test(text)) return 2;
  return undefined;
}

/** The reason line a Being built row shows. Plain reasons pass through; one carrying developer text becomes "Failed 3 times". */
export function rowReason(reason: string | undefined): string {
  const text = (reason ?? "").replace(/^Example: /, "").trim();
  if (!text || !(DEV.test(text) || DEV_NAMES.test(text))) return text;
  const times = timesOf(text);
  return `${times && times > 1 ? `Failed ${times} times` : "It failed"}. The details are in the Lead's chat.`;
}
