import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (..._args: unknown[]) => ({ ok: true, text: "Hello", kind: "ok", reason: "" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
import { defaultBaseUrl } from "../../sessions/model/customModels";
import { loadTextGeneration, saveTextGeneration, TEXT_GENERATION_KEY } from "./textGeneration";
import {
  TEXT_PROMPT_LIMIT,
  TEXT_REPLY_LIMIT,
  TextGenerationError,
  askShortText,
  realTextGenerationPort,
  textFromOutcome,
  textGenerationPort,
  textModelKeyId,
  useTextGenerationPort,
  type SavedTextModel,
  type TextGenerationPort,
  type TextGenerationRequest,
} from "./textGenerationClient";

const SECRET = "sk-ant-api03-abcdefghijklmnopqrst";

const setting = {
  provider: "openrouter" as const,
  model: "google/gemini-2.0-flash",
  baseUrl: defaultBaseUrl("openrouter"),
};

const saved: SavedTextModel = {
  id: "or-1",
  provider: "openrouter",
  baseUrl: setting.baseUrl,
  modelId: setting.model,
};

function mockStorage() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  return storage;
}

function callsOf(reply: (request: TextGenerationRequest) => Promise<string> | string) {
  const calls: TextGenerationRequest[] = [];
  const port: TextGenerationPort & { writeFile: (path: string) => void } = {
    complete: (request) => {
      calls.push(request);
      return Promise.resolve(reply(request));
    },
    writeFile: () => {
      throw new Error("the text client tried to write a file");
    },
  };
  return { calls, port };
}

describe("short text client", () => {
  afterEach(() => {
    useTextGenerationPort(null);
  });

  it("returns the model's text and sends nothing but the ask", async () => {
    const { calls, port } = callsOf(async () => "A short title");
    const text = await askShortText({ setting, prompt: "Name this chat", models: [saved], port });
    expect(text).toBe("A short title");
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!).sort()).toEqual(["baseUrl", "customModelId", "model", "prompt", "provider"]);
    expect(calls[0]).toEqual({
      provider: "openrouter",
      model: setting.model,
      baseUrl: setting.baseUrl,
      customModelId: "or-1",
      prompt: "Name this chat",
    });
    expect(calls[0]).not.toHaveProperty("cwd");
    expect(calls[0]).not.toHaveProperty("tools");
    expect(calls[0]).not.toHaveProperty("path");
  });

  it("never calls a write, even when the port has one", async () => {
    const { port } = callsOf(async () => "ok");
    await askShortText({ setting, prompt: "hello", models: [saved], port });
    expect(() => port.writeFile("/tmp/nope")).toThrow(/tried to write/);
  });

  it("uses the saved model whose address matches, not another copy", async () => {
    const other: SavedTextModel = { ...saved, id: "or-other", baseUrl: "https://other.example/v1" };
    const first: SavedTextModel = { ...saved, id: "or-first" };
    const second: SavedTextModel = { ...saved, id: "or-second" };
    expect(textModelKeyId(setting, [other, second, first])).toBe("or-second");
    const trailing: SavedTextModel = { ...saved, id: "or-slash", baseUrl: `${setting.baseUrl}/` };
    expect(textModelKeyId(setting, [trailing])).toBe("or-slash");
    const badId: SavedTextModel = { ...saved, id: "../keys" };
    expect(textModelKeyId(setting, [badId, other])).toBeNull();
  });

  it("does not ask when no saved model matches, except a local Ollama", async () => {
    const { calls, port } = callsOf(async () => "nope");
    const wrong: SavedTextModel = { ...saved, baseUrl: "https://other.example/v1" };
    await expect(askShortText({ setting, prompt: "hello", models: [wrong], port })).rejects.toMatchObject({
      kind: "refused",
      message: "No key is saved for that model. Add it under Other models.",
    });
    await expect(askShortText({ setting, prompt: "hello", models: [], port })).rejects.toMatchObject({
      kind: "refused",
    });
    expect(calls).toEqual([]);

    const ollama = {
      provider: "ollama" as const,
      model: "llama3.2",
      baseUrl: defaultBaseUrl("ollama"),
    };
    const asked = callsOf(async () => "local");
    await expect(askShortText({ setting: ollama, prompt: "hello", models: [], port: asked.port })).resolves.toBe("local");
    expect(asked.calls[0]?.customModelId).toBe("");
  });

  it("does not send a secret, an empty prompt, or a prompt past the limit", async () => {
    const { calls, port } = callsOf(async () => "nope");
    await expect(askShortText({ setting, prompt: `note ${SECRET}`, models: [saved], port })).rejects.toMatchObject({
      kind: "refused",
    });
    await expect(askShortText({ setting, prompt: "   ", models: [saved], port })).rejects.toMatchObject({
      kind: "refused",
    });
    await expect(
      askShortText({ setting, prompt: "é".repeat(TEXT_PROMPT_LIMIT + 1), models: [saved], port }),
    ).rejects.toMatchObject({ kind: "refused" });
    await expect(
      askShortText({ setting, prompt: "é".repeat(TEXT_PROMPT_LIMIT), models: [saved], port }),
    ).resolves.toBe("nope");
    expect(calls).toHaveLength(1);
    try {
      await askShortText({ setting, prompt: `note ${SECRET}`, models: [saved], port });
    } catch (error) {
      expect(error).toBeInstanceOf(TextGenerationError);
      expect((error as Error).message).not.toContain("sk-ant");
    }
  });

  it("treats a timeout or a dead call as something to try again, and does not clear the setting", async () => {
    mockStorage();
    saveTextGeneration(setting);
    const before = loadTextGeneration();
    const { calls, port } = callsOf(async () => {
      throw new TextGenerationError("The model didn't answer this time. It can be tried again.", "timeout");
    });
    await expect(askShortText({ setting, prompt: "hello", models: [saved], port })).rejects.toMatchObject({
      kind: "timeout",
    });
    const dead = callsOf(async () => {
      throw new Error(`down ${SECRET}`);
    });
    await expect(askShortText({ setting, prompt: "hello", models: [saved], port: dead.port })).rejects.toMatchObject({
      kind: "timeout",
    });
    try {
      await askShortText({ setting, prompt: "hello", models: [saved], port: dead.port });
    } catch (error) {
      expect((error as Error).message).not.toContain("sk-ant");
      expect((error as Error).message).toContain("tried again");
    }
    expect(calls).toHaveLength(1);
    expect(dead.calls).toHaveLength(2);
    expect(loadTextGeneration()).toEqual(before);
    expect(loadTextGeneration()).toEqual(setting);
    expect(JSON.parse(localStorage.getItem(TEXT_GENERATION_KEY) ?? "")).toMatchObject({ provider: "openrouter" });
  });

  it("reports an empty reply, and drops a reply that contains a secret", async () => {
    const empty = callsOf(async () => "  ");
    await expect(askShortText({ setting, prompt: "hello", models: [saved], port: empty.port })).rejects.toMatchObject({
      kind: "empty",
    });
    const leaked = callsOf(async () => `sure ${SECRET}`);
    try {
      await askShortText({ setting, prompt: "hello", models: [saved], port: leaked.port });
      expect.fail("a secret reply should not come back");
    } catch (error) {
      expect(error).toMatchObject({ kind: "timeout" });
      expect((error as Error).message).not.toContain("sk-ant");
    }
  });

  it("cuts a huge reply and does not ask twice", async () => {
    let calls = 0;
    const port: TextGenerationPort = {
      complete: async () => {
        calls += 1;
        return "é".repeat(TEXT_REPLY_LIMIT + 10);
      },
    };
    const text = await askShortText({ setting, prompt: "hello", models: [saved], port });
    expect([...text].length).toBe(TEXT_REPLY_LIMIT);
    expect(calls).toBe(1);
  });

  it("does not ask when the call is already cancelled, and ignores a late reply", async () => {
    const early = callsOf(async () => "nope");
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      askShortText({ setting, prompt: "hello", models: [saved], port: early.port, signal: cancelled.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(early.calls).toEqual([]);

    let release: (value: string) => void = () => {};
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const late = new AbortController();
    const result = askShortText({
      setting,
      prompt: "hello",
      models: [saved],
      port: { complete: () => pending },
      signal: late.signal,
    });
    late.abort();
    release("too late");
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses a setting that does not read back", async () => {
    const { calls, port } = callsOf(async () => "nope");
    const broken = { ...setting, baseUrl: "http://evil.example/v1" };
    await expect(askShortText({ setting: broken, prompt: "hello", models: [saved], port })).rejects.toMatchObject({
      kind: "refused",
    });
    expect(calls).toEqual([]);
  });

  it("reads an outcome without letting a key through", () => {
    expect(textFromOutcome({ ok: true, text: "Hello", kind: "ok", reason: "" })).toBe("Hello");
    expect(() => textFromOutcome({ ok: false, text: "", kind: "timeout", reason: "It can be tried again." })).toThrow(
      TextGenerationError,
    );
    for (const kind of ["timeout", "retryable", "unreachable"]) {
      expect(() => textFromOutcome({ ok: false, text: "", kind, reason: "later" })).toThrowError(
        expect.objectContaining({ kind: "timeout" }),
      );
    }
    expect(() => textFromOutcome({ ok: false, text: "", kind: "refused", reason: "No key is saved." })).toThrowError(
      expect.objectContaining({ kind: "refused", message: "No key is saved." }),
    );
    expect(() => textFromOutcome({ ok: false, text: "", kind: "empty", reason: "" })).toThrowError(
      expect.objectContaining({ kind: "empty" }),
    );
    expect(() => textFromOutcome({ ok: true, text: `x ${SECRET}`, kind: "ok", reason: "" })).toThrowError(
      expect.objectContaining({ kind: "timeout" }),
    );
    try {
      textFromOutcome({ ok: false, text: "", kind: "refused", reason: `bad ${SECRET}` });
    } catch (error) {
      expect((error as Error).message).not.toContain("sk-ant");
      expect((error as TextGenerationError).kind).toBe("refused");
    }
    expect(() => textFromOutcome(null)).toThrowError(expect.objectContaining({ kind: "timeout" }));
    expect(() => textFromOutcome("nope")).toThrowError(expect.objectContaining({ kind: "timeout" }));
  });

  it("saves the route before it asks, and does not ask when that save is refused", async () => {
    invoke.mockReset();
    invoke.mockResolvedValueOnce(undefined);
    invoke.mockResolvedValueOnce({ ok: true, text: "Hello", kind: "ok", reason: "" });
    const request = {
      provider: "xai",
      model: "grok-3",
      baseUrl: "https://api.x.ai/v1",
      customModelId: "text-key",
      prompt: "Say hi",
    };
    await expect(realTextGenerationPort.complete(request)).resolves.toBe("Hello");
    expect(invoke).toHaveBeenNthCalledWith(1, "plugin:hub|text_generation_remember", {
      route: {
        provider: "xai",
        baseUrl: "https://api.x.ai/v1",
        modelId: "grok-3",
        customModelId: "text-key",
      },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "plugin:hub|text_generation_ask", {
      route: {
        provider: "xai",
        baseUrl: "https://api.x.ai/v1",
        modelId: "grok-3",
        customModelId: "text-key",
      },
      prompt: "Say hi",
    });

    invoke.mockReset();
    invoke.mockRejectedValueOnce(new Error("refused"));
    await expect(realTextGenerationPort.complete(request)).rejects.toThrow("refused");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("uses a stand-in port in tests and the real one otherwise", () => {
    expect(textGenerationPort()).toBe(realTextGenerationPort);
    const standIn: TextGenerationPort = { complete: async () => "x" };
    useTextGenerationPort(standIn);
    expect(textGenerationPort()).toBe(standIn);
    useTextGenerationPort(null);
    expect(textGenerationPort()).toBe(realTextGenerationPort);
  });
});
