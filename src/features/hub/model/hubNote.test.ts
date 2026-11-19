// WP-04 review: the soul, hub note and delegate rules go on Claude Code's system prompt. That used to hang on "has the
// Ash OS tools"; with those retired it must hang on the engine alone, or every Claude Code Mono loses its soul.
import { describe, expect, it } from "vitest";
import { appendsHubNote } from "./hubNote";

describe("which chats get the hub note on their system prompt", () => {
  it("is Claude Code, unless the message is a raw slash command", () => {
    expect(appendsHubNote("claude")).toBe(true);
    expect(appendsHubNote("claude", true)).toBe(false);
  });

  it("is no other engine: they read it ahead of the message", () => {
    for (const harness of ["codex", "hermes", "opencode", "gemini"]) expect(appendsHubNote(harness)).toBe(false);
  });
});
