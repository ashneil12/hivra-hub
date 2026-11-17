// The T3 engine's wire to this app (spike): one harness event per line of JSON. Lines that aren't one are dropped, so
// a newer engine can say more without breaking a chat.
import type { HarnessEvent } from "../../core/types";

/** The events in `chunk`'s whole lines; the unfinished last line is `rest` unless the stream has ended. */
export function parseT3Lines(chunk: string, ended: boolean): { events: HarnessEvent[]; rest: string } {
  const lines = chunk.split("\n");
  const rest = ended ? "" : (lines.pop() ?? "");
  const events: HarnessEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string")
        events.push(value as HarnessEvent);
    } catch {
      // Not a whole event: skip it.
    }
  }
  return { events, rest };
}
