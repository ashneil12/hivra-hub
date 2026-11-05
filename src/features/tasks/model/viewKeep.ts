// A view that fails to load is not thrown away. A stale save takes the server's copy and does not
// write ours back over it. State from disk is untrusted and falls back to the default view.

import { defaultViewState, normalizeViewState, type GroupBy, type Layout, type OrderBy, type ViewState } from "../vendor/views/viewState";

const LAYOUTS = new Set<Layout>(["list", "board", "timeline"]);
const GROUPS = new Set<GroupBy>(["status", "assignee", "priority", "project", "label", "none"]);
const ORDERS = new Set<OrderBy>(["manual", "priority", "created", "updated", "title", "due_date"]);

export type KeptView<T> = { state: T; version: number; fallback?: boolean };

/** A missing or broken saved view is the default list, not an empty board. */
export function readViewState(value: unknown): ViewState {
  try {
    if (!value || typeof value !== "object") return defaultViewState();
    const state = value as ViewState;
    if (!state.filter || typeof state.filter !== "object" || !Array.isArray(state.filter.children)) return defaultViewState();
    if (!state.display || typeof state.display !== "object") return defaultViewState();
    const next = normalizeViewState(state);
    if (!LAYOUTS.has(next.display.layout)) next.display.layout = "list";
    if (!GROUPS.has(next.display.group_by)) next.display.group_by = "status";
    if (!GROUPS.has(next.display.sub_group_by)) next.display.sub_group_by = "none";
    if (!ORDERS.has(next.display.order_by)) next.display.order_by = "manual";
    if (next.display.order_direction !== "asc" && next.display.order_direction !== "desc") next.display.order_direction = "asc";
    return next;
  } catch {
    return defaultViewState();
  }
}

export function nextView<T>(previous: KeptView<T> | null, result: { ok: false } | { ok: true; view: KeptView<T>; stale?: boolean }): KeptView<T> | null {
  if (!result.ok) return previous;
  return result.view;
}

/** A stale reply is the one to keep. The caller's copy must not be saved again as if it won. */
export function saveWasStale(result: { stale?: boolean }): boolean {
  return result.stale === true;
}
