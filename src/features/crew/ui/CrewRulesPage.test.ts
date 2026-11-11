// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { builderScale, resetWorkerPool } from "../../monos/model/workerPool";
import { CrewRulesPage } from "./CrewRulesPage";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  invokeMock.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function show(cwd = "/work/app") {
  act(() => {
    root.render(createElement(CrewRulesPage, { cwd }));
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

function click(name: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === name);
  if (!button) throw new Error(`no ${name}`);
  button.click();
}

function sets(): Record<string, unknown>[] {
  return invokeMock.mock.calls
    .filter((call) => call[0] === "crew_rules_set")
    .map((call) => (call[1] ?? {}) as Record<string, unknown>);
}

it("a late load does not wipe a rule added while it was in flight", async () => {
  let resolveGet: (value: unknown) => void = () => undefined;
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "crew_rules_get") return new Promise((resolve) => {
      resolveGet = resolve;
    });
    return Promise.resolve(undefined);
  });
  show();
  await act(async () => {
    setValue("Labels for a new rule", "ui");
    setSelect("CLI for a new rule", "cursor");
  });
  await act(async () => {
    click("Add rule");
  });
  expect(container.querySelectorAll("[data-crew-rule]")).toHaveLength(1);
  await act(async () => {
    resolveGet({ rules: [], plugins: [], revision: 1, signedIn: [] });
  });
  expect(container.querySelectorAll("[data-crew-rule]")).toHaveLength(1);
  expect(container.querySelector<HTMLInputElement>('[aria-label="Labels for rule 1"]')?.value).toBe("ui");
  expect(container.querySelector<HTMLSelectElement>('[aria-label="CLI for rule 1"]')?.value).toBe("cursor");
});

it("a save that lands after a scope change does not set the new scope's revision", async () => {
  const gets: { scope: string; resolve: (value: unknown) => void }[] = [];
  let resolveSet: (value: unknown) => void = () => undefined;
  invokeMock.mockImplementation((cmd: string, args?: unknown) => {
    const sent = (args ?? {}) as { scope?: string };
    if (cmd === "crew_rules_get") {
      return new Promise((resolve) => {
        gets.push({ scope: sent.scope ?? "", resolve });
      });
    }
    if (cmd === "crew_rules_set") {
      return new Promise((resolve) => {
        resolveSet = resolve;
      });
    }
    return Promise.resolve(undefined);
  });
  show();
  await act(async () => undefined);
  await act(async () => {
    gets[0]?.resolve({ rules: [], plugins: [], revision: 3, signedIn: [] });
  });
  await act(async () => {
    click("Save");
  });
  await act(async () => {
    click("A Mono");
  });
  await act(async () => {
    setValue("Mono", "lead-1");
  });
  await act(async () => undefined);
  const mono = gets.find((item) => item.scope === "mono");
  await act(async () => {
    mono?.resolve({ rules: [], plugins: [], revision: 0, signedIn: [] });
  });
  await act(async () => {
    resolveSet({ rules: [], plugins: [], revision: 4, signedIn: [] });
  });
  expect(container.textContent).toMatch(/other place|another window/);
  await act(async () => {
    click("Save");
  });
  const last = sets().at(-1);
  expect(last?.scope).toBe("mono");
  expect(last?.revision).toBe(0);
});

it("shows a lost save when the stored revision is not the one just written", async () => {
  let reads = 0;
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "crew_rules_get") {
      reads += 1;
      const revision = reads === 1 ? 1 : 9;
      return Promise.resolve({ rules: [], plugins: [], revision, signedIn: [] });
    }
    if (cmd === "crew_rules_set") return Promise.resolve({ rules: [], plugins: [], revision: 2, signedIn: [] });
    return Promise.resolve(undefined);
  });
  show();
  await act(async () => undefined);
  await act(async () => {
    click("Save");
  });
  expect(container.textContent).toContain("saved in another window");
  await act(async () => {
    click("Save");
  });
  expect(sets().at(-1)?.revision).toBe(1);
});

it("says on Crew defaults that the builder pauses apply to all projects", async () => {
  invokeMock.mockImplementation((cmd: string) =>
    cmd === "crew_rules_get"
      ? Promise.resolve({ rules: [], plugins: [], revision: 0, signedIn: [] })
      : Promise.resolve(undefined),
  );
  show();
  await act(async () => undefined);
  const pauses = container.querySelector("[data-builder-pauses]");
  expect(pauses?.textContent).toContain("Pause new builders when");
  expect(pauses?.textContent).toContain("These pauses apply to all projects.");
});

it("shows the free disk pause on at 30 GB from the start, and lets the person turn it off and back on", async () => {
  resetWorkerPool();
  invokeMock.mockImplementation((cmd: string) =>
    cmd === "crew_rules_get"
      ? Promise.resolve({ rules: [], plugins: [], revision: 0, signedIn: [] })
      : Promise.resolve(undefined),
  );
  show();
  await act(async () => undefined);
  const check = () => container.querySelector<HTMLInputElement>("[data-builder-pause-on='disk']")!;
  const floor = () => container.querySelector<HTMLInputElement>("[data-builder-pause='disk']")!;
  const line = () => container.querySelector("[data-builder-scale-line]")?.textContent ?? "";
  expect(check().checked).toBe(true);
  expect(floor().value).toBe("30");
  expect(floor().disabled).toBe(false);
  expect(line()).toContain("New builders pause when free disk is below 30 GB.");
  expect(builderScale().pauseFreeDiskGb).toBe(30);

  act(() => check().click());
  expect(check().checked).toBe(false);
  expect(floor().disabled).toBe(true);
  expect(line()).toContain("Free disk is not checked.");
  expect(builderScale().pauseFreeDiskGb).toBeNull();

  // On again: back to 30, not to some old value, and the person can change it.
  act(() => check().click());
  expect(check().checked).toBe(true);
  expect(floor().value).toBe("30");
  setValue("Free disk limit in GB", "50");
  expect(builderScale().pauseFreeDiskGb).toBe(50);
  expect(line()).toContain("free disk is below 50 GB");
});
