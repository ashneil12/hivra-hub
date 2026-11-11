// @vitest-environment happy-dom
// WP-129: the short text row. A provider is saved at once. A model or a custom address is saved when the field is left, and only if it is valid.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  defaultBaseUrl,
  defaultModelId,
} from "../../sessions/model/customModels";
import {
  TEXT_GENERATION_KEY,
  loadTextGeneration,
  saveTextGeneration,
} from "../model/textGeneration";
import { TextGenerationSetting } from "./TextGenerationSetting";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  saveTextGeneration(null);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  saveTextGeneration(null);
});

async function render() {
  await act(async () => root.render(createElement(TextGenerationSetting)));
}

function select() {
  return container.querySelector("select")!;
}

function field(label: string) {
  return container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
}

async function choose(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select(), value);
    select().dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function type(label: string, value: string) {
  const input = field(label)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function leave(label: string) {
  await act(async () => {
    // React listens for focusout, because a native blur event does not bubble.
    field(label)!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

async function otherWindowSaves(value: { provider: string; model: string; baseUrl: string }) {
  const raw = JSON.stringify({ v: 2, ...value });
  await act(async () => {
    localStorage.setItem(TEXT_GENERATION_KEY, raw);
    const event = new Event("storage");
    Object.defineProperty(event, "key", { value: TEXT_GENERATION_KEY });
    window.dispatchEvent(event);
  });
}

it("starts on the coding agent, with no model field and no key field", async () => {
  await render();
  expect(select().value).toBe("agent");
  expect(field("Model")).toBeNull();
  expect(field("Address")).toBeNull();
  expect(container.querySelector("input[type='password']")).toBeNull();
  expect(container.textContent).not.toMatch(/api key/i);
  expect(container.textContent).not.toMatch(/[—–]/);
  expect(container.textContent).not.toContain("/Users/");
  expect(container.querySelector("#setting-text-generation")?.getAttribute("data-setting-id")).toBe("text-generation");
  expect(loadTextGeneration()).toBeNull();
});

it("saves a known provider at once, and the coding agent clears it", async () => {
  await render();
  await choose("openrouter");
  expect(loadTextGeneration()).toEqual({
    provider: "openrouter",
    model: defaultModelId("openrouter"),
    baseUrl: defaultBaseUrl("openrouter"),
  });
  expect(field("Model")!.value).toBe(defaultModelId("openrouter"));
  expect(field("Address")).toBeNull();

  await choose("ollama");
  expect(loadTextGeneration()).toEqual({
    provider: "ollama",
    model: "llama3.2",
    baseUrl: "http://localhost:11434",
  });

  await choose("agent");
  expect(select().value).toBe("agent");
  expect(field("Model")).toBeNull();
  expect(loadTextGeneration()).toBeNull();
  expect(localStorage.getItem(TEXT_GENERATION_KEY)).toBeNull();
});

it("does not save a custom address until the model and the address are both valid", async () => {
  await render();
  await choose("custom");
  expect(loadTextGeneration()).toBeNull();
  expect(field("Model")).not.toBeNull();
  expect(field("Address")).not.toBeNull();

  await type("Model", "my-model");
  await leave("Model");
  expect(loadTextGeneration()).toBeNull();

  await type("Address", "http://example.com/v1");
  await leave("Address");
  expect(loadTextGeneration()).toBeNull();

  await type("Address", "https://models.example/v1/");
  await leave("Address");
  expect(loadTextGeneration()).toEqual({
    provider: "custom",
    model: "my-model",
    baseUrl: "https://models.example/v1",
  });
  expect(field("Address")!.value).toBe("https://models.example/v1");
});

it("keeps a saved provider when a model edit is not valid", async () => {
  await render();
  await choose("openrouter");
  const kept = loadTextGeneration();
  await type("Model", "not a model");
  await leave("Model");
  expect(loadTextGeneration()).toEqual(kept);
  expect(field("Model")!.value).toBe("not a model");

  await type("Model", "sk-ant-api03-abcdefghijklmnopqrst");
  await leave("Model");
  expect(localStorage.getItem(TEXT_GENERATION_KEY)).not.toContain("sk-ant");
  expect(loadTextGeneration()).toEqual(kept);
});

it("saves a valid model edit when the field is left", async () => {
  await render();
  await choose("deepseek");
  await type("Model", "deepseek-reasoner");
  expect(loadTextGeneration()!.model).toBe(defaultModelId("deepseek"));
  await leave("Model");
  expect(loadTextGeneration()).toEqual({
    provider: "deepseek",
    model: "deepseek-reasoner",
    baseUrl: defaultBaseUrl("deepseek"),
  });
});

it("follows another window until this one is mid edit", async () => {
  await render();
  await otherWindowSaves({
    provider: "xai",
    model: defaultModelId("xai"),
    baseUrl: defaultBaseUrl("xai"),
  });
  expect(select().value).toBe("xai");
  expect(field("Model")!.value).toBe(defaultModelId("xai"));

  await choose("custom");
  await type("Model", "mine");
  await otherWindowSaves({
    provider: "ollama",
    model: "llama3.2",
    baseUrl: "http://localhost:11434",
  });
  expect(select().value).toBe("custom");
  expect(field("Model")!.value).toBe("mine");
  expect(loadTextGeneration()!.provider).toBe("ollama");
});

it("shows the stored address for a named provider only when it is a proxy, not the default", async () => {
  saveTextGeneration({ provider: "openrouter", model: "x-ai/grok-4", baseUrl: defaultBaseUrl("openrouter") });
  await render();
  expect(container.querySelector("[data-saved-address]")).toBeNull();

  saveTextGeneration({ provider: "openrouter", model: "x-ai/grok-4", baseUrl: "https://proxy.example.com/v1" });
  await act(async () => root.render(createElement(TextGenerationSetting)));
  expect(container.querySelector("[data-saved-address]")?.textContent).toBe("https://proxy.example.com/v1");
});
