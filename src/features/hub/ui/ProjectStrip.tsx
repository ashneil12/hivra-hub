import { clearProjectDraft, projectDraft, useProjectDraftVersion } from "../model/projectDraft";
import { Popover } from "../../../shared/ui/Popover";
import { CANCEL_FOCUS_RING } from "../../../shared/ui/ConfirmDelete";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal, Plus, type IconComponent } from "../../../shared/ui/icons";
import type { PopoverAnchor } from "../../../shared/ui/Popover";
import { ProjectGlyph, ProjectMenu, ProjectMonogramTile, RemovedUndoToast } from "./ProjectMenu";
import { moveLocalNamesToAshOs } from "../model/projectActions";
import { hubData, useHubDataVersion } from "../model/hubData";
import { attentionCount, useAttentionVersion } from "../model/todayCounts";
import { useProposalsVersion } from "../model/proposals";
import { useTemplatesVersion } from "../model/templates";
import { useConnectorsVersion } from "../model/connectors";
import { useHubBuildsVersion } from "../model/hubBuilds";
import { appItemInView, showAppItem, showProjectToday, type HubSelection } from "../model/hubNav";
import type { HubProject } from "../model/types";
import { useAutopilotStrip } from "../../autopilot/ui/AutopilotStripButton";
import { readStripGroups, stripLayout, useStripGroupsVersion } from "../model/stripGroups";
import { ShowAllProjectsButton, StripGroupHeading, StripGroupMenu } from "./StripGroups";
import type { ProjectGroup } from "../../projects/model/projectGroups";

export { SHAPES } from "./projectShapeIcons";

/**
 * Far-left strip: Autopilot, then each project as a grey shape, then "+". There is no all-projects board: a project
 * is the unit of the hub, and opening one shows its own Today. Projects differ by shape only; colour is kept for status.
 */
export function ProjectStrip({
  selection,
  onPickProject,
  onCreateProject,
  onLeaveCovers,
  titleBarAbove = false,
}: {
  selection: HubSelection;
  onPickProject: (project: HubProject) => void;
  onCreateProject: () => void;
  /** Today and New project leave whatever covers the hub (Pages, Automations, Notes, Inbox, Search) first. */
  onLeaveCovers?: () => void;
  /** A title bar spans the window above the strip (MonoCode's inset layout), so the traffic lights sit there. */
  titleBarAbove?: boolean;
}) {
  useHubDataVersion();
  useProposalsVersion();
  useTemplatesVersion();
  useConnectorsVersion();
  void onCreateProject;
  useHubBuildsVersion();
  // The same count as the project's card on Today (todayCounts.ts).
  useAttentionVersion();
  const data = hubData();
  const projects = data.listProjects();
  // Names Ash gave projects on this Mac before Ash OS kept them go to Ash OS once (it runs only when Ash OS is there).
  const haveProjects = projects.length > 0;
  useEffect(() => {
    if (haveProjects) void moveLocalNamesToAshOs();
  }, [haveProjects]);
  useProjectDraftVersion();
  const draftProject = projectDraft();
  const [menu, setMenu] = useState<{ project: HubProject; anchor: PopoverAnchor }>();
  const [draftMenu, setDraftMenu] = useState<PopoverAnchor>();
  const autopilot = useAutopilotStrip();
  // WP-137: projects in no group first, then each group under its heading, all in the saved order. "Show only this
  // group" (this window only) shows one group; the others come back in the same slots when it goes off.
  useStripGroupsVersion();
  const stripGroups = readStripGroups();
  const layout = stripLayout(projects, stripGroups.groups, stripGroups.assignments, stripGroups.filterId);
  const [groupMenu, setGroupMenu] = useState<{ group: ProjectGroup; anchor: PopoverAnchor }>();
  const projectButton = (project: HubProject) => {
    const count = attentionCount(project.id);
    return (
      <StripButton
        key={project.id}
        label={project.shortName}
        title={count ? `${project.name}, ${count} waiting on you` : project.name}
        selected={selection.project === project.id && !appItemInView(selection)}
        onClick={() => onPickProject(project)}
        glyph={<ProjectGlyph project={project} />}
        count={count}
        onMenu={(anchor) => setMenu({ project, anchor })}
      />
    );
  };
  return (
    <nav
      aria-label="Projects"
      data-hub-strip
      className="sidebar-glass hub-strip flex h-full w-[68px] shrink-0 select-none flex-col items-center gap-1 pb-3"
      data-tauri-drag-region="deep"
    >
      {/* Room for the macOS traffic lights. */}
      {titleBarAbove ? <div className="h-1.5 w-full shrink-0" /> : <div className="h-10 w-full shrink-0" data-tauri-drag-region />}
      {/* WP-73: Home, above the projects. A letter, not a chart. */}
      <div data-hub-home>
        <StripButton
          label="Home"
          title="Home"
          selected={selection.item === "home"}
          onClick={() => { onLeaveCovers?.(); showAppItem("home"); }}
          glyph={<span className="text-[13px] font-medium">H</span>}
        />
      </div>
      <StripButton
        label="Autopilot"
        title={autopilot.title}
        selected={selection.item === "autopilot"}
        onClick={() => { onLeaveCovers?.(); showAppItem("autopilot"); }}
        glyph={autopilot.glyph}
      />
      <div className="h-2 shrink-0" />
      {layout.loose.map(projectButton)}
      {layout.groups.map(({ group, projects: members }) => (
        <div key={group.id} role="group" aria-label={`${group.name} group`} data-strip-group-section={group.id}
          className="flex shrink-0 flex-col items-center gap-1">
          <StripGroupHeading group={group} filterOn={layout.filter?.id === group.id}
            onMenu={(anchor) => setGroupMenu({ group, anchor })} />
          {members.map(projectButton)}
        </div>
      ))}
      {layout.filter ? <ShowAllProjectsButton /> : null}
      {draftProject ? (
        <div data-hub-project-draft>
          <StripButton
            label="Draft"
            title={`Draft: ${draftProject.name}, still being set up`}
            selected={selection.item === "new-project"}
            onClick={() => { onLeaveCovers?.(); showAppItem("new-project"); }}
            // WP-94: the draft wears the same two-letter, name-coloured tile a project with no icon gets, so it reads as
            // the project-shaped thing it will become rather than a lone grey letter.
            glyph={<ProjectMonogramTile name={draftProject.name} size={18} />}
            onMenu={setDraftMenu}
          />
        </div>
      ) : null}
      <StripButton label="" title="New project" selected={false} onClick={() => { onLeaveCovers?.(); showAppItem("new-project"); }} Icon={Plus} />
      {draftMenu && draftProject ? (
        <DraftMenu
          name={draftProject.name}
          anchor={draftMenu}
          onClose={() => setDraftMenu(undefined)}
          onDiscard={() => {
            setDraftMenu(undefined);
            const open = selection.item === "new-project";
            clearProjectDraft();
            if (open) showProjectToday();
          }}
        />
      ) : null}
      {menu ? <ProjectMenu project={menu.project} anchor={menu.anchor} onClose={() => setMenu(undefined)} /> : null}
      {groupMenu ? (
        <StripGroupMenu group={groupMenu.group} basis={stripGroups.groups} filterOn={layout.filter?.id === groupMenu.group.id}
          anchor={groupMenu.anchor} onClose={() => setGroupMenu(undefined)} />
      ) : null}
      <RemovedUndoToast />
    </nav>
  );
}

/**
 * r61 (PM's blind run: "Draft: kids maths" sat on the strip with no way off it): the draft tile's menu. Discard asks once,
 * with Cancel focused (D4), and then the interview so far is gone; nothing was ever a project, so nothing else changes.
 */
export function DraftMenu({ name, anchor, onClose, onDiscard }: { name: string; anchor: PopoverAnchor; onClose: () => void; onDiscard: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <Popover anchor={anchor} side="right" align="start" width={230} constrainHeight={false} role="menu" aria-label={`Draft: ${name} options`}
      onDismiss={onClose} onContextMenu={(e) => e.preventDefault()} className="p-1" data-hub-draft-menu>
      {confirm ? (
        <div className="p-2 text-[13px]" data-hub-draft-discard-confirm>
          <p className="pb-2 text-content/85">Discard the draft "{name}"? The setup chat so far is lost.</p>
          <div className="flex justify-end gap-1.5">
            <button type="button" autoFocus onClick={onClose} data-hub-draft-discard-cancel
              className={`rounded-md px-3 py-1.5 text-content/85 hover:bg-content/8 ${CANCEL_FOCUS_RING}`}>Cancel</button>
            <button type="button" onClick={onDiscard} data-hub-draft-discard-yes
              className="rounded-md px-3 py-1.5 text-red-400 hover:bg-red-500/10">Discard</button>
          </div>
        </div>
      ) : (
        <>
          <button type="button" role="menuitem" data-hub-draft-open onClick={() => { onClose(); showAppItem("new-project"); }}
            className="flex h-7 w-full items-center rounded-md px-2 text-left text-[13px] text-content hover:bg-content/8">Open draft</button>
          <div role="separator" className="my-1 h-px bg-content/10" />
          <button type="button" role="menuitem" data-hub-draft-discard onClick={() => setConfirm(true)}
            className="flex h-7 w-full items-center rounded-md px-2 text-left text-[13px] text-red-400 hover:bg-red-500/10">Discard draft…</button>
        </>
      )}
    </Popover>
  );
}

/** How long a press on a project's tile opens its menu. */
export const LONG_PRESS_MS = 550;

export function StripButton({
  label,
  title,
  selected,
  onClick,
  Icon,
  glyph,
  count,
  onMenu,
}: {
  label: string;
  title: string;
  selected: boolean;
  onClick: () => void;
  Icon?: IconComponent;
  /** A project's own tile (letter, emoji, icon or image) instead of Icon. */
  glyph?: ReactNode;
  count?: number;
  /** Right-click, or the hover "⋯", opens the project's menu. */
  onMenu?: (anchor: PopoverAnchor) => void;
}) {
  // A long press opens the menu too (a trackpad without a right-click habit); the click that ends it doesn't open the project.
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; fired: boolean } | undefined>(undefined);
  const endPress = () => {
    if (press.current) clearTimeout(press.current.timer);
  };
  return (
    <div className="group/strip relative">
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-current={selected || undefined}
      onClick={() => {
        if (press.current?.fired) {
          press.current = undefined;
          return;
        }
        onClick();
      }}
      onPointerDown={onMenu ? (e) => {
        if (e.button !== 0) return;
        const at = { x: e.clientX, y: e.clientY };
        endPress();
        press.current = { fired: false, timer: setTimeout(() => { if (press.current) press.current.fired = true; onMenu(at); }, LONG_PRESS_MS) };
      } : undefined}
      onPointerUp={onMenu ? endPress : undefined}
      onPointerLeave={onMenu ? endPress : undefined}
      onContextMenu={onMenu ? (e) => { e.preventDefault(); endPress(); onMenu({ x: e.clientX, y: e.clientY }); } : undefined}
      className="group flex w-14 shrink-0 flex-col items-center gap-1.5 pb-2 pt-1"
    >
      <span
        className={`relative grid size-9 place-items-center rounded-[10px] transition-colors ${
          selected ? "bg-content/12 text-content" : "text-content/65 group-hover:bg-content/8 group-hover:text-content"
        }`}
      >
        {glyph ?? (Icon ? <Icon className="size-[18px]" strokeWidth={1.75} /> : null)}
        {(count ?? 0) > 0 ? (
          <span className="absolute -right-1 -top-1 min-w-4 hub-count-badge rounded-full bg-background-base px-1 text-center text-[10px] leading-4 text-content/75">
            {count}
          </span>
        ) : null}
      </span>
      {label ? (
        <span className={`max-w-full truncate px-0.5 text-[11px] leading-[14px] ${selected ? "text-content" : "text-content/60"}`}>
          {label}
        </span>
      ) : null}
    </button>
    {onMenu ? (
      <button type="button" aria-label={`${title} options`} data-project-more
        onClick={(e) => onMenu(e.currentTarget)}
        className="absolute right-0 top-0 grid size-4 place-items-center rounded-full bg-background-base text-content/60 opacity-0 ring-1 ring-content/10 transition-opacity hover:text-content focus:opacity-100 group-hover/strip:opacity-100">
        <MoreHorizontal className="size-3" strokeWidth={2} />
      </button>
    ) : null}
    </div>
  );
}
