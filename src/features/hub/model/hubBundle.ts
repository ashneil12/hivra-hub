// The MonoCode Hub bundle (src-tauri/tauri.hub.conf.json builds it with VITE_MONOCODE_HUB=1). It sits next to Ash's
// MonoCode with its own name, id and data, and differs from it only in what is set here. MonoCode's own defaults are
// untouched: none of this runs in a normal build.
import { defaultModelId, loadLastModelChoice, saveLastModelChoice } from "../../sessions/model/models";

export const IS_HUB_BUNDLE = import.meta.env.VITE_MONOCODE_HUB === "1";

/**
 * Dropwave: one chat look. A first mate's own chat (the Chief of Staff's too) uses the same composer, tab strip and
 * footer as any other chat, instead of the Mono view's own header and small message box.
 */
export const ONE_CHAT_LOOK = IS_HUB_BUNDLE;

const SEEDED = "monocode:hub-bundle-seeded";

/**
 * The project Leads are made in the Hub bundle, and on the dev page when it reads a stub or the live proxy (it sets
 * `monocode:hub-leads-dev`), so they can be seen without building the app.
 */
export function makesProjectLeads(): boolean {
  if (IS_HUB_BUNDLE) return true;
  try {
    return localStorage.getItem("monocode:hub-leads-dev") === "1";
  } catch {
    return false;
  }
}

/**
 * First run of the Hub bundle: new chats start on Claude Code (MonoCode's own fallback is Cursor). Only when nothing
 * was chosen yet, and only once, so Ash's later picks stick.
 */
export function seedHubBundleDefaults(isHub = IS_HUB_BUNDLE): void {
  if (!isHub) return;
  try {
    if (localStorage.getItem(SEEDED) === "1") return;
    if (!loadLastModelChoice()) saveLastModelChoice("claude", defaultModelId("claude"));
    localStorage.setItem(SEEDED, "1");
  } catch {
    /* no storage: MonoCode's defaults apply */
  }
}
