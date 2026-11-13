// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TESTING_MODES, TESTING_MODE_WORDS, type TestingMode } from "../model/testingMode";
import { TestingModeSetting, projectChoices } from "./TestingModeSetting";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const STALE = "Those delivery settings changed in another window. Look again, then set them.";

type Row = { testingMode: TestingMode | null; updatedAt: number | null };

describe("how tasks are tested (Settings)", () => {
  let container: HTMLDivElement;
  let root: Root;
  /** One row per project, as the app keeps them. */
  let rows: Map<string, Row>;
  let stale: boolean;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    rows = new Map();
    stale = false;
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
      const { project, mode, expectedUpdatedAt } = (args ?? {}) as {
        project: string;
        mode?: TestingMode;
        expectedUpdatedAt?: number | null;
      };
      const row = rows.get(project) ?? { testingMode: null, updatedAt: null };
      if (command === "delivery_settings_get") {
        return {
          project,
          testingMode: row.testingMode ?? "at-ship",
          testingDefaulted: row.testingMode === null,
          updatedAt: row.updatedAt,
        };
      }
      if (command === "delivery_testing_mode_set") {
        if (stale || row.updatedAt !== (expectedUpdatedAt ?? null)) throw STALE;
        const next = { testingMode: mode ?? null, updatedAt: (row.updatedAt ?? 0) + 1 };
        rows.set(project, next);
        return { project, ...next };
      }
      throw new Error(command);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function show(props: { project: string; home?: boolean; recents?: { path: string }[] }) {
    await act(async () => {
      root.render(createElement(TestingModeSetting, { home: false, ...props }));
    });
  }

  const option = (mode: TestingMode) => container.querySelector<HTMLElement>(`[data-testing-mode='${mode}']`);
  const radio = (mode: TestingMode) => container.querySelector<HTMLInputElement>(`input[aria-label='${TESTING_MODE_WORDS[mode].label}']`);
  const note = () => container.querySelector("[data-testing-mode-note]")?.textContent ?? null;
  const calls = (command: string) => vi.mocked(invoke).mock.calls.filter(([name]) => name === command);

  async function pick(mode: TestingMode) {
    await act(async () => {
      radio(mode)?.click();
    });
  }

  it("shows the four options with their words in full, and the default chosen", async () => {
    await show({ project: "/work/app" });
    await vi.waitFor(() => expect(option("at-ship")).not.toBeNull());
    const group = container.querySelector("[role='radiogroup']");
    expect(group?.getAttribute("aria-label")).toBe("How tasks are tested");
    expect([...container.querySelectorAll("[data-testing-mode]")].map((el) => el.getAttribute("data-testing-mode"))).toEqual([
      "at-ship",
      "light",
      "full",
      "off",
    ]);
    for (const mode of TESTING_MODES) {
      const words = TESTING_MODE_WORDS[mode];
      expect(option(mode)?.textContent).toContain(words.label);
      // The line under the name is there whole, never cut short.
      expect(option(mode)?.textContent).toContain(words.description);
      expect(radio(mode)?.getAttribute("aria-label")).toBe(words.label);
      expect(radio(mode)?.type).toBe("radio");
    }
    expect(radio("at-ship")?.checked).toBe(true);
    for (const mode of ["light", "full", "off"] as const) expect(radio(mode)?.checked).toBe(false);
    expect(option("at-ship")?.textContent).toContain("Default");
    expect(option("light")?.textContent).not.toContain("Default");
    expect(container.textContent).toContain("For app.");
    expect(container.textContent).not.toMatch(/[—–]|Stuck|\bMono\b/);
    expect(calls("delivery_settings_get")).toEqual([["delivery_settings_get", { project: "/work/app" }]]);
    expect(container.querySelector("[data-setting-id='testing-mode']")).not.toBeNull();
  });

  it("shows the project's own choice", async () => {
    rows.set("/work/app", { testingMode: "full", updatedAt: 4 });
    await show({ project: "/work/app" });
    await vi.waitFor(() => expect(radio("full")?.checked).toBe(true));
    expect(radio("at-ship")?.checked).toBe(false);
  });

  it("writes on top of the last updatedAt: none on a project with no row, then the one it got back", async () => {
    await show({ project: "/work/app" });
    await vi.waitFor(() => expect(option("light")).not.toBeNull());
    await pick("light");
    await vi.waitFor(() => expect(radio("light")?.checked).toBe(true));
    expect(calls("delivery_testing_mode_set")[0]).toEqual([
      "delivery_testing_mode_set",
      { project: "/work/app", mode: "light", expectedUpdatedAt: null },
    ]);
    expect(radio("at-ship")?.checked).toBe(false);
    expect(note()).toBeNull();
    await pick("off");
    await vi.waitFor(() => expect(radio("off")?.checked).toBe(true));
    expect(calls("delivery_testing_mode_set")[1]).toEqual([
      "delivery_testing_mode_set",
      { project: "/work/app", mode: "off", expectedUpdatedAt: 1 },
    ]);
    expect(rows.get("/work/app")).toEqual({ testingMode: "off", updatedAt: 2 });
  });

  it("says so in one grey line when another window changed it, and shows what is stored now", async () => {
    await show({ project: "/work/app" });
    await vi.waitFor(() => expect(option("light")).not.toBeNull());
    // Another window chooses Full after this one read.
    rows.set("/work/app", { testingMode: "full", updatedAt: 9 });
    await pick("off");
    await vi.waitFor(() => expect(note()).toBe(STALE));
    // What shows is what the app holds, not what was clicked.
    await vi.waitFor(() => expect(radio("full")?.checked).toBe(true));
    expect(radio("off")?.checked).toBe(false);
    expect(container.querySelector("[data-testing-mode-note]")?.className).toContain("text-content/60");
    expect(container.querySelector("[data-testing-mode-retry]")).toBeNull();
    // The next pick is based on the row it just read, and goes through.
    await pick("off");
    await vi.waitFor(() => expect(radio("off")?.checked).toBe(true));
    const writes = calls("delivery_testing_mode_set");
    expect(writes[writes.length - 1]?.[1]).toMatchObject({ mode: "off", expectedUpdatedAt: 9 });
    expect(note()).toBeNull();
  });

  it("keeps what was stored when a write fails, and says it didn't go through", async () => {
    await show({ project: "/work/app" });
    await vi.waitFor(() => expect(option("light")).not.toBeNull());
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "delivery_testing_mode_set") throw new Error("timed out");
      return { testingMode: "at-ship", testingDefaulted: true, updatedAt: null };
    });
    await pick("full");
    await vi.waitFor(() => expect(note()).toBe("That didn't go through. Try again."));
    expect(radio("at-ship")?.checked).toBe(true);
    expect(radio("full")?.checked).toBe(false);
    // A timeout is not final: the options are still there to pick again.
    expect(radio("full")?.disabled).toBe(false);
  });

  it("ignores a late read from the project it left", async () => {
    let release: (value: unknown) => void = () => {};
    vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
      const { project } = (args ?? {}) as { project: string };
      if (command === "delivery_settings_get" && project === "/work/one") {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return { testingMode: "off", testingDefaulted: false, updatedAt: 2 };
    });
    await show({ project: "/work/one" });
    expect(container.querySelector("[role='radiogroup']")).toBeNull();
    expect(container.textContent).toContain("Reading what one uses.");
    await show({ project: "/work/two" });
    await vi.waitFor(() => expect(radio("off")?.checked).toBe(true));
    await act(async () => {
      release({ testingMode: "full", testingDefaulted: false, updatedAt: 8 });
    });
    expect(radio("off")?.checked).toBe(true);
    expect(radio("full")?.checked).toBe(false);
    expect(container.textContent).toContain("For two.");
  });

  it("ignores a late write from the project it left", async () => {
    let finish: (value: unknown) => void = () => {};
    vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
      const { project } = (args ?? {}) as { project: string };
      if (command === "delivery_testing_mode_set") {
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return { testingMode: project === "/work/one" ? "at-ship" : "off", testingDefaulted: project === "/work/one", updatedAt: null };
    });
    await show({ project: "/work/one" });
    await vi.waitFor(() => expect(option("light")).not.toBeNull());
    await pick("full");
    // While it is out the options wait, and the pick shows as chosen.
    expect(radio("full")?.checked).toBe(true);
    expect(radio("light")?.disabled).toBe(true);
    await show({ project: "/work/two" });
    await vi.waitFor(() => expect(radio("off")?.checked).toBe(true));
    await act(async () => {
      finish({ testingMode: "full", updatedAt: 3 });
    });
    expect(radio("off")?.checked).toBe(true);
    expect(radio("full")?.checked).toBe(false);
  });

  it("says when it can't read, and reads again on Try again", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("unreachable"));
    await show({ project: "/work/app" });
    await vi.waitFor(() => expect(note()).toContain("That didn't go through. Try again."));
    expect(container.querySelector("[role='radiogroup']")).toBeNull();
    const retry = container.querySelector<HTMLButtonElement>("[data-testing-mode-retry]");
    expect(retry?.textContent).toBe("Try again");
    await act(async () => {
      retry?.click();
    });
    await vi.waitFor(() => expect(radio("at-ship")?.checked).toBe(true));
    expect(note()).toBeNull();
  });

  it("reads a word it doesn't know as the default", async () => {
    vi.mocked(invoke).mockResolvedValue({ testingMode: "paranoid", testingDefaulted: false, updatedAt: 5 });
    await show({ project: "/work/app" });
    await vi.waitFor(() => expect(radio("at-ship")?.checked).toBe(true));
    for (const mode of ["light", "full", "off"] as const) expect(radio(mode)?.checked).toBe(false);
  });

  it("asks nothing and shows no options with no project open", async () => {
    await show({ project: "" });
    expect(container.textContent).toContain("Open a project to choose how its tasks are tested.");
    expect(container.querySelector("[role='radiogroup']")).toBeNull();
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
    expect(container.querySelector("[data-setting-id='testing-mode']")).not.toBeNull();
  });

  it("from Home asks for a project first and reads nothing until one is picked", async () => {
    await show({ project: "/work/last-project", home: true, recents: [{ path: "/work/other" }] });
    expect(container.textContent).toContain("Pick a project to see how its tasks are tested.");
    expect(container.querySelector("[data-testing-mode-project]")).not.toBeNull();
    expect(container.textContent).toContain("Choose a project");
    expect(container.querySelector("[role='radiogroup']")).toBeNull();
    // The project Home was last in is not read for it.
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
    expect(container.querySelector("[data-setting-id='testing-mode']")).not.toBeNull();
  });
});

describe("the projects a person can pick from Home", () => {
  it("lists the open one first, then the recent ones, each once, by name", () => {
    expect(
      projectChoices("/work/app", [{ path: "/work/other" }, { path: "/work/app" }, { path: "/work/other/" }, { path: "" }]),
    ).toEqual([
      { value: "/work/app", label: "app" },
      { value: "/work/other", label: "other" },
    ]);
    expect(projectChoices("", undefined)).toEqual([]);
    expect(projectChoices("", [{ path: "/work/my app/é" }])).toEqual([{ value: "/work/my app/é", label: "é" }]);
  });
});
