/**
 * Notices the CLI prints about itself, not about Ash's work. r63 (PM's C7 on 0.16.3): Claude Code's "We're changing
 * auto mode to no longer charge for classifier requests … your requests go through 127.0.0.1:<port> …" arrived as a
 * system status line and was saved as a block in every Mono chat. It names a local port and a billing change that
 * doesn't apply to the bridges, so it is harness noise: never shown, never saved.
 */
const CLI_NOTICES: RegExp[] = [
  /auto mode to no longer charge for classifier requests/i,
  /auto-mode-classifier-billing/i,
];

export function isCliNotice(text: string | undefined | null): boolean {
  if (!text) return false;
  return CLI_NOTICES.some((re) => re.test(text));
}
