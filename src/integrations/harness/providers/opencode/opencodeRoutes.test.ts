// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";

const spawnChild = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../../core/child", () => ({ spawnChild }));

import { opencodeRoutedModels, spawnOpenCodeServer } from "./opencodeRoutes";
import { parseOpenCodeModelSlug } from "./opencodeProtocol";

beforeEach(() => {
  localStorage.clear();
  spawnChild.mockClear();
});

function save(models: unknown[]) {
  localStorage.setItem("monocode:custom-models", JSON.stringify(models));
}

it("starts the plain server when no model is saved", async () => {
  await spawnOpenCodeServer("s1", "/bin/opencode", ["serve"], "/work");
  expect(spawnChild).toHaveBeenCalledWith("s1", "/bin/opencode", ["serve"], "/work", undefined, "opencode");
});

it("offers each saved model through the router, never its key", async () => {
  save([{ id: "or 1", name: "Example: Grok", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", modelId: "x-ai/grok-4" }]);
  await spawnOpenCodeServer("s1", "/bin/opencode", ["serve"], "/work");
  const routes = (spawnChild.mock.calls[0] as unknown[])[12];
  expect(routes).toEqual([
    { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", modelId: "x-ai/grok-4", customModelId: "or 1" },
  ]);
  const [model] = opencodeRoutedModels();
  expect(model).toMatchObject({ id: "opencode:dropwave-or-1/x-ai/grok-4", name: "x-ai/grok-4 (your key)" });
  // OpenCode splits on the first slash, so the provider is the app's and the model keeps its own slash.
  expect(parseOpenCodeModelSlug(model!.nativeId)).toEqual({ providerID: "dropwave-or-1", modelID: "x-ai/grok-4" });
});
