import { DashboardSquare as Layers, MessageMultiple as MessagesSquare, Play as PackageOpen, Terminal as Code2, Wrench as Hammer, type IconComponent } from "../../../shared/ui/icons";
import { hubData } from "../model/hubData";
import { setHubSelection, type HubSelection } from "../model/hubNav";
import type { ProjectItem } from "../model/types";

function iconFor(item: ProjectItem): IconComponent {
  switch (item.kind) {
    case "coding-team":
      return Code2;
    case "leadership-team":
    case "group-chat":
      return MessagesSquare;
    case "being-built":
      return Hammer;
    default:
      return item.sectionType === "builds-playtests" ? PackageOpen : Layers;
  }
}

/** The project's items, where Monocode's rail lists Projects. */
export function HubProjectItems({
  selection,
  onPick,
}: {
  selection: HubSelection;
  onPick: (item: ProjectItem) => void;
}) {
  if (selection.project === "today") return null;
  const project = hubData().listProjects().find((p) => p.id === selection.project);
  if (!project) return null;
  const items = hubData().listProjectItems(project.id);
  return (
    <div className="mb-2 shrink-0" data-hub-items>
      <div className="px-3 pb-1.5 pt-1">
        <span className="block truncate px-1 text-xs leading-5 text-content/60">{project.name}</span>
      </div>
      <div className="flex flex-col gap-px px-2">
        {items.map((item) => {
          const Icon = iconFor(item);
          const selected = selection.item === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setHubSelection({ project: project.id, item: item.id });
                onPick(item);
              }}
              className={`flex h-7 items-center gap-2 rounded-md px-2 text-left text-[13px] ${
                selected ? "bg-selection text-content" : "text-content/80 hover:bg-content/6 hover:text-content"
              }`}
            >
              <Icon className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
