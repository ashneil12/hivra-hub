// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowsProjectNotification } from "../model/notificationPreferences";
import { loadQuietHours, QUIET_HOURS_KEY } from "../model/quietHours";
import { QuietHoursSetting } from "./QuietHoursSetting";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render() {
  act(() => root.render(createElement(QuietHoursSetting)));
}

/** React ignores a raw `.value` write. Set the DOM value the way a person would. */
function setTime(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  act(() => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("QuietHoursSetting", () => {
  it("turns the overnight window on, and an empty time does not wipe it", () => {
    render();
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Quiet hours"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    const start = container.querySelector<HTMLInputElement>('[aria-label="Quiet hours start"]')!;
    const end = container.querySelector<HTMLInputElement>('[aria-label="Quiet hours end"]')!;
    expect(start.value).toBe("22:00");
    expect(end.value).toBe("08:00");

    act(() => toggle.click());
    expect(loadQuietHours().enabled).toBe(true);
    setTime(start, "");
    expect(loadQuietHours()).toEqual({ enabled: true, start: "22:00", end: "08:00" });

    setTime(end, "07:00");
    expect(loadQuietHours().end).toBe("07:00");
    // the switch is the real gate: what every banner and sound asks before it shows
    const night = new Date(2026, 10, 10, 23, 30).getTime();
    expect(allowsProjectNotification({ projectId: "work", category: "agentFinished" }, night)).toBe(false);
    expect(allowsProjectNotification({ projectId: "work", category: "agentInput" }, night)).toBe(true);
    act(() => toggle.click());
    expect(allowsProjectNotification({ projectId: "work", category: "agentFinished" }, night)).toBe(true);
  });

  it("follows a change written by another window", () => {
    render();
    localStorage.setItem(
      QUIET_HOURS_KEY,
      JSON.stringify({ enabled: true, start: "23:00", end: "06:00" }),
    );
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: QUIET_HOURS_KEY }));
    });
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Quiet hours"]')!;
    const start = container.querySelector<HTMLInputElement>('[aria-label="Quiet hours start"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(start.value).toBe("23:00");
  });
});
