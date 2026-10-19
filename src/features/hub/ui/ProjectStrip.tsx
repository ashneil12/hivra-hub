import { draftInitial, projectDraft, useProjectDraftVersion } from "../model/projectDraft";
import { useState, type ReactNode } from "react";
import { Clock, Folder, Gauge, MoreHorizontal, Palette, Plus, Sparkles, type IconComponent } from "../../../shared/ui/icons";
import type { PopoverAnchor } from "../../../shared/ui/Popover";
import { ProjectGlyph, ProjectMenu, RemovedUndoToast } from "./ProjectMenu";
import { hubData, useHubDataVersion } from "../model/hubData";
import { waitingCount } from "../model/waiting";
import { useProposalsVersion } from "../model/proposals";
import { useTemplatesVersion } from "../model/templates";
import { useConnectorsVersion } from "../model/connectors";
import { useHubBuildsVersion } from "../model/hubBuilds";
import { setHubSelection, type HubSelection } from "../model/hubNav";
import type { HubProject, ProjectIconShape } from "../model/types";

/** Ash OS's shape names. "ghost" is no longer drawn: a project shows its letter tile unless Ash picks an icon. */
export const SHAPES: Record<ProjectIconShape, IconComponent> = {
  ghost: Folder,
  sparkles: Sparkles,
  palette: Palette,
  gauge: Gauge,
  folder: Folder,
};

/**
 * Far-left strip: Today for all projects, then each project as a grey shape,
 * then "+". Projects differ by shape only; colour is kept for status.
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
  const data = hubData();
  const projects = data.listProjects();
  useProjectDraftVersion();
  const draftProject = projectDraft();
  const [menu, setMenu] = useState<{ project: HubProject; anchor: PopoverAnchor }>();
  return (
    <nav
      aria-label="Projects"
      data-hub-strip
      className="sidebar-glass hub-strip flex h-full w-[68px] shrink-0 select-none flex-col items-center gap-1 pb-3"
      data-tauri-drag-region="deep"
    >
      {/* Room for the macOS traffic lights. */}
      {titleBarAbove ? <div className="h-1.5 w-full shrink-0" /> : <div className="h-10 w-full shrink-0" data-tauri-drag-region />}
      <StripButton
        label="Today"
        title="Today, all projects"
        selected={selection.project === "today"}
        onClick={() => { onLeaveCovers?.(); setHubSelection({ project: "today", item: "inbox" }); }}
        Icon={Clock}
      />
      <div className="h-2 shrink-0" />
      {projects.map((project) => {
        const count = waitingCount(project.id);
        return (
          <StripButton
            key={project.id}
            label={project.shortName}
            title={count ? `${project.name}, ${count} waiting on you` : project.name}
            selected={selection.project === project.id}
            onClick={() => onPickProject(project)}
            glyph={<ProjectGlyph project={project} />}
            count={count}
            onMenu={(anchor) => setMenu({ project, anchor })}
          />
        );
      })}
      {draftProject ? (
        <div data-hub-project-draft className="opacity-70">
          <StripButton
            label={draftProject.name.split(" ")[0]}
            title={`Draft: ${draftProject.name}, still being set up`}
            selected={selection.item === "new-project"}
            onClick={() => { onLeaveCovers?.(); setHubSelection({ project: "today", item: "new-project" }); }}
            glyph={<span className="grid size-full place-items-center rounded-[inherit] border border-dashed border-content/40 text-[11px] text-content/70">{draftInitial(draftProject.name)}</span>}
          />
        </div>
      ) : null}
      <StripButton label="" title="New project" selected={false} onClick={() => { onLeaveCovers?.(); setHubSelection({ project: "today", item: "new-project" }); }} Icon={Plus} />
      {menu ? <ProjectMenu project={menu.project} anchor={menu.anchor} onClose={() => setMenu(undefined)} /> : null}
      <RemovedUndoToast />
    </nav>
  );
}

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
  return (
    <div className="group/strip relative">
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-current={selected || undefined}
      onClick={onClick}
      onContextMenu={onMenu ? (e) => { e.preventDefault(); onMenu({ x: e.clientX, y: e.clientY }); } : undefined}
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
