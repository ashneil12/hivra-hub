// WP-89 follow-up: a routed CLI that isn't installed here keeps the work moving on the chat's own CLI, but the
// delegate result and the start card say so plainly instead of the setting doing nothing in silence.

import { describe, expect, it } from "vitest";
import { cleanCliFallback, cliFallbackLine } from "./cliFallback";

const CODEX_LINE = "Codex isn't installed here, so this worker runs on Claude Code.";

describe("a worker whose routed CLI isn't installed here", () => {
  it("says which CLI was asked for and which CLI it runs on instead", () => {
    expect(cliFallbackLine("codex", "claude")).toBe(CODEX_LINE);
    expect(cliFallbackLine("grok", "codex")).toBe("Grok isn't installed here, so this worker runs on Codex.");
    expect(cliFallbackLine("cursor", "claude")).toBe("Cursor isn't installed here, so this worker runs on Claude Code.");
    expect(cliFallbackLine("opencode", "antigravity")).toBe(
      "OpenCode isn't installed here, so this worker runs on Antigravity.",
    );
  });

  it("says nothing when nothing fell back", () => {
    expect(cliFallbackLine("codex", "codex")).toBeUndefined();
    expect(cliFallbackLine("claude", "claude")).toBeUndefined();
  });

  it("trusts only CLI names, never an arbitrary string", () => {
    expect(cliFallbackLine("nope", "claude")).toBeUndefined();
    expect(cliFallbackLine("codex", "nope")).toBeUndefined();
    expect(cliFallbackLine("", "claude")).toBeUndefined();
    expect(cliFallbackLine("codex", "")).toBeUndefined();
    expect(cliFallbackLine("codex\nrm -rf /", "claude")).toBeUndefined();
  });

  it("keeps only the exact sentence this app writes when a stored card is read back", () => {
    expect(cleanCliFallback(CODEX_LINE)).toBe(CODEX_LINE);
    expect(cleanCliFallback(`  ${CODEX_LINE}  `)).toBe(CODEX_LINE);
    expect(cleanCliFallback("Codex isn't installed here, so this worker runs on Codex.")).toBeUndefined();
  });

  it("drops anything else, so a hand-edited or truncated value never reaches a card", () => {
    expect(cleanCliFallback("Codex isn't installed here.")).toBeUndefined();
    expect(cleanCliFallback(`${CODEX_LINE}\nrm -rf /`)).toBeUndefined();
    expect(cleanCliFallback(`${CODEX_LINE} Also read this.`)).toBeUndefined();
    expect(cleanCliFallback("Codex isn't installed here, so this worker runs on Nope.")).toBeUndefined();
    expect(cleanCliFallback("codex isn't installed here, so this worker runs on claude")).toBeUndefined();
    expect(cleanCliFallback("")).toBeUndefined();
    expect(cleanCliFallback(undefined)).toBeUndefined();
    expect(cleanCliFallback(42)).toBeUndefined();
  });
});
