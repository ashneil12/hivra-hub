import { useState } from "react";
import type { PopoverAnchor } from "../../../shared/ui/Popover";
import { ProjectGlyph, ProjectMenu } from "./ProjectMenu";
import { MoreHorizontal, Plus, DashboardSquare as Layers, MessageMultiple as MessagesSquare, Play as PackageOpen, Terminal as Code2, Wrench as Hammer, type IconComponent } from "../../../shared/ui/icons";
import { hubData, useHubDataVersion } from "../model/hubData";
import { useHubChatsVersion } from "../model/hubChats";
import { setHubSelection, type HubSelection } from "../model/hubNav";
import { leadSpecFor } from "../model/hubLeads";
import type { HubProject, ProjectItem } from "../model/types";

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

/** What an item is, on hover: the coding team (its Lead and chats) against the leadership team's group chat. */
function itemHint(item: ProjectItem, project: HubProject): string | undefined {
  if (item.kind === "coding-team") return `${leadSpecFor(project).name} and your chats in ${project.name}'s code`;
  if (item.kind === "leadership-team") return "The leadership team's group chat";
  if (item.kind === "group-chat") return "A group chat";
  return undefined;
}

/** The project's items, where Monocode's rail lists Projects. */
export function HubProjectItems({
  selection,
  onPick,
}: {
  selection: HubSelection;
  onPick: (item: ProjectItem) => void;
}) {
  useHubDataVersion();
  useHubChatsVersion();
  const [menu, setMenu] = useState<PopoverAnchor>();
  if (selection.project === "today") return null;
  const project = hubData().listProjects().find((p) => p.id === selection.project);
  if (!project) return null;
  const items = hubData().listProjectItems(project.id);
  return (
    <div className="mb-2 shrink-0" data-hub-items>
      <div className="group/head flex items-center gap-1 px-3 pb-1.5 pt-1" data-hub-project-header
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}>
        <span className="grid size-4 shrink-0 place-items-center"><ProjectGlyph project={project} size={11} /></span>
        <span className="min-w-0 flex-1 truncate px-1 text-xs leading-5 text-content/60">{project.name}</span>
        <button type="button" title={`${project.name} options`} aria-label={`${project.name} options`} data-project-more
          onClick={(e) => setMenu(e.currentTarget)}
          className="grid size-5 shrink-0 place-items-center rounded-md text-content/60 opacity-0 hover:bg-content/8 hover:text-content focus:opacity-100 group-hover/head:opacity-100">
          <MoreHorizontal className="size-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          title="New group chat"
          aria-label="New group chat"
          data-hub-new-chat-button
          onClick={() => setHubSelection({ project: project.id, item: "new-chat" })}
          className="grid size-5 shrink-0 place-items-center rounded-md text-content/60 hover:bg-content/8 hover:text-content"
        >
          <Plus className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>
      <div className="flex flex-col gap-px px-2">
        {items.map((item) => {
          const Icon = iconFor(item);
          const selected = selection.item === item.id;
          return (
            <button
              key={item.id}
              type="button"
              // Which is which (Ash, 20 Oct): the coding team is where he talks to the project's Lead and its chats; the
              // leadership team is a group chat (the room).
              title={itemHint(item, project)}
              data-hub-item={item.kind}
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
      {menu ? <ProjectMenu project={project} anchor={menu} onClose={() => setMenu(undefined)} /> : null}
    </div>
  );
}
