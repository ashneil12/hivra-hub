// WP-131c: the Composer setting that turns dictation on. The file lives in the app, not in local storage.
// Off until it says on. Outside the Mac app there is no dictation, so this stays off and shows nothing.
import { invoke, isTauri } from "@tauri-apps/api/core";

export const DICTATION_SETTING_EVENT = "monocode:dictationsetting";
export const DICTATION_SETTING_LABEL = "Dictation";
export const DICTATION_SETTING_DESCRIPTION =
  "Turns on dictation in the composer. The microphone stays in a helper, and nothing is sent until you press Send. Off until you turn it on.";

function inApp(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

/** The row is only in the Mac app. Windows and Linux have no dictation, so the switch is not shown there. */
export function dictationSettingShown(inDesktopApp: boolean, platform: string): boolean {
  return inDesktopApp && /mac/i.test(platform);
}

export function dictationSettingIsShown(): boolean {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  return dictationSettingShown(inApp(), platform);
}

function tellComposer(on: boolean): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<boolean>(DICTATION_SETTING_EVENT, { detail: on }));
}

/** The saved setting. Not the app, a thrown call, or any answer other than true is off. */
export async function loadDictationSetting(): Promise<boolean> {
  if (!inApp()) return false;
  try {
    return (await invoke<boolean>("dictation_setting")) === true;
  } catch {
    return false;
  }
}

/** Saves it and tells the composer. A failed save, or a save outside the app, stays off. */
export async function saveDictationSetting(on: boolean): Promise<boolean> {
  if (!inApp()) {
    tellComposer(false);
    return false;
  }
  try {
    const saved = (await invoke<boolean>("dictation_set_setting", { on })) === true;
    tellComposer(saved);
    return saved;
  } catch {
    tellComposer(false);
    return false;
  }
}
