import { useCallback, useEffect, useRef, useState } from "react";
import { useShowOnlyGroup } from "../../settings/model/displayPrefs";
import {
  applyGroupFilter,
  groupFilterRequest,
  type GroupFilterDecision,
  type GroupFilterRail,
} from "./groupFilter";

/**
 * WP-137b: the filter for this window only. It is React state, not the group
 * list and not the rail order. Turning the setting off drops it.
 */
export function useWindowGroupFilter<T>(
  rail: GroupFilterRail<T>,
  knownGroupIds: readonly string[],
  groupIdOf: (item: T) => string | undefined,
): {
  decision: GroupFilterDecision<T>;
  enabled: boolean;
  showOnly: (groupId: string) => void;
  showEvery: () => void;
} {
  const settingOn = useShowOnlyGroup();
  const enabled = settingOn;
  const [groupId, setGroupId] = useState<string | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled && groupId !== null) setGroupId(null);
  }, [enabled, groupId]);

  const decision = applyGroupFilter(
    rail,
    knownGroupIds,
    groupFilterRequest(enabled, groupId),
    groupIdOf,
  );

  const showOnly = useCallback((id: string) => {
    if (!enabledRef.current) return;
    if (typeof id !== "string" || id.length === 0 || id.trim() !== id) return;
    setGroupId(id);
  }, []);

  const showEvery = useCallback(() => {
    setGroupId(null);
  }, []);

  return { decision, enabled, showOnly, showEvery };
}
