import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { learnModelFor } from "./model";
import { chatText } from "./transcript";

const fixture = (name: string) =>
  readFileSync(new URL(`../../historyImport/fixtures/${name}`, import.meta.url), "utf8");

describe("chatText", () => {
  it("reads a Claude Code file as what was said, without tool output or noise", () => {
    const { text, userMessages } = chatText("claude", "sess-1", fixture("claude.jsonl"), 8_000);
    expect(text).toContain("user: I like small commits");
    expect(text).toContain("assistant: Small commits are easier to review.");
    expect(text).not.toContain("TOOL_NOISE_MARKER");
    expect(text).not.toContain("THINKING_NOISE");
    expect(text).not.toContain("META_NOISE");
    expect(userMessages).toBeGreaterThanOrEqual(1);
  });

  it("reads a Codex file the same way", () => {
    const { text, userMessages } = chatText("codex", "codex-1", fixture("codex.jsonl"), 8_000);
    expect(text).toContain("user: Always write the test first");
    expect(text).not.toContain("THOUGHT_NOISE");
    expect(userMessages).toBe(1);
  });

  it("drops a message the secret scan matched", () => {
    const { text } = chatText("claude", "s", fixture("secret-claude.jsonl"), 8_000);
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{10}/);
  });

  it("counts the person's lines in a store the app already rendered", () => {
    const rendered = "user: use pnpm\nassistant: ok\nuser: and no semicolons\ntool bash -> done\n";
    const { text, userMessages } = chatText("pi", "x", rendered, 8_000);
    expect(userMessages).toBe(2);
    expect(text).toContain("user: and no semicolons");
  });

  it("keeps the person's lines when a long chat has to be cut", () => {
    const lines = Array.from({ length: 40 }, (_, index) =>
      JSON.stringify({
        type: "user",
        sessionId: "s",
        timestamp: `2026-01-03T10:${String(index).padStart(2, "0")}:00Z`,
        message: { role: "user", content: `rule number ${index} `.repeat(6) },
      }),
    );
    const { text } = chatText("claude", "s", lines.join("\n"), 600);
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text.startsWith("user: rule number 0")).toBe(true);
  });

  it("says no messages for a file it cannot read", () => {
    expect(chatText("claude", "s", "not json\n{{{", 1_000)).toEqual({ text: "", userMessages: 0 });
  });
});

describe("learnModelFor", () => {
  const route = (cli: string | null) => ({
    cli,
    model: "claude-opus-4-8",
    effort: "high",
    cliFrom: "default" as const,
    modelFrom: "rule" as const,
    effortFrom: "rule" as const,
    ruleIndex: null,
    skipped: [],
  });

  it("names the cheap model for Claude Code, not the model the work would use", () => {
    const picked = learnModelFor(route("claude"));
    expect(picked?.model).toBe("claude-haiku-4-5");
    expect(picked?.label).toContain("claude-haiku-4-5");
  });

  it("says low effort when the CLI has no cheap model listed", () => {
    expect(learnModelFor(route("codex"))?.label).toMatch(/low effort$/);
  });

  it("says nothing when no CLI is signed in", () => {
    expect(learnModelFor(route(null))).toBeNull();
  });
});
