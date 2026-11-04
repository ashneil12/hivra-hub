// Which reader a file uses. Bad JSON is skipped inside each reader.

import type { Conversation, SourceId, Unit } from "./types";
import { parseClaude } from "./claude";
import { parseCodex } from "./codex";
import { parseHermes } from "./hermes";

export function parseTranscript(source: SourceId, sourceKey: string, text: string): Conversation[] {
  if (source === "claude_code") {
    const one = parseClaude(sourceKey, text);
    return one ? [one] : [];
  }
  if (source === "codex") {
    const one = parseCodex(sourceKey, text);
    return one ? [one] : [];
  }
  return parseHermes(sourceKey, text);
}

/** A file the person asked to read, as run units. An empty file is done; garbage is not. */
export function unitsFrom(source: SourceId, sourceKey: string, text: string): Unit[] {
  if (text.trim() === "") return [{ kind: "empty", source, sourceKey }];
  const found = parseTranscript(source, sourceKey, text);
  if (found.length === 0) return [{ kind: "unreadable", source, sourceKey }];
  return found.map((conversation) => ({ kind: "chat" as const, conversation }));
}
