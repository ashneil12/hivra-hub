import {
  GROUP_FILTER_EMPTY,
  SHOW_EVERY_PROJECT,
  SHOW_ONLY_THIS_GROUP,
} from "../model/groupFilter";

// WP-137b: the controls and notes the project rail shows for this window's
// group filter. The rail owns the rows and the decision.

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
