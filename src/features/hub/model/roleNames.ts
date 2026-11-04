// Plain role names first: the default team goes by what each Mono does, with
// its own name after it in grey. Ash can keep the current names instead.
import { useSyncExternalStore } from "react";

/** No name is rewritten to a role. A Mono shows the name it has. */
export const ROLE_NAMES: Readonly<Record<string, string>> = {};
const KEY = "monocode:hub-role-names";
const EVENT = "monocode:hub-role-names-changed";
let version = 0;

type Choice = "roles" | "names" | undefined;
function choice(): Choice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "roles" || v === "names" ? v : undefined;
  } catch {
    return undefined;
  }
}
/** Role names are the default; "Keep current names" turns them off. */
export function roleNamesOn(): boolean {
  return choice() === "roles";
}
/** True until Ash picks, so the list can offer "Keep current names" once. */
export function roleNamesUndecided(): boolean {
  return choice() === undefined;
}
export function setRoleNames(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "roles" : "names");
  } catch {
    /* storage unavailable */
  }
  version++;
  window.dispatchEvent(new CustomEvent(EVENT));
}
/** What to show for a Mono: the role first and its name after it, or just the name. */
export function plainName(name: string): { primary: string; secondary?: string } {
  const role = ROLE_NAMES[name.trim().toLowerCase()];
  return role && roleNamesOn() ? { primary: role, secondary: name } : { primary: name };
}
export function useRoleNamesVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener(EVENT, cb);
      return () => window.removeEventListener(EVENT, cb);
    },
    () => version,
    () => version,
  );
}
