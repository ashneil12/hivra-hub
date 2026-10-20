// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { addCustomModel, createDevModelKeyStore, customModelRoute, emptyForm, importCustomModels, listCustomModels, setCustomModelEfforts, setModelKeyStore } from "./customModels";
import { resolveModel } from "./models";
beforeEach(() => { localStorage.clear(); setModelKeyStore(createDevModelKeyStore()); });
it("persists explicit effort support and carries only allowed levels to the router", async () => {
  const m = await addCustomModel({ ...emptyForm("custom"), name: "Reasoner", modelId: "reasoner", baseUrl: "https://example.com/v1", key: "not-a-real-key", reasoningEfforts: ["low", "high"] });
  expect(listCustomModels()[0].reasoningEfforts).toEqual(["low", "high"]);
  expect(resolveModel("claude", `custom:${m.id}`).settings?.[0].options.map((o) => o.value)).toEqual(["low", "high"]);
  expect(customModelRoute({ model: `custom:${m.id}`, modelSettings: { effort: "high" } })?.reasoningEffort).toBe("high");
  expect(customModelRoute({ model: `custom:${m.id}`, modelSettings: { effort: "max" } })?.reasoningEffort).toBeUndefined();
  setCustomModelEfforts(m.id, ["medium"]);
  expect(resolveModel("claude", `custom:${m.id}`).settings?.[0].value).toBe("medium");
  expect(localStorage.getItem("monocode:custom-models")).not.toContain("not-a-real-key");
});
const ALL = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const offered = (id: string) => resolveModel("claude", `custom:${id}`).settings?.[0].options.map((o) => o.value);
it("a new model with no levels chosen offers every level and sends the one picked", async () => {
  const m = await addCustomModel({ ...emptyForm("ollama"), name: "Local" });
  expect(offered(m.id)).toEqual(ALL);
  expect(resolveModel("claude", `custom:${m.id}`).settings?.[0].value).toBe("medium");
  expect(customModelRoute({ model: `custom:${m.id}`, modelSettings: { effort: "max" } })?.reasoningEffort).toBe("max");
  expect(customModelRoute({ model: `custom:${m.id}`, modelSettings: { effort: "none" } })?.reasoningEffort).toBe("none");
  // Nothing picked in this chat: the provider decides, nothing is sent.
  expect(customModelRoute({ model: `custom:${m.id}`, modelSettings: {} })?.reasoningEffort).toBeUndefined();
});
it("a model saved before levels existed offers every level", () => {
  localStorage.setItem("monocode:custom-models", JSON.stringify([{ id: "xai-old", name: "Grok", provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: "grok-4.6" }]));
  expect(offered("xai-old")).toEqual(ALL);
  expect(customModelRoute({ model: "custom:xai-old", modelSettings: { effort: "xhigh" } })?.reasoningEffort).toBe("xhigh");
});
it("narrowing is kept, and turning every level off leaves effort to the provider", async () => {
  const m = await addCustomModel({ ...emptyForm("ollama"), name: "Local" });
  setCustomModelEfforts(m.id, ["high", "low"]);
  expect(offered(m.id)).toEqual(["low", "high"]);
  setCustomModelEfforts(m.id, []);
  expect(listCustomModels()[0].reasoningEfforts).toEqual([]);
  expect(resolveModel("claude", `custom:${m.id}`).settings).toBeUndefined();
  expect(customModelRoute({ model: `custom:${m.id}`, modelSettings: { effort: "high" } })?.reasoningEffort).toBeUndefined();
  setCustomModelEfforts(m.id, [...ALL] as never);
  expect(offered(m.id)).toEqual(ALL);
});
it("a setup export and import keep a deliberate choice, including all off", async () => {
  const narrowed = await addCustomModel({ ...emptyForm("ollama"), name: "Narrow", reasoningEfforts: ["high"] });
  const off = await addCustomModel({ ...emptyForm("ollama"), name: "Off", reasoningEfforts: [] });
  const open = await addCustomModel({ ...emptyForm("ollama"), name: "Open" });
  const exported = JSON.parse(JSON.stringify(listCustomModels()));
  localStorage.clear();
  expect(importCustomModels(exported)).toBe(3);
  expect(offered(narrowed.id)).toEqual(["high"]);
  expect(resolveModel("claude", `custom:${off.id}`).settings).toBeUndefined();
  expect(offered(open.id)).toEqual(ALL);
});
