// A new project mid-interview. It shows in the sidebar as a draft, so Ash can
// leave and come back with the chat as it was. Nothing is a project until Create.
import { useSyncExternalStore } from "react";
import type { TemplateId } from "./templates";

export type ProjectDraft = {
  name: string;
  started: boolean;
  lines: { from: "cos" | "ash"; text: string }[];
  answers: string[];
  tpl: TemplateId | null;
  addon: boolean;
};
const KEY = "monocode:hub-project-draft";
const EVENT = "monocode:hub-project-draft-changed";

function read(): ProjectDraft | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as ProjectDraft | null;
    return v && typeof v.name === "string" && Array.isArray(v.lines) ? v : null;
  } catch {
    return null;
  }
}
let current: ProjectDraft | null = typeof localStorage === "undefined" ? null : read();
let version = 0;

export function projectDraft(): ProjectDraft | null {
  return current;
}
/** Saves the interview. A draft with no name yet isn't shown. */
export function saveProjectDraft(d: ProjectDraft): void {
  current = d.name.trim() ? d : null;
  try {
    if (current) localStorage.setItem(KEY, JSON.stringify(current));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: kept for this session */
  }
  version++;
  window.dispatchEvent(new CustomEvent(EVENT));
}
/** Create project or Cancel ends the draft. */
export function clearProjectDraft(): void {
  current = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
  version++;
  window.dispatchEvent(new CustomEvent(EVENT));
}
export function useProjectDraftVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener(EVENT, cb);
      return () => window.removeEventListener(EVENT, cb);
    },
    () => version,
    () => version,
  );
}

/** The draft's tile letter. */
export function draftInitial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase();
}
