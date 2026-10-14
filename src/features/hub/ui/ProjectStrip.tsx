import { Clock, Folder, Gauge, Ghost, Palette, Plus, Sparkles, type IconComponent } from "../../../shared/ui/icons";
import { hubData } from "../model/hubData";
import { setHubSelection, type HubSelection } from "../model/hubNav";
import type { HubProject, ProjectIconShape } from "../model/types";

const SHAPES: Record<ProjectIconShape, IconComponent> = {
  ghost: Ghost,
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
}: {
  selection: HubSelection;
  onPickProject: (project: HubProject) => void;
  onCreateProject: () => void;
}) {
  const data = hubData();
  const projects = data.listProjects();
  return (
    <nav
      aria-label="Projects"
      data-hub-strip
      className="flex h-full w-[68px] shrink-0 select-none flex-col items-center gap-1 bg-black/20 pb-3"
      data-tauri-drag-region="deep"
    >
      {/* Room for the macOS traffic lights. */}
      <div className="h-10 w-full shrink-0" data-tauri-drag-region />
      <StripButton
        label="Today"
        title="Today, all projects"
        selected={selection.project === "today"}
        onClick={() => setHubSelection({ project: "today", item: "inbox" })}
        Icon={Clock}
      />
      <div className="h-2 shrink-0" />
      {projects.map((project) => {
        const count = data.needCount(project.id);
        return (
          <StripButton
            key={project.id}
            label={project.shortName}
            title={count ? `${project.name}, ${count} waiting on you` : project.name}
            selected={selection.project === project.id}
            onClick={() => onPickProject(project)}
            Icon={SHAPES[project.iconShape]}
            count={count}
          />
        );
      })}
      <StripButton label="" title="New project" selected={false} onClick={onCreateProject} Icon={Plus} />
    </nav>
  );
}

function StripButton({
  label,
  title,
  selected,
  onClick,
  Icon,
  count,
}: {
  label: string;
  title: string;
  selected: boolean;
  onClick: () => void;
  Icon: IconComponent;
  count?: number;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-current={selected || undefined}
      onClick={onClick}
      className="group flex w-14 shrink-0 flex-col items-center gap-1 py-1"
    >
      <span
        className={`relative grid size-9 place-items-center rounded-[10px] transition-colors ${
          selected ? "bg-content/12 text-content" : "text-content/65 group-hover:bg-content/8 group-hover:text-content"
        }`}
      >
        <Icon className="size-[18px]" strokeWidth={1.75} />
        {count ? (
          <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-background-base px-1 text-center text-[10px] leading-4 text-content/75">
            {count}
          </span>
        ) : null}
      </span>
      {label ? (
        <span className={`max-w-full truncate text-[11px] leading-3 ${selected ? "text-content" : "text-content/60"}`}>
          {label}
        </span>
      ) : null}
    </button>
  );
}
