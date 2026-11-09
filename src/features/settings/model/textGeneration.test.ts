import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultBaseUrl, defaultModelId } from "../../sessions/model/customModels";
import {
  TEXT_GENERATION_CHANGE_EVENT,
  TEXT_GENERATION_KEY,
  loadTextGeneration,
  readTextGeneration,
  saveTextGeneration,
  snapshotTextGeneration,
  subscribeTextGeneration,
} from "./textGeneration";

function mockLocalStorage() {
  const data = new Map<string, string>();
  const writes: string[] = [];
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push(`set ${key}`);
      data.set(key, value);
    },
    removeItem: (key: string) => {
      writes.push(`remove ${key}`);
      data.delete(key);
    },
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
    writes,
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
  return storage;
}

const openRouter = {
  provider: "openrouter" as const,
  model: "google/gemini-2.0-flash",
  baseUrl: defaultBaseUrl("openrouter"),
};

describe("text generation setting", () => {
  let storage: ReturnType<typeof mockLocalStorage>;

  beforeEach(() => {
    storage = mockLocalStorage();
    vi.stubGlobal("window", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is missing until someone picks a provider and a model", () => {
    expect(loadTextGeneration()).toBeNull();
    expect(snapshotTextGeneration()).toBeNull();
    expect(storage.writes).toEqual([]);
  });

  it("round-trips a provider, model and address, and nothing else", () => {
    saveTextGeneration(openRouter);
    expect(loadTextGeneration()).toEqual(openRouter);
    const stored = JSON.parse(storage.getItem(TEXT_GENERATION_KEY) ?? "");
    expect(stored).toEqual({ v: 2, ...openRouter });
    expect(Object.keys(stored).sort()).toEqual(["baseUrl", "model", "provider", "v"]);
  });

  it("keeps the same object until the stored text changes", () => {
    saveTextGeneration(openRouter);
    const first = snapshotTextGeneration();
    expect(snapshotTextGeneration()).toBe(first);
    saveTextGeneration({ ...openRouter, model: "other/model" });
    expect(snapshotTextGeneration()).not.toBe(first);
    expect(snapshotTextGeneration()?.model).toBe("other/model");
  });

  it("refuses an invalid save and leaves the previous value", () => {
    saveTextGeneration(openRouter);
    saveTextGeneration({ provider: "openrouter", model: "has a space", baseUrl: openRouter.baseUrl });
    expect(loadTextGeneration()).toEqual(openRouter);
  });

  it("clears back to the coding-agent path", () => {
    saveTextGeneration(openRouter);
    saveTextGeneration(null);
    expect(loadTextGeneration()).toBeNull();
    expect(storage.getItem(TEXT_GENERATION_KEY)).toBeNull();
  });

  it("does not throw when storage is blocked", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    expect(loadTextGeneration()).toBeNull();
    expect(() => saveTextGeneration(openRouter)).not.toThrow();
    expect(() => saveTextGeneration(null)).not.toThrow();
  });

  it("does not write when a save hits a full quota", () => {
    saveTextGeneration(openRouter);
    const data = new Map<string, string>([[TEXT_GENERATION_KEY, storage.getItem(TEXT_GENERATION_KEY)!]]);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: () => {
          throw new Error("quota");
        },
        removeItem: () => {
          throw new Error("quota");
        },
      },
    });
    expect(() => saveTextGeneration(null)).not.toThrow();
    expect(loadTextGeneration()).toEqual(openRouter);
  });

  it("tells this window and other windows", () => {
    const listeners: Record<string, ((event: Event) => void)[]> = {};
    const fakeWindow = {
      addEventListener: (type: string, listener: (event: Event) => void) => {
        (listeners[type] ??= []).push(listener);
      },
      removeEventListener: (type: string, listener: (event: Event) => void) => {
        listeners[type] = (listeners[type] ?? []).filter((each) => each !== listener);
      },
      dispatchEvent: (event: Event) => {
        for (const listener of listeners[event.type] ?? []) listener(event);
        return true;
      },
    };
    vi.stubGlobal("window", fakeWindow);
    const seen: Array<string | null> = [];
    const stop = subscribeTextGeneration(() => seen.push(loadTextGeneration()?.model ?? null));
    saveTextGeneration(openRouter);
    storage.setItem(TEXT_GENERATION_KEY, JSON.stringify({ v: 2, ...openRouter, model: "other/model" }));
    fakeWindow.dispatchEvent(Object.assign(new Event("storage"), { key: TEXT_GENERATION_KEY }));
    fakeWindow.dispatchEvent(Object.assign(new Event("storage"), { key: "monocode.other" }));
    stop();
    saveTextGeneration(null);
    expect(seen).toEqual([openRouter.model, "other/model"]);
  });
});

describe("text generation migration", () => {
  beforeEach(() => {
    mockLocalStorage();
  });

  it("reads nothing for empty, broken and non-object values", () => {
    for (const raw of [null, undefined, "", "   ", "not-json", "null", "[]", "42", "\"just-a-model\"", {}]) {
      expect(readTextGeneration(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it("migrates a version 1 modelId and fills the provider address", () => {
    expect(storageWrites(() => readTextGeneration({
      v: 1,
      provider: "openrouter",
      modelId: "google/gemini-2.0-flash",
    }))).toEqual(openRouter);
  });

  it("migrates a stored JSON string, including one encoded twice, without writing", () => {
    const once = JSON.stringify({ provider: "deepseek", modelId: "deepseek-chat" });
    const twice = JSON.stringify(once);
    const expected = {
      provider: "deepseek",
      model: "deepseek-chat",
      baseUrl: defaultBaseUrl("deepseek"),
    };
    expect(readTextGeneration(once)).toEqual(expected);
    expect(readTextGeneration(twice)).toEqual(expected);
    expect(readTextGeneration(`\uFEFF${once}`)).toEqual(expected);
  });

  it("drops a key and never returns it", () => {
    const secret = "sk-test-secret-value-1234";
    const read = readTextGeneration({
      v: 1,
      provider: "xai",
      modelId: defaultModelId("xai"),
      apiKey: secret,
      token: secret,
    });
    expect(read?.provider).toBe("xai");
    expect(read?.model).toBe(defaultModelId("xai"));
    expect(JSON.stringify(read)).not.toContain(secret);
    expect(JSON.stringify(read)).not.toContain("apiKey");
  });

  it("prefers model over modelId, and uses modelId when model is unusable", () => {
    expect(readTextGeneration({
      provider: "ollama",
      model: "my-local",
      modelId: "llama3.2",
    })?.model).toBe("my-local");
    expect(readTextGeneration({
      provider: "ollama",
      model: "has a space",
      modelId: "llama3.2",
    })?.model).toBe("llama3.2");
  });

  it("rejects an unknown provider, a display name, a path and a secret-looking model", () => {
    expect(readTextGeneration({ provider: "claude", model: "haiku" })).toBeNull();
    expect(readTextGeneration({ provider: "OpenRouter", model: "google/gemini-2.0-flash" })).toBeNull();
    expect(readTextGeneration({ provider: "xai", model: "../secret" })).toBeNull();
    expect(readTextGeneration({ provider: "xai", model: "C:\\models\\x" })).toBeNull();
    expect(readTextGeneration({ provider: "xai", model: "foo//bar" })).toBeNull();
    expect(readTextGeneration({ provider: "xai", model: "deep\rseek" })).toBeNull();
    expect(readTextGeneration({ provider: "xai", model: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz" })).toBeNull();
  });

  it("keeps a custom loopback address and refuses a clear-text remote one", () => {
    expect(readTextGeneration({
      provider: "custom",
      model: "local-model",
      baseUrl: "http://127.0.0.1:8080/v1",
    })).toEqual({
      provider: "custom",
      model: "local-model",
      baseUrl: "http://127.0.0.1:8080/v1",
    });
    expect(readTextGeneration({
      provider: "custom",
      model: "local-model",
      baseUrl: "http://evil.example/v1",
    })).toBeNull();
    expect(readTextGeneration({
      provider: "custom",
      model: "local-model",
    })).toBeNull();
    expect(readTextGeneration({
      provider: "openrouter",
      model: "google/gemini-2.0-flash",
      baseUrl: "https://user:pass@openrouter.ai/api/v1",
    })).toBeNull();
    expect(readTextGeneration({
      provider: "openrouter",
      model: "google/gemini-2.0-flash",
      baseUrl: "https://openrouter.ai/api/v1?key=abcdefghij",
    })).toBeNull();
    expect(readTextGeneration({
      provider: "openrouter",
      model: "google/gemini-2.0-flash",
      baseUrl: "https://api.anthropic.com/v1",
    })).toBeNull();
  });

  it("trims a trailing slash and a wrapped model id", () => {
    expect(readTextGeneration({
      provider: "ollama",
      model: "  llama3.2\r\n",
      baseUrl: "http://localhost:11434/",
    })).toEqual({
      provider: "ollama",
      model: "llama3.2",
      baseUrl: "http://localhost:11434",
    });
  });

  it("loads a legacy value as the current shape and does not rewrite it", () => {
    const storage = mockLocalStorage();
    storage.setItem(TEXT_GENERATION_KEY, JSON.stringify({
      v: 1,
      provider: "openrouter",
      modelId: "google/gemini-2.0-flash",
      apiKey: "sk-test-secret-value-1234",
    }));
    storage.writes.length = 0;
    expect(loadTextGeneration()).toEqual(openRouter);
    expect(storage.writes).toEqual([]);
    expect(storage.getItem(TEXT_GENERATION_KEY)).toContain("modelId");
  });
});

function storageWrites(read: () => unknown): unknown {
  const before = (localStorage as { writes?: string[] }).writes?.length ?? 0;
  const value = read();
  expect((localStorage as { writes?: string[] }).writes?.length ?? 0).toBe(before);
  return value;
}
