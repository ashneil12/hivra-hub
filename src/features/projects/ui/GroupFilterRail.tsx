import { useCallback, useMemo } from "react";
import {
  GROUP_FILTER_EMPTY,
  SHOW_EVERY_PROJECT,
  SHOW_ONLY_THIS_GROUP,
  groupFilterIsEmpty,
  groupFilterState,
  type GroupFilterGroup,
} from "../model/groupFilter";
import { useWindowGroupFilter } from "../model/useWindowGroupFilter";

export type GroupFilterItem = {
  id: string;
  label: string;
  groupId: string | null;
};

const buttonClass =
  "px-2 pb-1 text-left text-[11px] leading-tight text-content/60 hover:text-content";

export function ShowOnlyThisGroupButton({
  groupId,
  groupName,
  onClick,
}: {
  groupId: string;
  groupName: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-no-drag
      data-show-only-group={groupId}
      aria-label={`Show only this group, ${groupName}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={buttonClass}
    >
      {SHOW_ONLY_THIS_GROUP}
    </button>
  );
}

export function ShowEveryProjectButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      data-no-drag
      data-show-every-project=""
      aria-label={SHOW_EVERY_PROJECT}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={buttonClass}
    >
      {SHOW_EVERY_PROJECT}
    </button>
  );
}

export function GroupFilterNote({ children }: { children: string }) {
  return (
    <p
      role="status"
      data-group-filter-note=""
      className="px-4 pb-1 text-[11px] leading-tight text-content/60"
    >
      {children}
    </p>
  );
}

export function GroupFilterEmpty({ groupId }: { groupId: string }) {
  return (
    <p
      data-group-empty={groupId}
      className="px-3 pb-1 text-[11px] leading-tight text-content/50"
    >
      {GROUP_FILTER_EMPTY}
    </p>
  );
}

/**
 * The rows a person sees for this window's group filter. Project rail uses the
 * same buttons and the same decision. Expanding a group does not filter.
 */
export function GroupFilterRail({
  pinned,
  groups,
  ungrouped,
  active = true,
}: {
  pinned: readonly GroupFilterItem[];
  groups: readonly { id: string; name: string; items: readonly GroupFilterItem[] }[];
  ungrouped: readonly GroupFilterItem[];
  active?: boolean;
}) {
  const filed = useMemo<GroupFilterGroup<GroupFilterItem>[]>(
    () => groups.map((group) => ({ id: group.id, items: group.items })),
    [groups],
  );
  const rail = useMemo(
    () => ({ pinned, groups: filed, ungrouped }),
    [pinned, filed, ungrouped],
  );
  const knownIds = useMemo(() => groups.map((group) => group.id), [groups]);
  const groupIdOf = useCallback(
    (item: GroupFilterItem) => item.groupId ?? undefined,
    [],
  );
  const { decision, enabled, showOnly, showEvery } = useWindowGroupFilter(
    rail,
    knownIds,
    groupIdOf,
    active,
  );
  const names = useMemo(
    () => new Map(groups.map((group) => [group.id, group.name])),
    [groups],
  );
  const visible = [
    ...decision.pinned.map((item) => item.id),
    ...decision.groups.flatMap((group) => group.items.map((item) => item.id)),
    ...decision.ungrouped.map((item) => item.id),
  ];

  return (
    <div data-group-filter={groupFilterState(decision)} data-rail-order={visible.join(" ")}>
      {decision.unavailable ? (
        <div>
          <GroupFilterNote>{decision.unavailable}</GroupFilterNote>
          <ShowEveryProjectButton onClick={showEvery} />
        </div>
      ) : null}
      {decision.pinned.length > 0 ? (
        <section aria-label="Pinned">
          {decision.pinned.map((item) => (
            <div key={item.id} data-project={item.id}>
              {item.label}
            </div>
          ))}
        </section>
      ) : null}
      {decision.groups.map((group) => {
        const name = names.get(group.id) ?? group.id;
        const empty = groupFilterIsEmpty(decision) && decision.groups.length === 1;
        return (
          <section key={group.id} data-project-group={group.id} aria-label={name}>
            <button type="button" aria-label={`Expand ${name}`} onClick={(event) => event.stopPropagation()}>
              {name}
            </button>
            {enabled && !decision.limited ? (
              <ShowOnlyThisGroupButton
                groupId={group.id}
                groupName={name}
                onClick={() => showOnly(group.id)}
              />
            ) : null}
            {enabled && decision.limited ? (
              <ShowEveryProjectButton onClick={showEvery} />
            ) : null}
            {empty ? <GroupFilterEmpty groupId={group.id} /> : null}
            {group.items.map((item) => (
              <div key={item.id} data-project={item.id}>
                {item.label}
              </div>
            ))}
          </section>
        );
      })}
      {decision.limited ? null : (
        <section aria-label="Projects">
          {decision.ungrouped.map((item) => (
            <div key={item.id} data-project={item.id}>
              {item.label}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
