import type { BoardRole } from "./tree";

export type OpenMap = Record<string, boolean>;

const KEY = "monocode:agents-board-open";

/** Open through the first mates. Crew and sub-chats stay closed until someone opens them. */
export function defaultOpen(role: BoardRole): boolean {
  return role === "captain" || role === "home" || role === "project" || role === "mate";
}

/** Saved open and closed rows. Anything that is not a boolean is ignored. */
export function readOpenMap(raw: unknown): OpenMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: OpenMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || key.length > 200 || typeof value !== "boolean") continue;
    out[key] = value;
  }
  return out;
}

export function rowOpen(id: string, role: BoardRole, saved: OpenMap): boolean {
  return id in saved ? saved[id] : defaultOpen(role);
}

export function loadOpenMap(): OpenMap {
  try {
    return readOpenMap(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return {};
  }
}

export function saveOpenMap(saved: OpenMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {
    /* the row still opens for this visit */
  }
}
