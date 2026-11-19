// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { StandingAnswersSetting } from "./StandingAnswersSetting";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../model/sounds", () => ({ playCue: vi.fn() }));

describe("standing answers setting", () => {
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

  function toggle(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>("[role='switch']");
    if (!button) throw new Error("missing switch");
    return button;
  }

  it("stays off when the read fails, and does not write that failure back", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("timed out"));
    await act(async () => {
      root.render(createElement(StandingAnswersSetting));
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Couldn't read this setting. Trying again."));
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(toggle().disabled).toBe(true);
    await act(async () => {
      toggle().click();
    });
    expect(vi.mocked(invoke).mock.calls.map((call) => call[0])).toEqual(["decisions_standing_enabled"]);
  });

  it("turns on only after the save comes back, and ignores a late read", async () => {
    let release: (value: boolean) => void = () => {};
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "decisions_standing_enabled") return new Promise<boolean>((resolve) => {
        release = resolve;
      });
      if (cmd === "decisions_set_standing_enabled") return true;
      throw new Error(cmd);
    });
    await act(async () => {
      root.render(createElement(StandingAnswersSetting));
    });
    expect(toggle().disabled).toBe(true);
    await act(async () => {
      release(false);
    });
    await vi.waitFor(() => expect(toggle().disabled).toBe(false));
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("Off until you turn this on.");

    let save: (value: boolean) => void = () => {};
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "decisions_set_standing_enabled") {
        return new Promise<boolean>((resolve) => {
          save = resolve;
        });
      }
      return false;
    });
    await act(async () => {
      toggle().click();
    });
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      release(true);
    });
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      save(true);
    });
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).not.toMatch(/[—–]/);
  });

  it("leaves the switch where it was when the save fails", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "decisions_standing_enabled") return true;
      throw new Error("timed out");
    });
    await act(async () => {
      root.render(createElement(StandingAnswersSetting));
    });
    await vi.waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
    await act(async () => {
      toggle().click();
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Couldn't save this setting. Trying again."));
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });
});
