// @vitest-environment happy-dom
// The realconv runner's custom-model step (scripts/hub-realconv.mjs --agents custom:<id>): the window takes one model's
// metadata the way a setup import does, so the hub can run a scene on it; it refuses anything carrying a key.
import { beforeEach, expect, it } from "vitest";
import { DriverLog, perform, type DriverHost } from "./verifyDriver";
import { findCustomModel, listCustomModels } from "../../features/sessions/model/customModels";
import { resolveModel } from "../../features/sessions/model/models";

const host = {} as DriverHost;
beforeEach(() => localStorage.clear());

it("adds a custom model the hub can then pick, with every reasoning level", async () => {
  const answer = (await perform({ id: "1", op: "customModel", model: { id: "deepseek-test", name: "DeepSeek", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-chat" } }, host, new DriverLog())) as { ok: boolean; model: { efforts: string[] } };
  expect(answer.ok).toBe(true);
  expect(findCustomModel("custom:deepseek-test")?.modelId).toBe("deepseek-chat");
  expect(answer.model.efforts).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  expect(resolveModel("claude", "custom:deepseek-test").settings?.[0].options).toHaveLength(7);
});

it("never takes a key", async () => {
  const answer = (await perform({ id: "2", op: "customModel", model: { id: "x", name: "Grok", provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: "grok", apiKey: "not-a-real-key" } }, host, new DriverLog())) as { ok: boolean; error: string };
  expect(answer.ok).toBe(false);
  expect(answer.error).toMatch(/never takes a key/);
  expect(listCustomModels()).toHaveLength(0);
  expect(JSON.stringify(localStorage)).not.toContain("not-a-real-key");
});

it("keeps a model whose address the form would refuse out, and says why", async () => {
  const answer = (await perform({ id: "3", op: "customModel", model: { id: "bad", name: "Bad", provider: "custom", baseUrl: "ftp://nowhere", modelId: "m" } }, host, new DriverLog())) as { ok: boolean; skipped: string[] };
  expect(answer.ok).toBe(false);
  expect(answer.skipped[0]).toMatch(/Left out the custom model "Bad"/);
});
