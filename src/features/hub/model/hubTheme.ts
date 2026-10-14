// Which hub window theme is on. "monocode" matches Monocode's own look;
// "strip" spreads the project strip's look over the whole window.
import { useSyncExternalStore } from "react";

export type HubTheme = "monocode" | "strip";
const KEY = "monocode:hub-theme";
const EVENT = "monocode:hub-theme-changed";

export function loadHubTheme(): HubTheme {
  try {
    return localStorage.getItem(KEY) === "strip" ? "strip" : "monocode";
  } catch {
    return "monocode";
  }
}

export function applyHubTheme(theme: HubTheme = loadHubTheme()): void {
  document.documentElement.classList.toggle("hub-theme-strip", theme === "strip");
}

export function saveHubTheme(theme: HubTheme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* best effort */
  }
  applyHubTheme(theme);
  window.dispatchEvent(new CustomEvent(EVENT));
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

export function useHubTheme(): HubTheme {
  return useSyncExternalStore(subscribe, loadHubTheme, loadHubTheme);
}

if (typeof document !== "undefined") applyHubTheme();
