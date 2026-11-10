/**
 * WP-137b: a per-window view of one existing project group.
 * The filter does not write the group list, the rail order, or a chat.
 */

export const SHOW_ONLY_THIS_GROUP = "Show only this group";
export const SHOW_EVERY_PROJECT = "Show every project";
export const GROUP_FILTER_MISSING = "That group is no longer there.";
export const GROUP_FILTER_EMPTY = "No projects in this group.";

export type GroupFilterGroup<T> = {
  id: string;
  items: readonly T[];
};

export type GroupFilterRail<T> = {
  pinned: readonly T[];
  groups: readonly GroupFilterGroup<T>[];
  ungrouped: readonly T[];
};

export type GroupFilterRequest = {
  enabled: boolean;
  groupId: string | null;
};

export type GroupFilterDecision<T> = {
  pinned: readonly T[];
  groups: readonly GroupFilterGroup<T>[];
  ungrouped: readonly T[];
  /** True only when the rail is limited to one group that exists. */
  limited: boolean;
  /** A plain sentence when the request cannot be applied. Null otherwise. */
  unavailable: string | null;
};

/**
 * Untrusted values from storage or another window. Anything other than a
 * boolean true is off. A blank or padded id is no request, not a match.
 */
export function groupFilterRequest(
  enabled: unknown,
  groupId: unknown,
): GroupFilterRequest {
  if (enabled !== true) return { enabled: false, groupId: null };
  if (typeof groupId !== "string" || groupId.length === 0 || groupId.trim() !== groupId) {
    return { enabled: true, groupId: null };
  }
  return { enabled: true, groupId };
}

export function applyGroupFilter<T>(
  rail: GroupFilterRail<T>,
  knownGroupIds: readonly string[],
  request: GroupFilterRequest,
  groupIdOf: (item: T) => string | undefined,
): GroupFilterDecision<T> {
  if (!request.enabled || request.groupId == null) {
    return {
      pinned: rail.pinned,
      groups: rail.groups,
      ungrouped: rail.ungrouped,
      limited: false,
      unavailable: null,
    };
  }
  if (!knownGroupIds.includes(request.groupId)) {
    return {
      pinned: rail.pinned,
      groups: rail.groups,
      ungrouped: rail.ungrouped,
      limited: false,
      unavailable: GROUP_FILTER_MISSING,
    };
  }
  const match = rail.groups.find((group) => group.id === request.groupId);
  return {
    pinned: rail.pinned.filter((item) => groupIdOf(item) === request.groupId),
    groups: match ? [{ id: match.id, items: match.items }] : [{ id: request.groupId, items: [] }],
    ungrouped: [],
    limited: true,
    unavailable: null,
  };
}

export function groupFilterIsEmpty<T>(decision: GroupFilterDecision<T>): boolean {
  if (!decision.limited) return false;
  const listed = decision.groups.reduce((count, group) => count + group.items.length, 0);
  return listed === 0 && decision.pinned.length === 0;
}

export function groupFilterState(
  decision: GroupFilterDecision<unknown>,
): "off" | "on" | "unavailable" {
  if (decision.unavailable) return "unavailable";
  if (decision.limited) return "on";
  return "off";
}
