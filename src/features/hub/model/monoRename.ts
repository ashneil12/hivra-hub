// ash-lead becomes hub-lead (decided 20 Oct). The MonoCode Hub lead on Ash's Mac still carries the id of the old
// "Harness lead" (`ash-lead`): hubLeads.ts adopted it in place, so its soul told it ASH_MONO_ID=ash-lead and Ash OS
// filed its work under that name. The rename, once, in this order (each step safe to run again):
// 1. Its folder moves to hub-lead/ (mono.rs mono_rename): its old soul is kept as memory/ash-lead-soul.md and the
//    soul's ASH_MONO_ID now says hub-lead. Its room seats and posts, open delegations and chat binds follow it in the
//    database. If hub-lead/ already has files, nothing at all changes.
// 2. Its roster entry takes the new id in place: same chat, look, projects and place on the rail.
// 3. The app's own records in the WebView that name it (removed-by-user, adopted, tied, room seats, backgrounds, bot
//    changes, the open Mono…) are rewritten to the new id.
// 4. Ash OS is told: hub-lead leads `hub` (ensureProjectLeads registers it) and ash-lead no longer does.
import { invoke } from "@tauri-apps/api/core";
import { findMono, renameMonoId, type Mono } from "../../monos/model/mono";

export const LEGACY_HUB_LEAD = "ash-lead";
export const HUB_LEAD = "hub-lead";
const DONE_KEY = "monocode:mono-renamed-ash-lead";
/** Never rewritten here: the roster has its own step, and these say nothing about who a Mono is. */
const SKIP_KEYS = new Set(["monocode:mono-roster", "monocode:mono-roster-saved-at", DONE_KEY]);

export type RenameBackend = (from: string, to: string) => Promise<unknown>;
const tauriRename: RenameBackend = (from, to) => invoke("mono_rename", { from, to });

/** The id as a whole word in stored JSON or keys: "ash-lead", "ash-lead|/path", "retire:ash-lead:…". */
function idPattern(id: string): RegExp {
  return new RegExp(`(^|["|:])${id.replace(/[-]/g, "\\-")}(?=$|["|:])`, "g");
}

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

export type RenameResult = "renamed" | "not-needed" | "both-exist" | "failed";

/** The rename, once (see the file's notes). Safe to call on every launch and in any copy. */
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
    console.error("Both ash-lead and hub-lead are on the roster, so neither was renamed; that one is Ash's call.");
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
