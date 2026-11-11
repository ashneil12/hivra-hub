import { describe, expect, it } from "vitest";
import type { Session } from "../../sessions/model/session";
import { recapChatFrom } from "./teleportRecap";

const session = (): Session =>
  ({
    id: "old-chat",
    harness: "claude",
    model: "test-model-1",
    modelSettings: { effort: "high" },
    runtimeMode: "default",
    title: "Parser work",
    cwd: "/projects/parser",
    blocks: [
      { id: "b1", role: "user", text: "Please fix the parser" },
      { id: "b2", role: "assistant", text: "Fixed the tokenizer edge case" },
    ],
  }) as unknown as Session;

describe("WP-177 recap into a new chat", () => {
  it("starts a new chat whose first message is the deterministic handoff brief", () => {
    const next = recapChatFrom(session());
    expect(next.id).not.toBe("old-chat");
    expect(next.cwd).toBe("/projects/parser");
    expect(next.harness).toBe("claude");
    expect(next.title).toBe("Recap of Parser work");
    expect(next.blocks).toHaveLength(1);
    expect(next.blocks[0].role).toBe("user");
    expect(next.blocks[0].text).toContain("Please fix the parser");
    expect(next.blocks[0].text).toContain("Fixed the tokenizer edge case");
  });

  it("two recaps of one chat make two different new chats", () => {
    expect(recapChatFrom(session()).id).not.toBe(recapChatFrom(session()).id);
  });
});

describe("WP-177 recap button", () => {
  it("saves the new chat and opens it, and the old chat is left as it was", async () => {
    const { startRecapChat } = await import("./teleportRecap");
    const saved: Session[] = [];
    const opened: string[] = [];
    const old = session();
    const next = await startRecapChat(old, {
      save: async (s) => {
        saved.push(s);
      },
      open: (id) => opened.push(id),
    });
    expect(saved).toEqual([next]);
    expect(opened).toEqual([next.id]);
    expect(old.blocks).toHaveLength(2);
  });
});
