// An existing Mono keeps its id. `ash-lead` is not renamed to `hub-lead`: a project's lead is
// `<project id>-lead`, made by ensureProjectLeads, and a Mono already called ash-lead stays.
// `rewriteStoredIds` is the stored-text helper; nothing calls it to rename a lead.

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

export type RenameBackend = (from: string, to: string) => Promise<unknown>;

export type RenameResult = "renamed" | "not-needed" | "both-exist" | "failed";

/**
 * Does not rename. An existing ash-lead is left as it is, whether or not hub-lead is already on the roster, and
 * whether or not a folder move would fail. hub-lead is created as a normal project lead by ensureProjectLeads.
 */
export async function renameAshLeadToHubLead(
  deps: {
    rename?: RenameBackend;
    unregister?: (monoId: string, projectId: string) => Promise<unknown>;
    storage?: Storage;
  } = {},
): Promise<RenameResult> {
  void deps;
  return "not-needed";
}
