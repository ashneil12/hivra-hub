// The asks the person made, as the "You asked" list and its count read them: one subscription to the one ask ledger.
import { useMemo, useSyncExternalStore } from "react";
import { askStore } from "./askStore";
import { askedRows, type AskedRow } from "./askedView";

const subscribe = (fn: () => void): (() => void) => askStore().subscribe(fn);
const now = () => askStore().doc();

/** The asks he made that are still on the list (dropped ones are gone), newest first. */
export function useAsked(): AskedRow[] {
  const doc = useSyncExternalStore(subscribe, now, now);
  return useMemo(() => askedRows(doc), [doc]);
}
