// WP-137: project groups on the strip. A group's heading, its menu ("Show only this group", Rename, Delete), and the
// project menu's group chooser. The model and its rules are in ../model/stripGroups.ts.

import { useEffect, useRef, useState } from "react";
import { Popover, type PopoverAnchor } from "../../../shared/ui/Popover";
import { CANCEL_FOCUS_RING } from "../../../shared/ui/ConfirmDelete";
import { Check } from "../../../shared/ui/icons";
import type { ProjectGroup } from "../../projects/model/projectGroups";
import type { HubProject } from "../model/types";
import {
  addStripGroup,
  deleteStripGroup,
  groupWriteProblem,
  readStripGroups,
  renameStripGroup,
  setStripGroupFilter,
  setStripProjectGroup,
  stripProjectGroupId,
  useStripGroupsVersion,
  type GroupWrite,
} from "../model/stripGroups";

const ITEM =
  "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-content hover:bg-content/8 disabled:opacity-35";
const INPUT =
  "w-full rounded-lg border border-content/10 bg-content/5 px-2.5 py-1.5 text-[13px] text-content outline-none focus:border-content/30";

function Problem({ text }: { text: string | null }) {
  return text ? (
    <p role="alert" data-strip-group-problem className="px-1 py-1 text-[11px] leading-4 text-content/70">
      {text}
    </p>
  ) : null;
}

/**
 * A group's heading on the strip: its name under a short grey line. No group colour: on the strip colour is kept for
 * status (ProjectStrip.tsx), and the shared palette has red, orange, yellow and green. A click opens its menu.
 */
export function StripGroupHeading({
  group,
  filterOn,
  onMenu,
}: {
  group: ProjectGroup;
  filterOn: boolean;
  onMenu: (anchor: PopoverAnchor) => void;
}) {
  return (
    <button
      type="button"
      data-strip-group={group.id}
      data-strip-group-filtered={filterOn || undefined}
      title={filterOn ? `${group.name}, showing only this group` : `${group.name} group`}
      aria-label={filterOn ? `${group.name} group, showing only this group` : `${group.name} group`}
      aria-haspopup="menu"
      onClick={(e) => onMenu(e.currentTarget)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ x: e.clientX, y: e.clientY });
      }}
      className={`mt-1 flex w-14 shrink-0 flex-col items-center gap-0.5 rounded-md px-0.5 py-1 hover:bg-content/8 ${
        filterOn ? "bg-content/8" : ""
      }`}
    >
      <span aria-hidden className="h-0.5 w-6 rounded-full bg-content/20" />
      <span className={`max-w-full truncate text-[11px] leading-[14px] ${filterOn ? "text-content" : "text-content/55"}`}>
        {group.name}
      </span>
    </button>
  );
}

/** Under the heading while the filter is on: one tap back to every project. */
export function ShowAllProjectsButton() {
  return (
    <button
      type="button"
      data-strip-show-all
      title="Show all projects"
      onClick={() => setStripGroupFilter(null)}
      className="mt-1 w-14 shrink-0 rounded-md px-0.5 py-1 text-[11px] leading-[14px] text-content/60 hover:bg-content/8 hover:text-content"
    >
      Show all
    </button>
  );
}

type GroupMode = { kind: "menu" } | { kind: "rename" } | { kind: "delete" } | { kind: "gone"; at: PopoverAnchor };

/** A group heading's menu. "Show only this group" is this window only; Rename and Delete change the shared list. */
export function StripGroupMenu({
  group,
  basis,
  filterOn,
  anchor,
  onClose,
}: {
  group: ProjectGroup;
  /** The group list this window last read. A write based on an older list is dropped. */
  basis: readonly ProjectGroup[];
  filterOn: boolean;
  anchor: PopoverAnchor;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<GroupMode>({ kind: "menu" });
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState(group.name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (mode.kind === "rename") input.current?.select();
  }, [mode.kind]);
  const finish = (result: GroupWrite) => {
    const text = groupWriteProblem(result);
    // Another window deleted the group: no retry can reach it, so the box closes and says so. Its heading leaves the
    // strip, so the note stays where the heading was.
    if (result === "gone") {
      setProblem(text);
      setMode({ kind: "gone", at: anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor });
    } else if (text) setProblem(text);
    else onClose();
  };
  if (mode.kind === "gone") {
    return (
      <Popover anchor={mode.at} side="right" align="start" width={240} constrainHeight={false} role="dialog"
        aria-label="Group gone" onDismiss={onClose} className="flex flex-col gap-1.5 p-2" data-strip-group-gone>
        <Problem text={problem} />
        <div className="flex justify-end">
          <button type="button" autoFocus onClick={onClose}
            className={`rounded-md px-3 py-1.5 text-[13px] text-content/85 hover:bg-content/8 ${CANCEL_FOCUS_RING}`}>OK</button>
        </div>
      </Popover>
    );
  }
  if (mode.kind === "rename") {
    const commit = () => {
      if (name.trim() === group.name) return onClose();
      finish(renameStripGroup(basis, group.id, name));
    };
    return (
      <Popover anchor={anchor} side="right" align="start" width={240} constrainHeight={false} role="dialog"
        aria-label="Rename group" onDismiss={onClose} className="flex flex-col gap-1.5 p-2" data-strip-group-rename>
        <input ref={input} value={name} aria-label="Group name" maxLength={40}
          onChange={(e) => { setName(e.target.value); setProblem(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") onClose(); }}
          className={INPUT} />
        <Problem text={problem} />
      </Popover>
    );
  }
  if (mode.kind === "delete") {
    return (
      <Popover anchor={anchor} side="right" align="start" width={250} constrainHeight={false} role="dialog"
        aria-label="Delete group" onDismiss={onClose} className="p-2 text-[13px]" data-strip-group-delete-confirm>
        <p className="pb-2 text-content/85">Delete the group "{group.name}"? Its projects stay on the strip.</p>
        <Problem text={problem} />
        <div className="flex justify-end gap-1.5">
          <button type="button" autoFocus onClick={onClose}
            className={`rounded-md px-3 py-1.5 text-content/85 hover:bg-content/8 ${CANCEL_FOCUS_RING}`}>Cancel</button>
          <button type="button" data-strip-group-delete-yes onClick={() => finish(deleteStripGroup(basis, group.id))}
            className="rounded-md px-3 py-1.5 text-red-400 hover:bg-red-500/10">Delete</button>
        </div>
      </Popover>
    );
  }
  return (
    <Popover anchor={anchor} side="right" align="start" width={210} constrainHeight={false} role="menu"
      aria-label={`${group.name} group options`} onDismiss={onClose} onContextMenu={(e) => e.preventDefault()}
      className="p-1" data-strip-group-menu>
      <button type="button" role="menuitem" className={ITEM} data-strip-group-item="filter"
        onClick={() => { setStripGroupFilter(filterOn ? null : group.id); onClose(); }}>
        {filterOn ? "Show all projects" : "Show only this group"}
      </button>
      <button type="button" role="menuitem" className={ITEM} data-strip-group-item="rename"
        onClick={() => setMode({ kind: "rename" })}>Rename group</button>
      <div role="separator" className="my-1 h-px bg-content/10" />
      <button type="button" role="menuitem" data-strip-group-item="delete"
        className="flex h-7 w-full items-center rounded-md px-2 text-left text-[13px] text-red-400 hover:bg-red-500/10"
        onClick={() => setMode({ kind: "delete" })}>Delete group</button>
      <Problem text={problem} />
    </Popover>
  );
}

/** The project menu's "Group": which group this project sits under, a new one, or none. */
export function ProjectGroupChooser({
  project,
  anchor,
  onClose,
}: {
  project: HubProject;
  anchor: PopoverAnchor;
  onClose: () => void;
}) {
  useStripGroupsVersion();
  const { groups, assignments } = readStripGroups();
  const current = stripProjectGroupId(project.id, assignments) ?? null;
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const finish = (result: GroupWrite) => {
    const text = groupWriteProblem(result);
    if (text) setProblem(text);
    else onClose();
  };
  // Out of the group this window shows on its own (No group, another group, New group): the filter goes off in
  // setStripProjectGroup, so the project stays in view instead of vanishing.
  const pick = (groupId: string | null) => {
    if (groupId === current) return onClose();
    finish(setStripProjectGroup(project.id, groupId));
  };
  return (
    <Popover anchor={anchor} side="right" align="start" width={230} constrainHeight={false} role="menu"
      aria-label={`${project.name} group`} onDismiss={onClose} onContextMenu={(e) => e.preventDefault()}
      className="p-1" data-project-group-chooser>
      {groups.map((group) => (
        <button key={group.id} type="button" role="menuitemradio" aria-checked={current === group.id}
          data-project-group-choice={group.name} className={ITEM} onClick={() => pick(group.id)}>
          <span className="min-w-0 flex-1 truncate">{group.name}</span>
          {current === group.id ? <Check className="size-3.5 shrink-0 text-content/70" /> : null}
        </button>
      ))}
      <button type="button" role="menuitemradio" aria-checked={current === null} data-project-group-choice=""
        className={ITEM} onClick={() => pick(null)}>
        <span className="min-w-0 flex-1 truncate">No group</span>
        {current === null ? <Check className="size-3.5 shrink-0 text-content/70" /> : null}
      </button>
      <div role="separator" className="my-1 h-px bg-content/10" />
      {adding ? (
        <div className="p-1">
          <input autoFocus value={name} aria-label="New group name" placeholder="Group name" maxLength={40}
            data-project-group-new-name
            onChange={(e) => { setName(e.target.value); setProblem(null); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "Enter") finish(addStripGroup(groups, name, project.id).result);
            }}
            className={INPUT} />
        </div>
      ) : (
        <button type="button" role="menuitem" className={ITEM} data-project-group-new onClick={() => setAdding(true)}>
          New group
        </button>
      )}
      <Problem text={problem} />
    </Popover>
  );
}
