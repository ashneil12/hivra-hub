// @vitest-environment happy-dom
// Every Settings section has a row with an icon. A section added without one made the whole rail fail to draw.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SettingsNav } from "./SettingsRail";
import { SETTINGS_SECTIONS } from "../../features/settings/model/settings";

it("draws a row for every Settings section, Work log included", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onSelect = vi.fn();
  try {
    act(() => root.render(createElement(SettingsNav, { section: "work-log", onSelect, onClose: vi.fn() })));
    // Dropwave (Ash, 11 Nov): Advanced is folded until asked for, so its rows only draw once it is opened.
    const advanced = container.querySelector<HTMLButtonElement>('[data-settings-group="workspace"] button[aria-expanded]')!;
    expect(advanced.getAttribute("aria-expanded")).toBe("false");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Remote machines")).toBe(false);
    act(() => advanced.click());
    expect(advanced.getAttribute("aria-expanded")).toBe("true");
    const rows = [...container.querySelectorAll("button")];
    for (const section of SETTINGS_SECTIONS) {
      const row = rows.find((button) => button.textContent === section.label);
      expect(row, `a row for ${section.label}`).toBeTruthy();
      expect(row!.querySelector("svg"), `an icon for ${section.label}`).toBeTruthy();
    }
    const current = rows.find((button) => button.textContent === "Work log")!;
    expect(current.getAttribute("aria-current")).toBe("true");
    act(() => current.click());
    expect(onSelect).toHaveBeenCalledWith("work-log");
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
