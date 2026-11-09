// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { resetWorkerPool } from "../../monos/model/workerPool";
import { CrewDefaults } from "./CrewDefaults";
import type { CrewRule } from "../model/rules";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

let root: Root;
let container: HTMLElement;

const builder: CrewRule = { labels: ["builder"], paths: [], cli: "grok", source: "person" };
const pathRule: CrewRule = { labels: ["ui"], paths: ["src"], cli: "cursor", source: "person" };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetWorkerPool();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  invokeMock.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetWorkerPool();
  vi.unstubAllGlobals();
});

function show() {
  act(() => {
    root.render(createElement(CrewDefaults, { cwd: "/work/app" }));
  });
}

function setValue(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
  if (!input) throw new Error(`no ${label}`);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function clickLabel(label: string) {
  const input = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
  if (!input) throw new Error(`no ${label}`);
  input.click();
}

function click(name: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === name);
  if (!button) throw new Error(`no ${name}`);
  button.click();
}

function calls(command: string): Record<string, unknown>[] {
  return invokeMock.mock.calls
    .filter((call) => call[0] === command)
    .map((call) => (call[1] ?? {}) as Record<string, unknown>);
}

it("loads the lock, the role and the lists, and a save keeps the other rules", async () => {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "crew_rules_get") {
      return Promise.resolve({
        rules: [pathRule, builder],
        revision: 4,
        policy: { lockDefault: false, neverUse: ["not a cli"], fallback: ["codex", "codex"] },
        signedIn: [{ cli: "claude", installed: true, signedIn: true }],
      });
    }
    if (cmd === "crew_rules_set") {
      return Promise.resolve({ revision: 5, rules: [pathRule, builder] });
    }
    if (cmd === "crew_policy_set") {
      return Promise.resolve({
        revision: 6,
        rules: [pathRule, builder],
        policy: { lockDefault: true, neverUse: ["pi"], fallback: ["codex"] },
        signedIn: [],
      });
    }
    return Promise.resolve(undefined);
  });
  show();
  await act(async () => undefined);
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Builder CLI"]')?.value).toBe("grok");
  expect(container.querySelector("[data-never-use]")).toBeNull();
  expect(container.querySelector("[data-fallback='codex']")).not.toBeNull();
  expect(container.querySelector("[data-crew-defaults-line]")?.textContent).toContain("`builder` work to Grok");
  await act(async () => {
    clickLabel("Always use my default");
    setValue("Never use", "pi");
  });
  await act(async () => {
    click("Add");
  });
  await act(async () => {
    click("Save");
  });
  const rules = calls("crew_rules_set").at(-1);
  const sent = (rules?.rules ?? []) as { labels: string[]; paths: string[] }[];
  expect(sent.map((rule) => rule.labels[0]).sort()).toEqual(["builder", "ui"]);
  expect(sent.find((rule) => rule.labels[0] === "ui")?.paths).toEqual(["src"]);
  expect(rules?.revision).toBe(4);
  const policy = calls("crew_policy_set").at(-1);
  expect(policy?.revision).toBe(5);
  expect(policy?.policy).toEqual({ lockDefault: true, neverUse: ["pi"], fallback: ["codex"] });
  expect(container.textContent).toContain("Saved.");
});

it("a late load does not turn the lock back off", async () => {
  let resolveGet: (value: unknown) => void = () => undefined;
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "crew_rules_get") {
      return new Promise((resolve) => {
        resolveGet = resolve;
      });
    }
    return Promise.resolve(undefined);
  });
  show();
  await act(async () => {
    clickLabel("Always use my default");
  });
  await act(async () => {
    resolveGet({ rules: [], revision: 1, policy: { lockDefault: false, neverUse: [], fallback: [] }, signedIn: [] });
  });
  expect(container.querySelector<HTMLInputElement>('[aria-label="Always use my default"]')?.checked).toBe(true);
});
