// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const isTauri = vi.hoisted(() => vi.fn(() => true));

vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  isTauri,
}));

import {
  DICTATION_SETTING_DESCRIPTION,
  DICTATION_SETTING_EVENT,
  dictationSettingShown,
  loadDictationSetting,
  saveDictationSetting,
} from "./dictationSetting";

beforeEach(() => {
  invoke.mockReset();
  isTauri.mockReturnValue(true);
});

describe("dictation setting", () => {
  it("only a true answer is on", async () => {
    invoke.mockResolvedValueOnce(true);
    expect(await loadDictationSetting()).toBe(true);
    invoke.mockResolvedValueOnce(false);
    expect(await loadDictationSetting()).toBe(false);
    invoke.mockResolvedValueOnce("on");
    expect(await loadDictationSetting()).toBe(false);
  });

  it("a thrown call is off", async () => {
    invoke.mockRejectedValue(new Error("no"));
    expect(await loadDictationSetting()).toBe(false);
    expect(await saveDictationSetting(true)).toBe(false);
  });

  it("outside the app it stays off and does not call the app", async () => {
    isTauri.mockReturnValue(false);
    expect(await loadDictationSetting()).toBe(false);
    expect(await saveDictationSetting(true)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("saving tells the composer the answer the app gave", async () => {
    invoke.mockResolvedValue(true);
    const seen: boolean[] = [];
    const onSetting = (event: Event) => {
      seen.push((event as CustomEvent<boolean>).detail);
    };
    window.addEventListener(DICTATION_SETTING_EVENT, onSetting);
    try {
      expect(await saveDictationSetting(true)).toBe(true);
    } finally {
      window.removeEventListener(DICTATION_SETTING_EVENT, onSetting);
    }
    expect(seen).toEqual([true]);
    expect(invoke).toHaveBeenCalledWith("dictation_set_setting", { on: true });
  });

  it("is shown only in the Mac app", () => {
    expect(dictationSettingShown(true, "MacIntel")).toBe(true);
    expect(dictationSettingShown(true, "Win32")).toBe(false);
    expect(dictationSettingShown(true, "Linux x86_64")).toBe(false);
    expect(dictationSettingShown(false, "MacIntel")).toBe(false);
    expect(dictationSettingShown(true, "")).toBe(false);
  });

  it("the words a person reads have no dash and no path", () => {
    expect(DICTATION_SETTING_DESCRIPTION).not.toMatch(/[–—]/);
    expect(DICTATION_SETTING_DESCRIPTION).not.toContain("/");
  });
});
