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
    root.render(createElement(CrewDefaults, { cwd: "/work/app", projectId: "vg-app" }));
  });
}

function setValue(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
  if (!input) throw new Error(`no ${label}`);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelect(label: string, value: string) {
  const select = container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`);
  if (!select) throw new Error(`no ${label}`);
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
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
    setSelect("Never use", "pi");
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

// MEDIUM 3: a project with no policy of its own loads the system's. A save that did not edit the policy must not
// write a copy of it under the project, which would silently replace the system's Never use and lock.
it("a save that does not touch the lock or lists does not write the policy", async () => {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "crew_rules_get") {
      return Promise.resolve({
        rules: [pathRule],
        revision: 4,
        policy: { lockDefault: false, neverUse: ["codex"], fallback: [] },
        policyOwn: false,
        signedIn: [],
      });
    }
    if (cmd === "crew_rules_set") return Promise.resolve({ revision: 5, rules: [pathRule], policy: { lockDefault: false, neverUse: ["codex"], fallback: [] }, policyOwn: false });
    return Promise.resolve(undefined);
  });
  show();
  await act(async () => undefined);
  expect(container.querySelector("[data-policy-inherited]")).not.toBeNull();
  expect(container.textContent).toContain("From everything");
  await act(async () => {
    click("Save");
  });
  expect(calls("crew_rules_set")).toHaveLength(1);
  expect(calls("crew_policy_set")).toEqual([]);
});

// Item 8: "For this project" needs a project. A Mono home or a plain folder is not one.
it("offers no project scope for a folder that is not a project", async () => {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "crew_rules_get") {
      return Promise.resolve({ rules: [], revision: 0, policy: { lockDefault: false, neverUse: [], fallback: [] }, signedIn: [] });
    }
    return Promise.resolve(undefined);
  });
  act(() => {
    root.render(createElement(CrewDefaults, { cwd: "/tmp/mono-home" }));
  });
  await act(async () => undefined);
  expect(container.querySelector<HTMLInputElement>('[aria-label="For this project"]')?.disabled).toBe(true);
  expect(container.querySelector<HTMLInputElement>('[aria-label="For everything"]')?.checked).toBe(true);
  expect(calls("crew_rules_get").at(-1)).toMatchObject({ scope: "system", scopeId: "system" });
});

it("saves for this project or for everything, and says which", async () => {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "crew_rules_get") {
      return Promise.resolve({
        rules: [],
        revision: 2,
        policy: { lockDefault: false, neverUse: [], fallback: [] },
        signedIn: [],
      });
    }
    if (cmd === "crew_rules_set") return Promise.resolve({ revision: 3, rules: [] });
    if (cmd === "crew_policy_set") {
      return Promise.resolve({
        revision: 4,
        rules: [],
        policy: { lockDefault: false, neverUse: [], fallback: [] },
      });
    }
    return Promise.resolve(undefined);
  });
  show();
  await act(async () => undefined);
  const project = container.querySelector<HTMLInputElement>('[aria-label="For this project"]');
  const everything = container.querySelector<HTMLInputElement>('[aria-label="For everything"]');
  expect(project?.checked).toBe(true);
  expect(everything?.checked).toBe(false);
  expect(container.textContent).toContain("For this project");
  expect(container.textContent).toContain("For everything");
  expect(calls("crew_rules_get").at(-1)).toMatchObject({ scope: "project", scopeId: "/work/app" });
  await act(async () => {
    everything?.click();
  });
  await act(async () => undefined);
  expect(everything?.checked).toBe(true);
  expect(calls("crew_rules_get").at(-1)).toMatchObject({ scope: "system", scopeId: "system" });
  await act(async () => {
    click("Save");
  });
  expect(calls("crew_rules_set").at(-1)).toMatchObject({ scope: "system", scopeId: "system" });
  // The lock and lists were not edited here, so only the roles were written.
  expect(calls("crew_policy_set")).toEqual([]);

  act(() => {
    root.render(createElement(CrewDefaults, {}));
  });
  await act(async () => undefined);
  expect(container.querySelector<HTMLInputElement>('[aria-label="For this project"]')?.disabled).toBe(true);
  expect(container.querySelector<HTMLInputElement>('[aria-label="For everything"]')?.checked).toBe(true);
  expect(calls("crew_rules_get").at(-1)).toMatchObject({ scope: "system", scopeId: "system" });
});

it("a save keeps a role rule where it was, and keeps a second rule for that role", async () => {
  const first: CrewRule = { labels: ["builder"], paths: [], cli: "grok", source: "person" };
  const second: CrewRule = { labels: ["builder"], paths: [], cli: "codex", source: "person" };
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "crew_rules_get") {
      return Promise.resolve({
        rules: [first, pathRule, second],
        revision: 4,
        policy: { lockDefault: false, neverUse: [], fallback: [] },
        signedIn: [],
      });
    }
    if (cmd === "crew_rules_set") return Promise.resolve({ revision: 5, rules: [first, pathRule, second] });
    if (cmd === "crew_policy_set") {
      return Promise.resolve({
        revision: 6,
        rules: [first, pathRule, second],
        policy: { lockDefault: false, neverUse: [], fallback: [] },
      });
    }
    return Promise.resolve(undefined);
  });
  show();
  await act(async () => undefined);
  await act(async () => {
    setSelect("Builder CLI", "claude");
  });
  await act(async () => {
    click("Save");
  });
  const sent = (calls("crew_rules_set").at(-1)?.rules ?? []) as { labels: string[]; cli: string | null }[];
  expect(sent.map((rule) => rule.labels[0])).toEqual(["builder", "ui", "builder"]);
  expect(sent[0]?.cli).toBe("claude");
  expect(sent[2]?.cli).toBe("codex");
});

it("says so when Never use rejects what was typed", async () => {
  act(() => {
    root.render(
      createElement(CrewDefaults, {
        initial: {
          policy: { lockDefault: false, neverUse: ["pi"], fallback: [] },
          rules: [],
          revision: 1,
          signedIn: [],
        },
      }),
    );
  });
  // WP-141 HIGH 3: the Never use control is a picker of CLIs, so a typed name cannot be saved as one.
  const options = [...(container.querySelectorAll<HTMLOptionElement>('[aria-label="Never use"] option'))].map((option) => option.value);
  expect(options).toEqual(["", "claude", "codex", "cursor", "opencode", "pi", "omp", "fx", "grok", "hermes", "devin", "antigravity"]);
  await act(async () => {
    setSelect("Never use", "pi");
  });
  await act(async () => {
    click("Add");
  });
  expect(container.querySelectorAll("[data-never-use]")).toHaveLength(1);
  expect(container.textContent).toContain("That is already on the list.");
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
