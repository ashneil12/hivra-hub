// WP-85. Earlier turns are read from the transcript when Hivra was not there for them.
// A path with ".." is not read. A bad line is skipped. A missing file is not a failure.

import { pathAllowed } from "./paths.ts";

export function transcriptAllowed(file: string): boolean {
  return pathAllowed(file);
}

export function loadTranscript(
  file: string,
  read: (file: string) => string,
): { text: string | null; refused: boolean } {
  if (!transcriptAllowed(file)) return { text: null, refused: true };
  try {
    const text = read(file);
    return { text: typeof text === "string" ? text : null, refused: false };
  } catch {
    return { text: null, refused: false };
  }
}

/** Claude JSONL, or our own event lines. Blank lines and broken JSON are skipped. CRLF is fine. */
export function transcriptEvents(text: string): unknown[] {
  const events: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as unknown);
    } catch {
      // One bad line does not drop the rest.
    }
  }
  return events;
}
