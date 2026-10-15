// @vitest-environment happy-dom
import { act, createElement, type CSSProperties, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEXT_MODEL } from "../../../integrations/harness/providers/grok/grokProtocol";

vi.mock("../../../integrations/harness/core/availability", () => ({
  getHarnessAvailabilitySnapshot: () => 0,
  hasProbedHarnessAvailability: () => true,
  isHarnessAvailable: () => true,
  probeHarnessAvailability: () => Promise.resolve(),
  subscribeHarnessAvailability: () => () => undefined,
}));

vi.mock("../../../integrations/harness/core/registry", () => ({
  refreshHarnessCatalogs: () => Promise.resolve(),
}));

vi.mock("../../../shared/ui/Popover", () => ({
  Popover: ({
    children,
    role,
    className,
    tabIndex,
    onKeyDown,
    ...props
  }: {
    children: ReactNode;
    role?: string;
    className?: string;
    tabIndex?: number;
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
    minHeight?: number;
    maxHeight?: number;
    style?: CSSProperties;
    anchor?: unknown;
    side?: string;
    "aria-label"?: string;
    "data-model-picker"?: boolean;
  }) =>
    createElement(
      "div",
      {
        role,
        className,
        tabIndex,
        onKeyDown,
        style: props.style,
        "data-min-height": props.minHeight,
        "data-max-height": props.maxHeight,
        "data-anchor-element":
          props.anchor instanceof HTMLElement ||
          (typeof props.anchor === "object" &&
            props.anchor != null &&
            "current" in props.anchor &&
            props.anchor.current instanceof HTMLElement)
            ? "true"
            : "false",
        "data-side": props.side,
        "aria-label": props["aria-label"],
        "data-model-picker": props["data-model-picker"] ? "" : undefined,
      },
      children,
    ),
}));

import { ModelControlPills, ModelPicker } from "./ModelPicker";
import { resetHarnessModelOverlays, setHarnessModels } from "../model/models";
import {
  createDevModelKeyStore, customModelRoute, KEY_FAILED, OLLAMA_DOWN, OLLAMA_UP, setModelKeyStore, validateCustomModel, emptyForm,
} from "../model/customModels";

let container: HTMLDivElement;
let root: Root;
let keys: ReturnType<typeof createDevModelKeyStore>;
const writes: string[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  writes.length = 0;
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
    writes.push(`${k}=${v}`);
    setItem.call(this, k, v);
  });
  keys = createDevModelKeyStore();
  setModelKeyStore(keys);
  resetHarnessModelOverlays();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  resetHarnessModelOverlays();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T & HTMLElement>(sel);
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
function type(label: string, value: string) {
  const el = q<HTMLInputElement>(`[aria-label="${label}"]`)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function choose(provider: string) {
  if (!q("[data-provider-menu]")) act(() => q<HTMLButtonElement>("[data-provider-button]")!.click());
  act(() => q<HTMLButtonElement>(`[data-provider-choice="${provider}"]`)!.click());
}
const onChange = vi.fn();
const onSettingsChange = vi.fn();
function render(model = "claude:opus-5-5", values: Record<string, string> = {}) {
  setHarnessModels("claude", [{ id: "claude:opus-5-5", harness: "claude", name: "Claude Opus 5.5", nativeId: "claude-opus-5-5" }]);
  act(() => root.render(createElement(ModelPicker, { harness: "claude", model, values, hideSettings: true, onChange, onSettingsChange })));
}
const open = () => act(() => q<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click());
async function addGrok(key = "xai-good-key-123") {
  if (!q("[data-add-model-form]")) act(() => q("[data-add-model]")!.click());
  type("Name", "Grok");
  type("Key", key);
  await act(async () => q("[data-test-key]")!.click());
  await flush();
}

describe("form validation", () => {
  it("needs a name, a model id without spaces, a key, and for Custom an http(s) base URL", () => {
    expect(Object.keys(validateCustomModel(emptyForm("xai")))).toEqual(["name", "key"]);
    expect(Object.keys(validateCustomModel(emptyForm("custom")))).toEqual(["name", "modelId", "baseUrl", "key"]);
    expect(validateCustomModel({ ...emptyForm("xai"), name: "Grok", modelId: "grok 4", key: "k" }).modelId).toBe("The model id has no spaces");
    expect(validateCustomModel({ ...emptyForm("custom"), name: "Mine", modelId: "m", key: "k" }).baseUrl).toBe("Add the base URL");
    expect(validateCustomModel({ ...emptyForm("custom"), name: "Mine", modelId: "m", key: "k", baseUrl: "ftp://x" }).baseUrl).toMatch(/http/);
    expect(validateCustomModel({ ...emptyForm("ollama"), name: "Llama", modelId: "llama3.2" })).toEqual({});
  });
});

describe("Other models in the Claude Code tab", () => {
  it("lists custom models under the subscription ones, Grok first, each tagged billed separately", async () => {
    localStorage.setItem("monocode:custom-models", JSON.stringify([
      { id: "or-1", name: "Kimi", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", modelId: "kimi" },
      { id: "xai-1", name: "Grok", provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: "grok-4" },
    ]));
    render();
    open();
    const section = q("[data-other-models]")!;
    expect(section.textContent).toContain("Other models");
    expect([...section.querySelectorAll("[data-custom-model]")].map((r) => r.querySelector("span")!.textContent)).toEqual(["Grok", "Kimi"]);
    expect(section.querySelectorAll("[data-billed-separately]")).toHaveLength(2);
    // the subscription list still comes first
    const opts = [...container.querySelectorAll('[role="option"]')];
    expect(opts[0].getAttribute("aria-label")).toMatch(/^Claude Opus 5.5/);
    expect(q("[data-add-model]")).toBeTruthy();
  });

  it("Test key gates Save: a bad key says so and Save stays off; a good one says the model replied", async () => {
    render();
    open();
    act(() => q("[data-add-model]")!.click());
    expect(q<HTMLButtonElement>("[data-save-model]")!.disabled).toBe(true);
    expect(q<HTMLInputElement>('[aria-label="Key"]')!.type).toBe("password");
    await addGrok("bad-key-123");
    expect(q("[data-key-test]")!.textContent).toBe(KEY_FAILED);
    expect(q<HTMLButtonElement>("[data-save-model]")!.disabled).toBe(true);
    type("Key", "xai-good-key-123");
    expect(q("[data-key-test]")).toBeNull(); // a change means test again
    await act(async () => q("[data-test-key]")!.click());
    await flush();
    expect(q("[data-key-test]")!.textContent).toBe(`Connected, ${TEXT_MODEL} replied`);
    expect(q<HTMLButtonElement>("[data-save-model]")!.disabled).toBe(false);
  });

  it("Ollama: no key field, base URL defaults to localhost:11434, the test checks the connection", async () => {
    render();
    open();
    act(() => q("[data-add-model]")!.click());
    choose("ollama");
    expect(q('[aria-label="Key"]')).toBeNull();
    expect(q<HTMLInputElement>('[aria-label="Base URL"]')!.value).toBe("http://localhost:11434");
    type("Name", "Llama");
    expect(q('[aria-label="Model id"]')).toBeNull();
    act(() => q<HTMLButtonElement>("[data-model-advanced] button")!.click());
    expect(q<HTMLInputElement>('[aria-label="Model id"]')!.value).toBe("llama3.2");
    expect(q("[data-test-key]")!.textContent).toBe("Test connection");
    type("Base URL", "http://down:11434");
    await act(async () => q("[data-test-key]")!.click());
    await flush();
    expect(q("[data-key-test]")!.textContent).toBe(OLLAMA_DOWN);
    expect(q<HTMLButtonElement>("[data-save-model]")!.disabled).toBe(true);
    type("Base URL", "http://localhost:11434");
    await act(async () => q("[data-test-key]")!.click());
    await flush();
    expect(q("[data-key-test]")!.textContent).toBe(OLLAMA_UP);
    expect(q<HTMLButtonElement>("[data-save-model]")!.disabled).toBe(false);
  });

  it("saving sends the key only to the key store: never localStorage; settings keep metadata only", async () => {
    render();
    open();
    await addGrok("xai-secret-key-9876");
    await act(async () => q("[data-save-model]")!.click());
    await flush();
    expect([...keys.keys.values()]).toEqual(["xai-secret-key-9876"]);
    expect(writes.some((w) => w.includes("xai-secret-key-9876"))).toBe(false);
    for (let i = 0; i < localStorage.length; i++) expect(localStorage.getItem(localStorage.key(i)!)).not.toContain("xai-secret-key-9876");
    const saved = JSON.parse(localStorage.getItem("monocode:custom-models")!);
    expect(Object.keys(saved[0]).sort()).toEqual(["baseUrl", "id", "modelId", "name", "provider"]);
    // picking it (saving picks it) sets the session's model and the route CoS's router reads
    const id = saved[0].id;
    expect(onChange).toHaveBeenLastCalledWith("claude", `custom:${id}`);
    expect(onSettingsChange).toHaveBeenLastCalledWith({ provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: TEXT_MODEL, customModelId: id });
    expect(customModelRoute({ model: `custom:${id}`, modelSettings: {} })).toEqual({ provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: TEXT_MODEL, customModelId: id });
    expect(customModelRoute({ model: "claude:opus-5-5", modelSettings: {} })).toBeUndefined();
  });
});

describe("the bottom pill", () => {
  it("a custom model reads 'Grok · billed separately' with the billing part in grey; a sub model is unchanged", () => {
    localStorage.setItem("monocode:custom-models", JSON.stringify([{ id: "xai-1", name: "Grok", provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: "grok-4" }]));
    render("custom:xai-1");
    const pill = q('button[aria-haspopup="dialog"]')!;
    expect(pill.textContent).toBe("Grok · billed separately");
    expect(q("[data-pill-billing]")!.className).toContain("text-content/50");
    render("claude:opus-5-5");
    expect(q('button[aria-haspopup="dialog"]')!.textContent).toBe("Opus 5.5");
    expect(q("[data-pill-billing]")).toBeNull();
  });
});

describe("a session on a custom model", () => {
  it("keeps its custom id through the app's model resolution (so the session's model stays custom:<id>)", async () => {
    localStorage.setItem("monocode:custom-models", JSON.stringify([{ id: "xai-1", name: "Grok", provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: "grok-4" }]));
    const { resolveModel } = await import("../model/models");
    expect(resolveModel("claude", "custom:xai-1")).toMatchObject({ id: "custom:xai-1", harness: "claude", name: "Grok", nativeId: "grok-4" });
  });
});

describe("model id is filled in per provider", () => {
  it("xAI uses the Grok harness's own model; no model id field outside Advanced; Custom's Advanced opens on a missing id", async () => {
    const { defaultModelId } = await import("../model/customModels");
    expect(defaultModelId("xai")).toBe(TEXT_MODEL);
    expect(defaultModelId("openrouter")).toBe(`x-ai/${TEXT_MODEL}`);
    expect(defaultModelId("deepseek")).toBe("deepseek-chat");
    expect(defaultModelId("ollama")).toBe("llama3.2");
    render();
    open();
    act(() => q("[data-add-model]")!.click());
    expect(q('[aria-label="Model id"]')).toBeNull();
    expect(q("[data-model-advanced]")).toBeNull();
    for (const p of ["openrouter", "deepseek"]) { choose(p); expect(q("[data-model-advanced]")).toBeNull(); }
    choose("custom");
    expect(q("[data-model-advanced]")!.getAttribute("data-model-advanced")).toBe("closed");
    type("Name", "Mine");
    await act(async () => q("[data-test-key]")!.click());
    expect(q("[data-model-advanced]")!.getAttribute("data-model-advanced")).toBe("open");
    expect(q('[data-form-error="modelId"]')).toBeTruthy();
  });
});

describe("provider menu", () => {
  it("is the picker's own menu, not a native select, and shows the choice", () => {
    render();
    open();
    act(() => q("[data-add-model]")!.click());
    expect(document.querySelector("[data-add-model-form] select")).toBeNull();
    act(() => q<HTMLButtonElement>("[data-provider-button]")!.click());
    const items = [...document.querySelectorAll('[data-provider-menu] [role="menuitemradio"]')].map((e) => e.textContent);
    expect(items).toEqual(["xAI", "OpenRouter", "DeepSeek", "Ollama", "Custom"]);
    expect(q('[data-provider-choice="xai"]')!.getAttribute("aria-checked")).toBe("true");
    act(() => q<HTMLButtonElement>('[data-provider-choice="deepseek"]')!.click());
    expect(q("[data-provider-menu]")).toBeNull();
    expect(q("[data-provider-button]")!.textContent).toBe("DeepSeek");
  });
});
