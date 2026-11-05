import { describe, expect, it, vi } from "vitest";
import { batchPrompt, sendable } from "./prompt";
import type { Conversation } from "./types";
import type { ModelChoice } from "../ui/HistoryImportPage";
import { importModelAsk } from "./askRoute";

const SECRET = "sk-ant-api03-abcdefghijklmnopqrst";

const conversation: Conversation = {
  id: "sess-1",
  sourceKey: "notes/sess-1.jsonl",
  source: "claude_code",
  project: "notes",
  title: "notes",
  skippedLines: 0,
  secrets: 1,
  messages: [
    {
      conversationId: "sess-1",
      messageId: "m1",
      role: "user",
      content: "I like small commits",
      timestamp: 0,
      secret: false,
    },
    {
      conversationId: "sess-1",
      messageId: "m2",
      role: "assistant",
      content: `The token is ${SECRET}`,
      timestamp: 1,
      secret: true,
    },
  ],
};

const chosen: ModelChoice = {
  id: "local",
  name: "Local",
  provider: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  modelId: "llama3.2",
};

describe("importModelAsk", () => {
  it("gives the sanitised prompt to the signed-in CLI and does not read or store a key", async () => {
    const prompt = batchPrompt(conversation, sendable(conversation.messages));
    expect(prompt).toContain("I like small commits");
    expect(prompt).not.toContain(SECRET);
    const seen: string[] = [];
    const readKey = vi.fn(async () => "sk-live-key-should-not-be-read");
    const storeKey = vi.fn();
    const keyed = vi.fn(async () => {
      await readKey();
      storeKey("sk-live-key-should-not-be-read");
      return { ok: true as const, text: "from a key" };
    });
    const result = await importModelAsk(null, prompt, {
      brief: async (text) => {
        seen.push(text);
        return { ok: true, text: "- Likes small commits [src: sess-1 #m1]" };
      },
      keyed,
      readKey,
      storeKey,
    });
    expect(result).toEqual({ ok: true, text: "- Likes small commits [src: sess-1 #m1]" });
    expect(seen).toEqual([prompt]);
    expect(seen.join("\n")).not.toContain(SECRET);
    expect(keyed).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
    expect(storeKey).not.toHaveBeenCalled();
  });

  it("does not send a secret to the CLI or the key path", async () => {
    const brief = vi.fn();
    const readKey = vi.fn();
    const storeKey = vi.fn();
    const keyed = vi.fn(async () => {
      await readKey();
      return { ok: true as const, text: "sent" };
    });
    const result = await importModelAsk(null, `remember ${SECRET}`, {
      brief,
      keyed,
      readKey,
      storeKey,
    });
    expect(result).toMatchObject({ ok: false, kind: "refused" });
    expect(brief).not.toHaveBeenCalled();
    expect(keyed).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
    expect(storeKey).not.toHaveBeenCalled();
  });

  it("uses a configured model only when one was chosen, and still drops a secret first", async () => {
    const brief = vi.fn();
    const readKey = vi.fn(async () => "ollama-local");
    const keyed = vi.fn(async () => {
      await readKey();
      return { ok: true as const, text: "from the chosen model" };
    });
    const plain = "I like small commits";
    const used = await importModelAsk(chosen, plain, { brief, keyed, readKey });
    expect(used).toEqual({ ok: true, text: "from the chosen model" });
    expect(keyed).toHaveBeenCalledWith(chosen, plain);
    expect(brief).not.toHaveBeenCalled();
    expect(readKey).toHaveBeenCalledOnce();

    readKey.mockClear();
    keyed.mockClear();
    const blocked = await importModelAsk(chosen, `remember ${SECRET}`, { brief, keyed, readKey });
    expect(blocked).toMatchObject({ ok: false, kind: "refused" });
    expect(keyed).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
    expect(brief).not.toHaveBeenCalled();
  });
});
