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
    expect(validateCustomModel({ ...emptyForm("custom"), name: "Mine", modelId: "m", key: "k" }).baseUrl).toBe("Add your provider's address");
    expect(validateCustomModel({ ...emptyForm("deepseek"), name: "D", key: "k", baseUrl: "https://api.deepseek.com/anthropic" }).baseUrl).toMatch(/OpenAI-style/);
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

  it("Save turns on once the fields are filled, but only keeps a model whose test passed", async () => {
    render();
    open();
    act(() => q("[data-add-model]")!.click());
    expect(q<HTMLButtonElement>("[data-save-model]")!.disabled).toBe(true);
    expect(q<HTMLInputElement>('[aria-label="Key"]')!.type).toBe("password");
    await addGrok("bad-key-123");
    expect(q("[data-key-test]")!.textContent).toBe(KEY_FAILED);
    expect(q<HTMLButtonElement>("[data-save-model]")!.disabled).toBe(false);
    await act(async () => q("[data-save-model]")!.click());
    await flush();
    expect(localStorage.getItem("monocode:custom-models")).toBeNull();
    expect(q("[data-add-model-form]")).toBeTruthy();
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
    expect(q<HTMLInputElement>('[aria-label="Model id"]')!.value).toBe("llama3.2");
    expect(q("[data-test-key]")!.textContent).toBe("Test connection");
    type("Base URL", "http://down:11434");
    await act(async () => q("[data-test-key]")!.click());
    await flush();
    expect(q("[data-key-test]")!.textContent).toBe(OLLAMA_DOWN);
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

  // E7 (live 21 Oct): the coding team's DeepSeek default runs at High, but the pill hid the effort on a custom model.
  it("a custom model with an effort set says it: 'DeepSeek · billed separately · High'", () => {
    localStorage.setItem("monocode:custom-models", JSON.stringify([{ id: "ds-1", name: "DeepSeek", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-chat" }]));
    setHarnessModels("claude", [{ id: "claude:opus-5-5", harness: "claude", name: "Claude Opus 5.5", nativeId: "claude-opus-5-5" }]);
    // The new-chat composer's own pill (settings in its menu, not beside it).
    act(() => root.render(createElement(ModelPicker, { harness: "claude", model: "custom:ds-1", values: { effort: "high" }, onChange, onSettingsChange })));
    const pill = q("[data-pill-effort]");
    expect(pill?.textContent).toBe(" · High");
    expect(pill?.parentElement?.textContent).toBe("DeepSeek · billed separately · High");
    // No effort chosen: the pill stays as it was.
    act(() => root.render(createElement(ModelPicker, { harness: "claude", model: "custom:ds-1", values: {}, onChange, onSettingsChange })));
    expect(q("[data-pill-effort]")).toBeNull();
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
  it("every provider shows its address and model id right away, prefilled and editable; Custom starts empty", async () => {
    const { defaultModelId } = await import("../model/customModels");
    expect(defaultModelId("xai")).toBe(TEXT_MODEL);
    expect(defaultModelId("openrouter")).toBe(`x-ai/${TEXT_MODEL}`);
    expect(defaultModelId("deepseek")).toBe("deepseek-chat");
    expect(defaultModelId("ollama")).toBe("llama3.2");
    render();
    open();
    act(() => q("[data-add-model]")!.click());
    const want: Record<string, [string, string]> = {
      xai: ["https://api.x.ai/v1", TEXT_MODEL],
      openrouter: ["https://openrouter.ai/api/v1", `x-ai/${TEXT_MODEL}`],
      deepseek: ["https://api.deepseek.com/v1", "deepseek-chat"],
      ollama: ["http://localhost:11434", "llama3.2"],
      custom: ["", ""],
    };
    for (const round of [1, 2]) for (const [p, [url, model]] of Object.entries(want)) {
      choose(p);
      expect(q("[data-provider-menu]"), `round ${round}`).toBeNull();
      expect(q<HTMLInputElement>('[aria-label="Base URL"]')!.value).toBe(url);
      expect(q<HTMLInputElement>('[aria-label="Model id"]')!.value).toBe(model);
    }
    type("Name", "Mine");
    type("Key", "custom-good-key-1");
    await act(async () => q("[data-test-key]")!.click());
    expect(q('[data-form-error="baseUrl"]')).toBeTruthy();
    expect(q('[data-form-error="modelId"]')).toBeTruthy();
    type("Base URL", "https://my.provider.dev/v1");
    type("Model id", "my-model");
    await act(async () => q("[data-save-model]")!.click());
    await flush();
    const saved = JSON.parse(localStorage.getItem("monocode:custom-models")!);
    expect(saved[0]).toMatchObject({ provider: "custom", baseUrl: "https://my.provider.dev/v1", modelId: "my-model" });
  });
});

describe("getting out of Add model", () => {
  it("Back and Cancel return to the model list; Esc closes the provider list first, then goes back, without closing the picker", () => {
    render();
    open();
    act(() => q("[data-add-model]")!.click());
    act(() => q<HTMLButtonElement>("[data-add-model-back]")!.click());
    expect(q("[data-add-model-form]")).toBeNull();
    expect(q("[data-add-model]")).toBeTruthy();
    act(() => q("[data-add-model]")!.click());
    act(() => q<HTMLButtonElement>("[data-add-model-cancel]")!.click());
    expect(q("[data-add-model-form]")).toBeNull();
    act(() => q("[data-add-model]")!.click());
    act(() => q<HTMLButtonElement>("[data-provider-button]")!.click());
    const esc = () => act(() => { q<HTMLButtonElement>("[data-provider-button]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    esc();
    expect(q("[data-provider-menu]")).toBeNull();
    expect(q("[data-add-model-form]")).toBeTruthy();
    esc();
    expect(q("[data-add-model-form]")).toBeNull();
    expect(q("[data-add-model]")).toBeTruthy();
  });

  it("does not offer an OAuth flow with no working provider integration", () => {
    render(); open();
    act(() => q("[data-add-model]")!.click());
    expect(q('[data-auth="oauth"]')).toBeNull();
    expect(q('[aria-label="Key"]')).toBeTruthy();
    expect(q("[data-oauth-not-connected]")).toBeNull();
  });
});

describe("provider menu", () => {
  it("is the picker's own menu in the form's flow (never floating over the fields), and shows the choice", () => {
    render();
    open();
    act(() => q("[data-add-model]")!.click());
    expect(document.querySelector("[data-add-model-form] select")).toBeNull();
    act(() => q<HTMLButtonElement>("[data-provider-button]")!.click());
    expect(q("[data-provider-menu]")!.className).not.toMatch(/\babsolute\b/);
    const items = [...document.querySelectorAll('[data-provider-menu] [role="menuitemradio"]')].map((e) => e.textContent);
    expect(items).toEqual(["xAI", "OpenRouter", "DeepSeek", "Ollama", "Custom"]);
    expect(q('[data-provider-choice="xai"]')!.getAttribute("aria-checked")).toBe("true");
    act(() => q<HTMLButtonElement>('[data-provider-choice="deepseek"]')!.click());
    expect(q("[data-provider-menu]")).toBeNull();
    expect(q("[data-provider-button]")!.textContent).toBe("DeepSeek");
  });
});

describe("a Claude key", () => {
  it("shows the subscription line when the backend answers with its Claude-key error (test or save), never a generic failure", async () => {
    const m = await import("../model/customModels");
    const form = { ...m.emptyForm("xai"), name: "x", key: "anything-long" };
    m.setModelKeyStore({ saveModelKey: async () => {}, deleteModelKey: async () => true, testModelKey: async () => ({ ok: false, code: m.CLAUDE_KEY_ERROR, message: "nope" }) });
    expect(await m.testCustomModel(form)).toMatchObject({ ok: false, message: "Claude uses your subscription, so no key is needed." });
    m.setModelKeyStore({ saveModelKey: async () => {}, deleteModelKey: async () => true, testModelKey: async () => { throw new Error(`backend: ${m.CLAUDE_KEY_ERROR}`); } });
    expect((await m.testCustomModel(form)).message).toBe(m.CLAUDE_KEY_MESSAGE);
    m.setModelKeyStore({ saveModelKey: async () => {}, deleteModelKey: async () => true, testModelKey: async () => ({ ok: false, message: "401" }) });
    expect((await m.testCustomModel(form)).message).toBe("401");
  });
});

it("the Claude-key line has a neutral grey dot, not red", async () => {
  const m = await import("../model/customModels");
  m.setModelKeyStore({ saveModelKey: async () => {}, testModelKey: async () => ({ ok: false, message: "That looks like a Claude key" }) });
  render();
  open();
  act(() => q("[data-add-model]")!.click());
  type("Name", "Claude");
  type("Key", "anything-long");
  await act(async () => q("[data-test-key]")!.click());
  await flush();
  expect(q("[data-key-test]")!.getAttribute("data-key-test")).toBe("guidance");
  expect(q("[data-key-test-dot]")!.className).toContain("bg-content/40");
  expect(q("[data-key-test-dot]")!.className).not.toContain("bg-red");
});

describe("Grok with no key", () => {
  it("is listed first under Other models with a grey 'Add key' tag, and opens Add model with xAI and Grok filled in", () => {
    localStorage.setItem("monocode:custom-models", JSON.stringify([{ id: "or-1", name: "Kimi", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", modelId: "kimi" }]));
    render();
    open();
    const rows = [...document.querySelectorAll("[data-other-models] > button")];
    expect(rows[0].hasAttribute("data-grok-add-key")).toBe(true);
    expect(rows[0].textContent).toBe("GrokAdd key");
    expect(rows[0].querySelector("span:last-child")!.className).toContain("text-content/40");
    act(() => (rows[0] as HTMLButtonElement).click());
    expect(q<HTMLInputElement>('[aria-label="Name"]')!.value).toBe("Grok");
    expect(q("[data-provider-button]")!.getAttribute("data-provider-button")).toBe("xai");
  });

  it("goes away once an xAI model is saved", () => {
    localStorage.setItem("monocode:custom-models", JSON.stringify([{ id: "xai-1", name: "Grok", provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: "grok-4.6" }]));
    render();
    open();
    expect(q("[data-grok-add-key]")).toBeNull();
    expect(q('[data-custom-model="xai-1"]')).toBeTruthy();
  });
});
