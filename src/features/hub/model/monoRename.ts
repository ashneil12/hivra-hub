// ash-lead becomes hub-lead, once, when its folder can move. The same Mono keeps its chat, look and projects.
// If the folder cannot move, it keeps the old id and ensureProjectLeads reads that id as the hub lead, so a second
// hub-lead is never made beside it. If both ids are already on the roster, neither is renamed.
import { invoke } from "@tauri-apps/api/core";
import { findMono, renameMonoId, type Mono } from "../../monos/model/mono";

/** The id as a whole word in stored JSON or keys: "ash-lead", "ash-lead|/path", "retire:ash-lead:…". */
function idPattern(id: string): RegExp {
  return new RegExp(`(^|["|:])${id.replace(/[-]/g, "\\-")}(?=$|["|:])`, "g");
}

/** Never rewritten here: the roster has its own step, and these say nothing about who a Mono is. */
const SKIP_KEYS = new Set(["monocode:mono-roster", "monocode:mono-roster-saved-at", "monocode:mono-renamed-ash-lead"]);

/** Every `monocode:` record in the WebView that names `from` now names `to` (keys and values). Returns the keys changed. */
export function rewriteStoredIds(from: string, to: string, storage: Storage = localStorage): string[] {
  const pattern = idPattern(from);
  const changed: string[] = [];
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith("monocode:") && !SKIP_KEYS.has(key)) keys.push(key);
  }
  for (const key of keys) {
    const value = storage.getItem(key);
    if (value == null) continue;
    const nextKey = key.replace(pattern, `$1${to}`);
    const nextValue = value === from ? to : value.replace(pattern, `$1${to}`);
    if (nextKey === key && nextValue === value) continue;
    if (nextKey !== key) {
      if (storage.getItem(nextKey) != null) continue; // the new id already has its own record: keep it
      storage.removeItem(key);
    }
    storage.setItem(nextKey, nextValue);
    changed.push(key);
  }
  return changed;
}

export const LEGACY_HUB_LEAD = "ash-lead";
export const HUB_LEAD = "hub-lead";
const DONE_KEY = "monocode:mono-renamed-ash-lead";

export type RenameBackend = (from: string, to: string) => Promise<unknown>;
const tauriRename: RenameBackend = (from, to) => invoke("mono_rename", { from, to });

export type RenameResult = "renamed" | "not-needed" | "both-exist" | "failed";

/** The rename, once. Safe to call on every launch. A failed folder move leaves the old id in place. */
export async function renameAshLeadToHubLead(
  deps: {
    rename?: RenameBackend;
    unregister?: (monoId: string, projectId: string) => Promise<unknown>;
    storage?: Storage;
  } = {},
): Promise<RenameResult> {
  const { rename = tauriRename, unregister, storage = localStorage } = deps;
  if (!findMono(LEGACY_HUB_LEAD)) return "not-needed";
  if (findMono(HUB_LEAD)) {
    console.error("Both ash-lead and hub-lead are on the roster, so neither was renamed.");
    return "both-exist";
  }
  try {
    await rename(LEGACY_HUB_LEAD, HUB_LEAD);
  } catch (error) {
    console.error("Couldn't rename ash-lead's folder, so it keeps its id for now", error);
    return "failed";
  }
  renameMonoId(LEGACY_HUB_LEAD, HUB_LEAD, (mono: Mono) => {
    const { legacyProject: _, ...rest } = mono;
    return { ...rest, name: !mono.name || mono.name === "Harness lead" ? "MonoCode Hub lead" : mono.name };
  });
  rewriteStoredIds(LEGACY_HUB_LEAD, HUB_LEAD, storage);
  void unregister?.(LEGACY_HUB_LEAD, "hub")?.catch(() => undefined);
  try {
    storage.setItem(DONE_KEY, new Date().toISOString());
  } catch {
    /* storage unavailable: running again finds nothing to rename */
  }
  return "renamed";
}
