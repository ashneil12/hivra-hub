import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (..._args: unknown[]) => ({ ok: false, message: "That key didn't work" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { customModelRoute, tauriModelKeyStore } from "./customModels";

describe("the Keychain-backed model key store", () => {
  it("saves through the hub plugin with only the id and the key", async () => {
    await tauriModelKeyStore.saveModelKey("xai-abc", "fake-key");
    expect(invoke).toHaveBeenCalledWith("plugin:hub|model_key_save", { customModelId: "xai-abc", key: "fake-key" });
  });

  it("stores the address with the key when one is given", async () => {
    await tauriModelKeyStore.saveModelKey("custom-1", "fake-key", {
      provider: "custom",
      modelId: "m",
      baseUrl: "https://llm.example/v1",
    });
    expect(invoke).toHaveBeenLastCalledWith("plugin:hub|model_key_save", {
      customModelId: "custom-1",
      key: "fake-key",
      provider: "custom",
      modelId: "m",
      baseUrl: "https://llm.example/v1",
    });
  });

  it("tests a key with one request through the plugin and passes the plain answer back", async () => {
    const result = await tauriModelKeyStore.testModelKey("xai", "https://api.x.ai/v1", "grok-4", "fake-key");
    expect(invoke).toHaveBeenLastCalledWith("plugin:hub|model_key_test", {
      provider: "xai",
      baseUrl: "https://api.x.ai/v1",
      modelId: "grok-4",
      key: "fake-key",
    });
    expect(result).toEqual({ ok: false, message: "That key didn't work" });
  });

  it("gives Claude models no route, so they keep the subscription login", () => {
    expect(customModelRoute({ model: "claude:claude-sonnet-5", modelSettings: { provider: "xai", baseUrl: "x", modelId: "grok-4", customModelId: "c" } })).toBeUndefined();
  });
});
