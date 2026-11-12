// @vitest-environment happy-dom
// The Connections card: installed tools only, with the app's extra connections marked.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
  emitHarnessAvailability,
  setHarnessAvailability,
} from "../../../integrations/harness/core/availabilityState";
import { ModelConnectionsSetting } from "./ModelConnectionsSetting";

let container: HTMLDivElement;
let root: Root;

const none = {
  claude: false, codex: false, cursor: false, grok: false, opencode: false, pi: false,
  omp: false, fx: false, hermes: false, antigravity: false, devin: false,
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  setHarnessAvailability({ ...none, claude: true, omp: true });
  emitHarnessAvailability();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setHarnessAvailability(none);
});

it("shows each installed tool with its extra connections marked", async () => {
  await act(async () => root.render(createElement(ModelConnectionsSetting)));
  const rows = [...container.querySelectorAll("[data-connection-row]")].map((r) => r.getAttribute("data-connection-row"));
  expect(rows).toEqual(["claude", "omp"]);
  const ompClaude = container.querySelector('[data-connection-row="omp"] [data-connection-source="claudeLogin"]')!;
  expect(ompClaude.getAttribute("data-extra")).toBe("true");
  expect(ompClaude.getAttribute("data-ready")).toBe("true");
  const ownClaude = container.querySelector('[data-connection-row="claude"] [data-connection-source="claudeLogin"]')!;
  expect(ownClaude.getAttribute("data-extra")).toBeNull();
  expect(container.textContent).toContain("Not installed:");
  expect(container.textContent).not.toMatch(/\bMono\b/);
});
