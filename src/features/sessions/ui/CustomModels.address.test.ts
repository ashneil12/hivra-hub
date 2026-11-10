// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => true) }));

import { OtherModelsSection } from "./CustomModels";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const seed = (list: unknown[]) => localStorage.setItem("monocode:custom-models", JSON.stringify(list));
const grok = { id: "xai-1", name: "Grok", provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: "grok-4" };
const router = { id: "or-1", name: "Router", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", modelId: "x-ai/grok-4" };

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

describe("Other models shows the saved address next to each saved key", () => {
  it("prints each model's stored address beside its row", () => {
    seed([grok, router]);
    act(() => root.render(createElement(OtherModelsSection, { query: "", currentModel: "", onPick: () => {}, onAdd: () => {} })));
    const rows = [...host.querySelectorAll("[data-saved-address]")].map((el) => ({
      model: el.getAttribute("data-saved-address"),
      text: el.textContent,
    }));
    expect(rows).toEqual([
      { model: "xai-1", text: "https://api.x.ai/v1" },
      { model: "or-1", text: "https://openrouter.ai/api/v1" },
    ]);
  });
});
