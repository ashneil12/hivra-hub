// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => true);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { listCustomModels, removeCustomModel, setModelKeyStore, tauriModelKeyStore } from "../model/customModels";
import { OtherModelsSection } from "./CustomModels";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const seed = (list: unknown[]) => localStorage.setItem("monocode:custom-models", JSON.stringify(list));
const grok = { id: "xai-1", name: "Grok", provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: "grok-4" };
const llama = { id: "ollama-1", name: "Llama", provider: "ollama", baseUrl: "http://localhost:11434", modelId: "llama3.2" };

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  invoke.mockClear();
  invoke.mockImplementation(async () => true);
  localStorage.clear();
  setModelKeyStore(tauriModelKeyStore);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const click = async (el: Element | null) => {
  expect(el).not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
  });
};

describe("removing a custom model", () => {
  it("asks first, then deletes the Keychain key through the existing command and drops the model", async () => {
    seed([grok, llama]);
    act(() => root.render(createElement(OtherModelsSection, { query: "", currentModel: "", onPick: () => {}, onAdd: () => {} })));
    await click(host.querySelector('[data-remove-model="xai-1"]'));
    expect(host.querySelector('[data-remove-confirm="xai-1"]')?.textContent).toBe("Remove Grok? Its saved key is deleted too.CancelRemove");
    expect(invoke).not.toHaveBeenCalled();
    expect(listCustomModels()).toHaveLength(2);

    await click(host.querySelector("[data-remove-yes]"));
    expect(invoke).toHaveBeenCalledWith("plugin:hub|model_key_delete", { customModelId: "xai-1" });
    expect(listCustomModels().map((m) => m.id)).toEqual(["ollama-1"]);
    expect(host.querySelector('[data-custom-model="xai-1"]')).toBeNull();
  });

  it("Cancel leaves the model and its key alone", async () => {
    seed([grok]);
    act(() => root.render(createElement(OtherModelsSection, { query: "", currentModel: "", onPick: () => {}, onAdd: () => {} })));
    await click(host.querySelector('[data-remove-model="xai-1"]'));
    await click(host.querySelector("[data-remove-cancel]"));
    expect(invoke).not.toHaveBeenCalled();
    expect(listCustomModels()).toHaveLength(1);
  });

  it("keeps the model when the key can't be deleted, so no key is left orphaned", async () => {
    seed([grok]);
    invoke.mockImplementation(async () => {
      throw new Error("Keychain locked");
    });
    act(() => root.render(createElement(OtherModelsSection, { query: "", currentModel: "", onPick: () => {}, onAdd: () => {} })));
    await click(host.querySelector('[data-remove-model="xai-1"]'));
    await click(host.querySelector("[data-remove-yes]"));
    expect(listCustomModels()).toHaveLength(1);
    expect(host.querySelector("[data-remove-problem]")?.textContent).toBe("Couldn't delete the key, so Grok is still here. Try again.");
  });

  it("an Ollama model has no key, so nothing is asked of the Keychain", async () => {
    seed([llama]);
    await removeCustomModel("ollama-1");
    expect(invoke).not.toHaveBeenCalled();
    expect(listCustomModels()).toEqual([]);
  });
});
