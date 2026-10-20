// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it } from "vitest";
import type { SetupDoc } from "../model/setupDoc";
import { ImportPreview } from "./ImportPreview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => localStorage.clear());

const doc = (settings: Record<string, string>): SetupDoc => ({
  format: "monocode-hub-setup",
  version: 2,
  exportedAt: "",
  projects: [],
  projectPrefs: { names: {}, order: [], hidden: [], icons: {} },
  monos: [],
  teams: [],
  connectors: [],
  pages: [],
  customModels: [],
  settings,
});

it("the preview names each setting an import would add or change, not just how many", async () => {
  localStorage.setItem("monocode.themeScheme", "daylight");
  const pending = { name: "x", path: null, doc: doc({ "monocode.themeScheme": "midnight", "monocode.accentColor": "hsl(1 2% 3%)" }), inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () =>
    createRoot(host).render(createElement(ImportPreview, { pending, inline: true, onBack: () => undefined, onRestore: async () => ({ lines: [], rust: null, problems: [] }) })),
  );
  const section = host.querySelector("[data-portable-section=settings]")!.textContent!;
  expect(section).toContain("accentColor");
  expect(section).toContain("themeScheme");
});
