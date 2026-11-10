// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => true) }));

import { OtherModelsSection } from "./CustomModels";
import { addressShownFor } from "../model/customModels";

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

describe("Other models shows the saved address next to each saved key", () => {
  it("prints the address only for a proxy or a custom model", () => {
    seed([grok, router, proxied, custom]);
    act(() => root.render(createElement(OtherModelsSection, { query: "", currentModel: "", onPick: () => {}, onAdd: () => {} })));
    const rows = [...host.querySelectorAll("[data-saved-address]")].map((el) => ({
      model: el.getAttribute("data-saved-address"),
      text: el.textContent,
    }));
    expect(rows).toEqual([
      { model: "or-2", text: "https://proxy.example.com/v1" },
      { model: "c-1", text: "https://llm.example.org/v1" },
    ]);
  });
});
