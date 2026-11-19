// @vitest-environment happy-dom
// PT-4: "When the checker runs" in Settings. Unset reads as "Follow the testing mode" and says so; a pick is written whole and shown
// only once the save comes back; a late reply never lands on a newer choice; a value this build doesn't know is never shown as if it
// were one; nothing is written on top of a value that was never read; the longer explanation is behind More.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { CheckerWhenSetting } from "./CheckerWhenSetting";
import {
  CHECKER_WHEN_DETAILS,
  CHECKER_WHEN_RULES,
  CHECKER_WHEN_WORDS,
  DEFAULT_CHECKER_WHEN_RULE,
  readCheckerWhenRule,
} from "../model/checkerWhen";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("when the checker runs", () => {
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
  const radios = () => container.querySelectorAll("input[type='radio']");

  async function show() {
    await act(async () => {
      root.render(createElement(CheckerWhenSetting));
    });
  }

  it("shows the four choices with Follow the testing mode chosen and marked as the default when nothing was saved", async () => {
    vi.mocked(invoke).mockResolvedValue(DEFAULT_CHECKER_WHEN_RULE);
    await show();
    await vi.waitFor(() => expect(radios()).toHaveLength(4));
    expect(DEFAULT_CHECKER_WHEN_RULE).toBe("follow-mode");
    expect(radio("Follow the testing mode").checked).toBe(true);
    for (const label of ["Every code change", "Only risky changes", "Off"]) expect(radio(label).checked).toBe(false);
    expect(container.querySelector("[data-checker-when='follow-mode']")?.textContent).toContain("Default");
    for (const rule of CHECKER_WHEN_RULES) {
      expect(container.querySelector(`[data-checker-when='${rule}']`)?.textContent).toContain(CHECKER_WHEN_WORDS[rule].description);
    }
    expect(container.querySelector("[role='radiogroup']")?.getAttribute("aria-label")).toBe("When the checker runs");
    // Looking at it writes nothing.
    expect(calls()).toEqual([["checker_when_rule_get", undefined]]);
  });

  it("keeps a saved choice and shows no Default mark on it", async () => {
    vi.mocked(invoke).mockResolvedValue("risky-only");
    await show();
    await vi.waitFor(() => expect(radios()).toHaveLength(4));
    expect(radio("Only risky changes").checked).toBe(true);
    expect(radio("Follow the testing mode").checked).toBe(false);
    // The mark names the default option, not the saved one.
    expect(container.querySelector("[data-checker-when='risky-only']")?.textContent).not.toContain("Default");
    expect(container.querySelector("[data-checker-when='follow-mode']")?.textContent).toContain("Default");
  });

  it("writes a pick whole and shows it only once the save comes back", async () => {
    let save: (value: string) => void = () => {};
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "checker_when_rule_get") return "follow-mode";
      return new Promise<string>((resolve) => {
        save = resolve;
      });
    });
    await show();
    await vi.waitFor(() => expect(radios()).toHaveLength(4));
    await act(async () => {
      radio("Every code change").click();
    });
    expect(calls()[1]).toEqual(["checker_when_rule_set", { rule: "every-code-change" }]);
    // While it is saving the choice is shown and the list can't be changed again.
    expect(container.querySelector("[role='radiogroup']")?.getAttribute("aria-busy")).toBe("true");
    expect(radio("Off").disabled).toBe(true);
    await act(async () => {
      save("every-code-change");
    });
    expect(radio("Every code change").checked).toBe(true);
    expect(radio("Follow the testing mode").checked).toBe(false);
    expect(container.querySelector("[role='radiogroup']")?.getAttribute("aria-busy")).toBe("false");
  });

  it("goes back to what is stored when the save fails, and says so", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "checker_when_rule_get") return "follow-mode";
      throw new Error("the database is busy");
    });
    await show();
    await vi.waitFor(() => expect(radios()).toHaveLength(4));
    await act(async () => {
      radio("Off").click();
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Couldn't save this setting. Try again."));
    expect(radio("Follow the testing mode").checked).toBe(true);
    expect(radio("Off").checked).toBe(false);
  });

  it("refuses an answer to a save that isn't a rule it knows, and keeps what was stored", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "checker_when_rule_get" ? "follow-mode" : "everything"));
    await show();
    await vi.waitFor(() => expect(radios()).toHaveLength(4));
    await act(async () => {
      radio("Off").click();
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Couldn't save this setting. Try again."));
    expect(radio("Follow the testing mode").checked).toBe(true);
  });

  it("writes nothing when the read failed, and offers to read again", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("timed out"));
    await show();
    await vi.waitFor(() => expect(container.textContent).toContain("Couldn't read this setting."));
    // No choice is shown as if it were the stored one.
    expect(radios()).toHaveLength(0);
    vi.mocked(invoke).mockResolvedValue("off");
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-checker-when-retry]")?.click();
    });
    await vi.waitFor(() => expect(radio("Off").checked).toBe(true));
    expect(calls().map(([cmd]) => cmd)).toEqual(["checker_when_rule_get", "checker_when_rule_get"]);
    expect(container.querySelector("[data-checker-when-note]")).toBeNull();
  });

  it("does not show a word it doesn't know as a choice", async () => {
    vi.mocked(invoke).mockResolvedValue("every-change");
    await show();
    await vi.waitFor(() => expect(container.textContent).toContain("Couldn't read this setting."));
    expect(radios()).toHaveLength(0);
    expect(calls().map(([cmd]) => cmd)).toEqual(["checker_when_rule_get"]);
  });

  it("keeps the longer explanation behind More", async () => {
    vi.mocked(invoke).mockResolvedValue("follow-mode");
    await show();
    await vi.waitFor(() => expect(radios()).toHaveLength(4));
    expect(container.textContent).not.toContain(CHECKER_WHEN_DETAILS);
    const more = [...container.querySelectorAll("button")].find((button) => button.textContent === "More");
    expect(more).toBeTruthy();
    await act(async () => {
      more?.click();
    });
    expect(container.textContent).toContain(CHECKER_WHEN_DETAILS);
  });

  it("reads a rule only from the four words the app knows", () => {
    for (const rule of CHECKER_WHEN_RULES) expect(readCheckerWhenRule(rule)).toBe(rule);
    for (const value of ["different", "", "Follow-Mode", "off ", "risky", null, undefined, 1, {}, ["off"]]) {
      expect(readCheckerWhenRule(value), String(value)).toBeNull();
    }
  });

  it("uses the same four words as Rust, in the same order, with one plain line each and no dash or code name", () => {
    // happy-dom's URL isn't a file URL, so the path is from the folder the tests run in (the repo root).
    const rust = readFileSync(resolve(process.cwd(), "src-tauri/src/firstmate/checker_when.rs"), "utf8");
    for (const rule of CHECKER_WHEN_RULES) {
      expect(rust, rule).toContain(`"${rule}" => Some(`);
      expect(rust, rule).toContain(`=> "${rule}",`);
    }
    expect(rust).toContain("pub const DEFAULT_WHEN_RULE: WhenRule = WhenRule::FollowMode;");
    expect(CHECKER_WHEN_RULES).toEqual(["follow-mode", "every-code-change", "risky-only", "off"]);
    for (const { label, description } of Object.values(CHECKER_WHEN_WORDS)) {
      expect(`${label} ${description}`).not.toMatch(/[—–]|\bMono\b|Stuck|\bWP-|\bSC-|\bPT-/);
      expect(description.trim().length).toBeGreaterThan(0);
    }
    expect(CHECKER_WHEN_DETAILS).not.toMatch(/[—–]|Stuck|\bPT-/);
  });
});
