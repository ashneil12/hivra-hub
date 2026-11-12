import { describe, expect, it } from "vitest";
import { parseClaude } from "../../historyImport/model/claude";
import { parseCodex } from "../../historyImport/model/codex";
import { chatTitle, importedChatId, toImportedChat } from "./convert";
import type { IndexedChat } from "./plan";

const CLAUDE = [
  JSON.stringify({ type: "user", sessionId: "abc-123", cwd: "/p/app", timestamp: "2026-01-03T10:00:00Z", message: { role: "user", content: `Example: fix the login\n${"x".repeat(12_000)}` } }),
  JSON.stringify({ type: "assistant", sessionId: "abc-123", cwd: "/p/app", timestamp: "2026-01-03T10:01:00Z", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }),
  JSON.stringify({ type: "user", sessionId: "abc-123", cwd: "/p/app", timestamp: "2026-01-03T10:02:00Z", message: { role: "user", content: "Thanks" } }),
].join("\n");

const CODEX = [
  JSON.stringify({ type: "session_meta", timestamp: "2026-02-01T00:00:00Z", payload: { id: "codex-1", cwd: "/p/hub" } }),
  JSON.stringify({ type: "event_msg", timestamp: "2026-02-01T00:01:00Z", payload: { type: "user_message", message: "Example: tests first" } }),
  JSON.stringify({ type: "event_msg", timestamp: "2026-02-01T00:02:00Z", payload: { type: "agent_message", message: "Old Codex answer with no phase." } }),
].join("\n");

const indexed = (extra: Partial<IndexedChat>): IndexedChat => ({
  source: "claude_code",
  root: "/r",
  path: "x/abc-123.jsonl",
  bytes: 1,
  mtimeMs: Date.parse("2026-01-03T10:05:00Z"),
  sessionId: "abc-123",
  ...extra,
});

describe("an imported chat", () => {
  it("keeps whole messages, its real times and resumes Claude in its own folder", () => {
    const conversation = parseClaude("x/abc-123.jsonl", CLAUDE, true)!;
    const made = toImportedChat(conversation, indexed({}), "/p/app")!;
    expect(made.session.id).toBe("imp-claude-abc-123");
    expect(made.session.harness).toBe("claude");
    expect(made.session.cwd).toBe("/p/app");
    expect(made.session.providerSessionId).toBe("abc-123");
    expect(made.session.moveBriefOwed).toBeUndefined();
    expect(made.session.blocks.map((block) => block.role)).toEqual(["user", "assistant", "user"]);
    expect(made.session.blocks[0].text.length).toBeGreaterThan(12_000);
    expect(made.session.title).toBe("Example: fix the login");
    expect(made.createdAt).toBe(Date.parse("2026-01-03T10:00:00Z"));
    expect(made.updatedAt).toBe(Date.parse("2026-01-03T10:05:00Z"));
  });

  it("moved into another folder, carries the chat so far instead of resuming", () => {
    const conversation = parseClaude("x/abc-123.jsonl", CLAUDE, true)!;
    const made = toImportedChat(conversation, indexed({}), "/p/app-v2")!;
    expect(made.session.providerSessionId).toBeUndefined();
    expect(made.session.moveBriefOwed).toBe(true);
    expect(made.session.movedFrom).toBe("Claude Code");
  });

  it("a Codex chat keeps an answer with no phase and carries the chat so far", () => {
    const conversation = parseCodex("y/codex-1.jsonl", CODEX, true)!;
    const made = toImportedChat(conversation, indexed({ source: "codex", sessionId: "codex-1", path: "y/codex-1.jsonl" }), "/p/hub")!;
    expect(made.session.harness).toBe("codex");
    expect(made.session.blocks.map((block) => block.text)).toEqual(["Example: tests first", "Old Codex answer with no phase."]);
    expect(made.session.moveBriefOwed).toBe(true);
    expect(made.session.movedFrom).toBe("Codex");
    expect(parseCodex("y/codex-1.jsonl", CODEX)!.messages).toHaveLength(1);
  });

  it("gets the same safe id every time", () => {
    expect(importedChatId("codex", { sessionId: "a/b:c", path: "p" })).toMatch(/^imp-codex-[A-Za-z0-9_-]+$/);
    expect(importedChatId("claude_code", { path: "dir/some file.jsonl" })).toBe(importedChatId("claude_code", { path: "dir/some file.jsonl" }));
    expect(importedChatId("claude_code", { path: "a.jsonl" })).not.toBe(importedChatId("claude_code", { path: "b.jsonl" }));
  });

  it("a chat with nothing the person said is not made", () => {
    const only = JSON.stringify({ type: "assistant", sessionId: "s", timestamp: "2026-01-03T10:01:00Z", message: { role: "assistant", content: "Hi" } });
    expect(toImportedChat(parseClaude("s.jsonl", only, true)!, indexed({}), "/p/app")).toBeNull();
    expect(chatTitle({ ...parseClaude("x.jsonl", CLAUDE, true)!, title: "Saved" }, {})).toBe("Saved");
  });
});
