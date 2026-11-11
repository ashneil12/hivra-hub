import { Fragment, useState } from "react";
import type { PopoverAnchor } from "../../../shared/ui/Popover";
import { ProjectGlyph, ProjectMenu } from "./ProjectMenu";
import { confirmDelete } from "../../../shared/ui/ConfirmDelete";
import { deleteChat } from "../model/hubChats";
import { MoreHorizontal, Plus, Trash2, DashboardSquare as Layers, MessageMultiple as MessagesSquare, Terminal as Code2, type IconComponent } from "../../../shared/ui/icons";
import { hubData, useHubDataVersion } from "../model/hubData";
import { useNeedsYou } from "../../needs/model/needsLive";
import { useHubChatsVersion } from "../model/hubChats";
import { useTemplatesVersion } from "../model/templates";
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
    default:
      return Layers;
  }
}

/** WP-06: Being built, Builds and the Decisions row are not sidebar items. */
function keptNavItem(item: ProjectItem): boolean {
  return item.kind !== "being-built" && item.sectionType !== "builds-playtests" && item.sectionType !== "decisions" && item.id !== "decisions";
}

/** What an item is, on hover: the coding team (its Lead and chats) against the leadership team's group chat. */
function itemHint(item: ProjectItem, project: HubProject): string | undefined {
  if (item.kind === "coding-team") return `${leadSpecFor(project).name} and your chats in ${project.name}'s code`;
  if (item.kind === "leadership-team") return "The leadership team's group chat";
  if (item.kind === "group-chat") return "A group chat";
  return undefined;
}

/** Asks first (the shared confirm), then deletes the room; if it was open, the project's Leadership team opens instead. */
export async function deleteRoom(projectId: string, item: ProjectItem, selection: HubSelection): Promise<boolean> {
  if (!(await confirmDelete(item.title))) return false;
  const chatId = item.id.startsWith("chat:") ? item.id.slice("chat:".length) : item.id;
  if (!deleteChat(chatId)) return false;
  if (selection.project === projectId && selection.item === item.id) setHubSelection({ project: projectId, item: "leadership-team" });
  return true;
}

/** The project's items, where Monocode's rail lists Projects. */
export function HubProjectItems({
  selection,
  onPick,
  monoOpen = false,
}: {
  selection: HubSelection;
  onPick: (item: ProjectItem) => void;
  /** A Mono's 1:1 covers the main area: the Monos rail marks that Mono, so no project item is highlighted. */
  monoOpen?: boolean;
}) {
  useHubDataVersion();
  useHubChatsVersion();
  // WP-210: the header count and the sidebar total are the one Needs you list.
  const needs = useNeedsYou();
  // The project's sections come from its template, so switching it changes this list too.
  useTemplatesVersion();
  const [menu, setMenu] = useState<PopoverAnchor>();
  const project = hubData().listProjects().find((p) => p.id === selection.project);
  if (!project) return null;
  // A new project's draft is no project's page (PM's r60 G2): the project Ash was last in stays underneath, so leaving
  // the draft comes back to it, but its name and items aren't shown as if the draft were one of its pages.
  if (selection.item === "new-project") return null;
  // WP-06: Being built, Builds and the project's Decisions row are gone. Settings → Decisions still lists them.
  const items = hubData().listProjectItems(project.id).filter((item) => keptNavItem(item));
  const projectNeeds = needs.filter((item) => item.projectId === project.id).length;
  return (
    <div className="mb-2 shrink-0" data-hub-items>
      <div className="group/head flex items-center gap-1 px-3 pb-1.5 pt-1" data-hub-project-header data-project-id={project.id}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}>
        <span className="grid size-4 shrink-0 place-items-center"><ProjectGlyph project={project} size={11} /></span>
        <span className="min-w-0 flex-1 truncate px-1 text-xs leading-5 text-content/60">{project.name}</span>
        {projectNeeds > 0 ? (
          <span
            data-project-needs={projectNeeds}
            className="shrink-0 rounded-full px-1 text-[10px] leading-4 text-white"
            style={{ background: "#e5484d" }}
          >
            {projectNeeds}
          </span>
        ) : null}
        <span data-sidebar-needs-count={needs.length} className="sr-only">
          {needs.length > 0 ? `${needs.length} Needs you` : "Needs you"}
        </span>
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
          // Only the open thing is highlighted (PM's r35 check, 22 Oct): not Coding team or Leadership team under a 1:1.
          const selected = !monoOpen && selection.item === item.id;
          const row = (
            <button
              key={item.id}
              type="button"
              // Which is which (Ash, 20 Oct): the coding team is where he talks to the project's Lead and its chats; the
              // leadership team is a group chat (the room).
              title={itemHint(item, project)}
              data-hub-item={item.kind}
              aria-current={selected ? "page" : undefined}
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
          // WP-71: Tasks sits next to the coding team. It is not a stored project item, so it is not data-hub-item.
          if (item.kind === "coding-team") {
            const tasksOpen = !monoOpen && selection.item === "tasks";
            return (
              <Fragment key={item.id}>
                {row}
                <button
                  type="button"
                  data-hub-tasks
                  aria-current={tasksOpen ? "page" : undefined}
                  onClick={() => setHubSelection({ project: project.id, item: "tasks" })}
                  className={`flex h-7 items-center gap-2 rounded-md px-2 text-left text-[13px] ${
                    tasksOpen ? "bg-selection text-content" : "text-content/80 hover:bg-content/6 hover:text-content"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">Tasks</span>
                </button>
              </Fragment>
            );
          }
          // A room Ash made can be deleted (r30d), after the shared confirm; the Leadership team and the rest can't.
          if (item.kind !== "group-chat") return row;
          return (
            <div
              key={item.id}
              className="group/room relative flex min-w-0 items-center"
              data-hub-room-row={item.id}
              // Right-click asks the same confirm as the trash button (r49).
              onContextMenu={(e) => {
                e.preventDefault();
                void deleteRoom(project.id, item, selection);
              }}
            >
              <div className="min-w-0 flex-1 [&>button]:w-full [&>button]:pr-7">{row}</div>
              <button
                type="button"
                data-hub-room-delete={item.id}
                title={`Delete ${item.title}`}
                aria-label={`Delete ${item.title}`}
                onClick={() => void deleteRoom(project.id, item, selection)}
                className="absolute right-1 grid size-5 place-items-center rounded-md text-content/45 opacity-0 hover:bg-content/8 hover:text-red-400 focus-visible:opacity-100 group-hover/room:opacity-100"
              >
                <Trash2 className="size-3" strokeWidth={1.75} />
              </button>
            </div>
          );
        })}
      </div>
      {menu ? <ProjectMenu project={project} anchor={menu} onClose={() => setMenu(undefined)} /> : null}
    </div>
  );
}
