// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { addCustomModel, createDevModelKeyStore, customModelRoute, emptyForm, listCustomModels, setCustomModelEfforts, setModelKeyStore } from "./customModels";
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
it("old models keep provider defaults and have no invented effort setting", async () => {
  const m = await addCustomModel({ ...emptyForm("ollama"), name: "Local" });
  expect(resolveModel("claude", `custom:${m.id}`).settings).toBeUndefined();
  expect(customModelRoute({ model: `custom:${m.id}`, modelSettings: { effort: "high" } })?.reasoningEffort).toBeUndefined();
});
