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

/** Key deletes only: the list also reads each key's stored address on mount, which is not a removal. */
const keyDeletes = () => invoke.mock.calls.filter(([cmd]) => cmd === "plugin:hub|model_key_delete");

describe("removing a custom model", () => {
  it("asks first, then deletes the Keychain key through the existing command and drops the model", async () => {
    seed([grok, llama]);
    act(() => root.render(createElement(OtherModelsSection, { query: "", currentModel: "", onPick: () => {}, onAdd: () => {} })));
    await click(host.querySelector('[data-remove-model="xai-1"]'));
    expect(host.querySelector('[data-remove-confirm="xai-1"]')?.textContent).toBe("Remove Grok? Its saved key is deleted too.CancelRemove");
    expect(keyDeletes()).toEqual([]);
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
    expect(keyDeletes()).toEqual([]);
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

  it("a delete that answers false is a failure too: the model stays and the line shows", async () => {
    seed([grok]);
    invoke.mockImplementation(async () => false);
    act(() => root.render(createElement(OtherModelsSection, { query: "", currentModel: "", onPick: () => {}, onAdd: () => {} })));
    await click(host.querySelector('[data-remove-model="xai-1"]'));
    await click(host.querySelector("[data-remove-yes]"));
    expect(listCustomModels()).toHaveLength(1);
    expect(host.querySelector("[data-remove-problem]")?.textContent).toBe("Couldn't delete the key, so Grok is still here. Try again.");
  });

  it("an Ollama model has no key, so nothing is asked of the Keychain", async () => {
    seed([llama]);
    await removeCustomModel("ollama-1");
    expect(keyDeletes()).toEqual([]);
    expect(listCustomModels()).toEqual([]);
  });
});

describe("the remove confirm title", () => {
  it("wraps instead of being cut off, with the buttons on their own row", async () => {
    seed([{ ...grok, name: "A rather long model display name from OpenRouter" }]);
    act(() => root.render(createElement(OtherModelsSection, { query: "", currentModel: "", onPick: () => {}, onAdd: () => {} })));
    await click(host.querySelector('[data-remove-model="xai-1"]'));
    const confirm = host.querySelector('[data-remove-confirm="xai-1"]')!;
    const title = host.querySelector("[data-remove-title]")!;
    expect(title.textContent).toBe("Remove A rather long model display name from OpenRouter? Its saved key is deleted too.");
    for (const cut of ["truncate", "text-ellipsis", "whitespace-nowrap", "overflow-hidden"]) {
      expect(title.className).not.toContain(cut);
      expect(confirm.className).not.toContain(cut);
    }
    expect(title.className).toContain("whitespace-normal");
    expect(confirm.className).not.toMatch(/\bh-\d/);
    expect(confirm.className).toContain("flex-col");
    expect(title.contains(host.querySelector("[data-remove-yes]"))).toBe(false);
  });
});

describe("a key that isn't there", () => {
  it("counts as removed: the backend answers true for 'no key found', so the model goes", async () => {
    seed([grok]);
    invoke.mockImplementation(async () => true); // model_key_delete: deleted or missing are both true
    act(() => root.render(createElement(OtherModelsSection, { query: "", currentModel: "", onPick: () => {}, onAdd: () => {} })));
    await click(host.querySelector('[data-remove-model="xai-1"]'));
    await click(host.querySelector("[data-remove-yes]"));
    expect(listCustomModels()).toEqual([]);
    expect(host.querySelector("[data-remove-problem]")).toBeNull();
  });

  it("only a real Keychain failure (false) keeps the model and shows the line", async () => {
    seed([grok]);
    invoke.mockImplementation(async () => false);
    act(() => root.render(createElement(OtherModelsSection, { query: "", currentModel: "", onPick: () => {}, onAdd: () => {} })));
    await click(host.querySelector('[data-remove-model="xai-1"]'));
    await click(host.querySelector("[data-remove-yes]"));
    expect(listCustomModels()).toHaveLength(1);
    expect(host.querySelector("[data-remove-problem]")?.textContent).toBe("Couldn't delete the key, so Grok is still here. Try again.");
  });

  it("the dev store treats a missing key as removed too", async () => {
    const { createDevModelKeyStore } = await import("../model/customModels");
    expect(await createDevModelKeyStore().deleteModelKey("never-saved")).toBe(true);
  });
});
