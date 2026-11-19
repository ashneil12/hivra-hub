// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The address each model's key was saved with, as Rust stores it. The webview's own copy is not the source.
const rust = vi.hoisted(() => new Map<string, string | null>());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: { customModelId?: string }) =>
    cmd === "plugin:hub|model_key_address" ? (rust.get(args?.customModelId ?? "") ?? null) : true,
  ),
}));

import { OtherModelsSection } from "./CustomModels";
import { addressShownFor, setModelKeyStore, tauriModelKeyStore } from "../model/customModels";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const seed = (list: unknown[]) => localStorage.setItem("monocode:custom-models", JSON.stringify(list));
const grok = { id: "xai-1", name: "Grok", provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: "grok-4" };
const router = { id: "or-1", name: "Router", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", modelId: "x-ai/grok-4" };
const proxied = { id: "or-2", name: "Proxy", provider: "openrouter", baseUrl: "https://proxy.example.com/v1", modelId: "x-ai/grok-4" };
const custom = { id: "c-1", name: "Mine", provider: "custom", baseUrl: "https://llm.example.org/v1", modelId: "m" };

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  localStorage.clear();
  rust.clear();
  setModelKeyStore(tauriModelKeyStore);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("addressShownFor: an address is shown only where the key goes somewhere other than the provider's default", () => {
  it("hides a named provider on its default address and shows a proxy or a custom address", () => {
    expect(addressShownFor("openrouter", "https://openrouter.ai/api/v1/")).toBeUndefined();
    expect(addressShownFor("xai", "https://api.x.ai/v1")).toBeUndefined();
    expect(addressShownFor("openrouter", "https://proxy.example.com/v1")).toBe("https://proxy.example.com/v1");
    expect(addressShownFor("custom", "https://llm.example.org/v1")).toBe("https://llm.example.org/v1");
  });
});

async function renderList(): Promise<void> {
  await act(async () => {
    root.render(createElement(OtherModelsSection, { query: "", currentModel: "", onPick: () => {}, onAdd: () => {} }));
  });
  // The stored addresses load after the first paint: let them arrive and the list re-render.
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("Other models shows the saved address next to each saved key", () => {
  it("prints the address Rust stored: only for a proxy or a custom model", async () => {
    seed([grok, router, proxied, custom]);
    rust.set("xai-1", "https://api.x.ai/v1");
    rust.set("or-1", "https://openrouter.ai/api/v1");
    rust.set("or-2", "https://proxy.example.com/v1");
    rust.set("c-1", "https://llm.example.org/v1");
    await renderList();
    const rows = [...host.querySelectorAll("[data-saved-address]")].map((el) => ({
      model: el.getAttribute("data-saved-address"),
      text: el.textContent,
    }));
    expect(rows).toEqual([
      { model: "or-2", text: "https://proxy.example.com/v1" },
      { model: "c-1", text: "https://llm.example.org/v1" },
    ]);
  });

  it("uses the stored address, not the one in the webview, when they differ", async () => {
    seed([custom]);
    rust.set("c-1", "https://other.example.net/v1");
    await renderList();
    expect(host.querySelector('[data-saved-address="c-1"]')?.textContent).toBe("https://other.example.net/v1");
  });

  it("says to add a key again when its key was saved with no address", async () => {
    seed([custom]);
    rust.set("c-1", null);
    await renderList();
    expect(host.querySelector('[data-saved-address="c-1"]')).toBeNull();
    expect(host.querySelector('[data-save-again="c-1"]')?.textContent).toContain("Add it again");
  });
});
