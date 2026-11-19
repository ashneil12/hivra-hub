// @vitest-environment happy-dom
// SC-5: the checker's family rule in Settings. A late reply never lands on a newer choice, a value this build doesn't know is
// never shown as if it were one, and nothing is written on top of a value that was never read.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { CheckerFamilySetting } from "./CheckerFamilySetting";
import { CHECKER_FAMILY_RULES, readCheckerFamilyRule } from "../model/checkerFamily";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("the checker's family rule", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(invoke).mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const radio = (label: string): HTMLInputElement => {
    const found = [...container.querySelectorAll<HTMLInputElement>("input[type='radio']")].find(
      (input) => input.getAttribute("aria-label") === label,
    );
    if (!found) throw new Error(`missing ${label}`);
    return found;
  };
  const calls = () => vi.mocked(invoke).mock.calls.map((call) => [call[0], call[1]]);

  async function show() {
    await act(async () => {
      root.render(createElement(CheckerFamilySetting));
    });
  }

  it("shows the two choices with a different family chosen and marked as the default", async () => {
    vi.mocked(invoke).mockResolvedValue("different");
    await show();
    await vi.waitFor(() => expect(container.querySelectorAll("input[type='radio']")).toHaveLength(2));
    expect(radio("A different model family").checked).toBe(true);
    expect(radio("Any model").checked).toBe(false);
    expect(container.querySelector("[data-checker-family='different']")?.textContent).toContain("Default");
    // Looking at it writes nothing.
    expect(calls()).toEqual([["checker_family_rule_get", undefined]]);
  });

  it("writes a pick and shows it only once the save comes back", async () => {
    let save: (value: string) => void = () => {};
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "checker_family_rule_get") return "different";
      return new Promise<string>((resolve) => {
        save = resolve;
      });
    });
    await show();
    await vi.waitFor(() => expect(container.querySelectorAll("input[type='radio']")).toHaveLength(2));
    await act(async () => {
      radio("Any model").click();
    });
    expect(calls()[1]).toEqual(["checker_family_rule_set", { rule: "any" }]);
    // While it is saving the choice is shown and the list can't be changed again.
    expect(container.querySelector("[role='radiogroup']")?.getAttribute("aria-busy")).toBe("true");
    expect(radio("Any model").disabled).toBe(true);
    await act(async () => {
      save("any");
    });
    expect(radio("Any model").checked).toBe(true);
    expect(radio("A different model family").checked).toBe(false);
    expect(container.querySelector("[role='radiogroup']")?.getAttribute("aria-busy")).toBe("false");
  });

  it("goes back to what is stored when the save fails, and says so", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "checker_family_rule_get") return "different";
      throw new Error("the database is busy");
    });
    await show();
    await vi.waitFor(() => expect(container.querySelectorAll("input[type='radio']")).toHaveLength(2));
    await act(async () => {
      radio("Any model").click();
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Couldn't save this setting. Try again."));
    expect(radio("A different model family").checked).toBe(true);
    expect(radio("Any model").checked).toBe(false);
  });

  it("writes nothing when the read failed, and offers to read again", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("timed out"));
    await show();
    await vi.waitFor(() => expect(container.textContent).toContain("Couldn't read this setting."));
    // No choice is shown as if it were the stored one.
    expect(container.querySelectorAll("input[type='radio']")).toHaveLength(0);
    vi.mocked(invoke).mockResolvedValue("any");
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-checker-family-retry]")?.click();
    });
    await vi.waitFor(() => expect(radio("Any model").checked).toBe(true));
    expect(calls().map(([cmd]) => cmd)).toEqual(["checker_family_rule_get", "checker_family_rule_get"]);
    expect(container.querySelector("[data-checker-family-note]")).toBeNull();
  });

  it("does not show a word it doesn't know as a choice", async () => {
    vi.mocked(invoke).mockResolvedValue("same");
    await show();
    await vi.waitFor(() => expect(container.textContent).toContain("Couldn't read this setting."));
    expect(container.querySelectorAll("input[type='radio']")).toHaveLength(0);
    expect(calls().map(([cmd]) => cmd)).toEqual(["checker_family_rule_get"]);
  });

  it("reads a rule only from the two words the app knows", () => {
    for (const rule of CHECKER_FAMILY_RULES) expect(readCheckerFamilyRule(rule)).toBe(rule);
    for (const value of ["same", "", "Different", "any ", null, undefined, 1, {}, ["any"]]) {
      expect(readCheckerFamilyRule(value), String(value)).toBeNull();
    }
  });
});
