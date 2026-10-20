// The last soul the app itself saved for each Mono: its hash and text. The soul tamper check (hub/model/soulTamper.ts)
// compares the file with it to tell the app's own writes from anything else. Kept in the app's own storage, which no
// worker or script can reach the way it can reach the Monos folder.
const KEY = "monocode.soulSaved.v1";

export type SavedSoul = { hash: string; text: string; at: number };

function load(): Record<string, SavedSoul> {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    const value = raw ? (JSON.parse(raw) as unknown) : {};
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, SavedSoul>) : {};
  } catch {
    return {};
  }
}

function save(all: Record<string, SavedSoul>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage full or gone: the next check records the file as it stands */
  }
}

export function savedSoul(monoId: string): SavedSoul | undefined {
  const s = load()[monoId];
  return s && typeof s.hash === "string" && typeof s.text === "string" ? s : undefined;
}

/** The app wrote (or accepted) this soul: it is the one to compare with from now on. */
export function recordSavedSoul(monoId: string, text: string, hash: string, at: number = Date.now()): void {
  save({ ...load(), [monoId]: { hash, text, at } });
}

export function forgetSavedSoul(monoId: string): void {
  const all = load();
  delete all[monoId];
  save(all);
}
