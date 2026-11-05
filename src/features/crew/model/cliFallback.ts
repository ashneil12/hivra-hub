// WP-89: a CLI a Mono, a crew rule or a project set for a worker applies when that CLI is installed. When it isn't,
// the worker keeps the chat's own CLI so the work still starts, but the person is told plainly which CLI was asked
// for and what the worker runs on instead, rather than the setting quietly doing nothing.

import { CLI_ORDER, cliLabel, isCli } from "./clis";

/** "Codex isn't installed here, so this worker runs on Claude Code." Undefined when nothing fell back. */
export function cliFallbackLine(asked: string, runsOn: string): string | undefined {
  if (!isCli(asked) || !isCli(runsOn) || asked === runsOn) return undefined;
  return `${cliLabel(asked)} isn't installed here, so this worker runs on ${cliLabel(runsOn)}.`;
}

/** Every sentence this app writes, for the strict read below. */
const WRITTEN = new Set<string>();
for (const asked of CLI_ORDER) {
  for (const runsOn of CLI_ORDER) {
    const line = cliFallbackLine(asked, runsOn);
    if (line) WRITTEN.add(line);
  }
}

/**
 * The exact sentence this app writes, or undefined. A stored or passed-in value is untrusted: anything else (a
 * truncated line, an unknown CLI, a newline with something after it) is dropped rather than shown on a card.
 */
export function cleanCliFallback(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return WRITTEN.has(text) ? text : undefined;
}
