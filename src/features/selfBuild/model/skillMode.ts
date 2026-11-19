// WP-242: one switch for how skills are learned, in Settings > Memory.
//   automatic: a first mate's `skills_learn` lesson goes into its skill at once, with Undo in Bot changes (Ash, 14 Oct),
//              and the memory curator's skill proposals wait for the person, as before. This is the default.
//   ask:       both paths wait for the person's Accept on the Memory screen (the WP-51 card).
//   off:       both paths drop the lesson, and the Memory screen's health card counts what was dropped.
// Stored in localStorage beside the memory tier (memory/model/tier.ts), read as untrusted: anything unreadable is the
// default. A change starts with the next lesson.
// (Idea: nightly-labs OpenBot's single Automatic / Ask first / Off setting, ideas only, no code or text copied.)

import { useSyncExternalStore } from "react";

export const SKILL_MODE_KEY = "monocode.skillLearning";
export const SKILL_MODE_CHANGE_EVENT = "monocode:skilllearningchange";

export type SkillMode = "automatic" | "ask" | "off";
export const SKILL_MODES: readonly SkillMode[] = ["automatic", "ask", "off"];
export const DEFAULT_SKILL_MODE: SkillMode = "automatic";

export function readSkillMode(value: unknown): SkillMode {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      // A bare word, as an older build or a hand edit might have left it.
    }
  }
  return SKILL_MODES.includes(raw as SkillMode) ? (raw as SkillMode) : DEFAULT_SKILL_MODE;
}

export function loadSkillMode(): SkillMode {
  try {
    return readSkillMode(localStorage.getItem(SKILL_MODE_KEY));
  } catch {
    return DEFAULT_SKILL_MODE;
  }
}

export function saveSkillMode(mode: SkillMode): void {
  const clean = readSkillMode(mode);
  try {
    localStorage.setItem(SKILL_MODE_KEY, JSON.stringify(clean));
  } catch {
    // Private mode or a full quota: nothing was written, so the screen keeps showing what is saved.
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SKILL_MODE_CHANGE_EVENT));
}

export function subscribeSkillMode(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key !== SKILL_MODE_KEY && event.key !== null) return;
    onChange();
  };
  window.addEventListener(SKILL_MODE_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(SKILL_MODE_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useSkillMode(): SkillMode {
  return useSyncExternalStore(subscribeSkillMode, loadSkillMode, () => DEFAULT_SKILL_MODE);
}

export function skillModeLabel(mode: SkillMode): string {
  if (mode === "ask") return "Ask first";
  if (mode === "off") return "Off";
  return "Automatic";
}
