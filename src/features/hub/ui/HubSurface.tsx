import { useEffect, useRef, useState } from "react";
import { pickExportForRestore, readImportText, setPendingImport } from "../../portable/model/portable";
import { RestorePreview } from "./RestorePreview";
import { FolderOpen } from "../../../shared/ui/icons";
import { IS_MAC } from "../../../platform/tauri/platform";
import { dismissDoneNeeds, hubData, useHubDataVersion } from "../model/hubData";
import { appItemInView, NO_CODE_ITEM, PROJECT_HOME_ITEM, openCodingTeam, showAppItem } from "../model/hubNav";
import type { HubSelection } from "../model/hubNav";
import { GroupChatView, NewGroupChat } from "./GroupChatView";
import { NewProjectView } from "./NewProjectView";
import { leadershipChatId, useHubChatsVersion } from "../model/hubChats";
import { useProposalsVersion } from "../model/proposals";
import { useTemplatesVersion } from "../model/templates";
import { ProposalView } from "./ProposalView";
import { ProjectPagesView } from "./ProjectPagesView";
import { AutopilotView } from "../../autopilot/ui/AutopilotView";
import { HomeView } from "../../home/ui/HomeView";
import { TasksScreen } from "../../tasks/ui/TasksScreen";
import { AgentsBoardScreen } from "../../agents-board/ui/AgentsBoardScreen";

/**
 * Main area for the hub views that are not a project's workspace: rooms, Pages, a new project, restore, autopilot.
 * WP-06: Today, Being built, Decisions and Builds are gone. A project's home is its coding team.
 */
export function HubSurface({ selection }: { selection: HubSelection }) {
  useHubDataVersion();
  // Needs that ticked themselves off while Ash was looking go away once he leaves the page.
  useEffect(() => dismissDoneNeeds, [selection.project, selection.item]);
  useHubChatsVersion();
  useProposalsVersion();
  useTemplatesVersion();
  const data = hubData();
  const projects = data.listProjects();
  const project = projects.find((p) => p.id === selection.project);
  // A project is the unit of the hub: with no project chosen and projects there, the app opens the first one's coding
  // team. With none at all it offers to start one. (A Mono's own team fills the workspace instead; App.tsx doesn't show
  // the hub then.)
  const home = !project && !appItemInView(selection);
  const first = projects[0]?.id;
  useEffect(() => {
    if (home && first) openCodingTeam(first);
  }, [home, first]);
  // WP-73: Home, before the no-project redirect and before a project's own item.
  if (selection.item === "home") return <HomeView />;
  // WP-219: the Agents board. On by default. Not a project item.
  if (selection.item === "agents") return <AgentsBoardScreen />;
  if (selection.item === "new-project") return <NewProjectView />;
  if (selection.item === "restore") return <RestorePreview />;
  if (selection.item === "autopilot") return <AutopilotView />;
  if (!project) return <HubHome />;
  // Dropwave: a project opens on its own home (the Chief of Staff's box, then what this project needs and has).
  if (selection.item === PROJECT_HOME_ITEM) return <HomeView key={project.id} projectId={project.id} />;
  if (selection.item === "leadership-team")
    return <GroupChatView key={project.id} chatId={leadershipChatId(project.id)} projectId={project.id} />;
  if (selection.item.startsWith("chat:"))
    return <GroupChatView key={selection.item} chatId={selection.item.slice(5)} projectId={project.id} />;
  if (selection.item === "new-chat") return <NewGroupChat projectId={project.id} />;
  if (selection.item.startsWith("proposal:")) return <ProposalView key={selection.item} id={selection.item.slice(9)} />;
  // WP-06: no code folder. A page, so the previous project's workspace is not left up. Do not open the coding team.
  if (selection.item === NO_CODE_ITEM) {
    return (
      <div role="region" aria-label="No code folder" data-hub-no-code className="grid min-h-0 min-w-0 flex-1 place-items-center px-8 text-content">
        <p className="max-w-[420px] text-center text-[13px] text-content/80">This project has no code folder yet.</p>
      </div>
    );
  }
  const section = data.listProjectItems(project.id).find((i) => i.id === selection.item);
  if (section?.sectionType === "project-pages")
    return <ProjectPagesView key={project.id} projectId={project.id} title={section.title} />;
  // WP-71: tasks are a project page, not the coding team.
  if (selection.item === "tasks" || selection.item === "all-tasks") {
    return <TasksScreen cwd={project.folder || project.id} scope={selection.item === "all-tasks" ? "all" : "project"} rail />;
  }
  // WP-06: Today, Being built, Decisions and Builds. A stored one opens the coding team.
  return <LeaveForCodingTeam projectId={project.id} />;
}

/** A retired hub item, or one this surface no longer draws. The coding team is the project's home. */
function LeaveForCodingTeam({ projectId }: { projectId: string }) {
  useEffect(() => {
    openCodingTeam(projectId);
  }, [projectId]);
  return null;
}

/**
 * No project chosen: the create-a-project empty state (or what keeps the hub from loading). There is no central area
 * and no board of all projects: a project is the unit of the hub, and HubSurface opens the first one's coding team as
 * soon as there is one.
 */
function HubHome() {
  useHubDataVersion();
  const data = hubData();
  const connection = data.connection();
  return (
    <div role="region" aria-label="Projects" data-hub-surface className="flex min-h-0 min-w-0 flex-1 flex-col text-content">
      <div className="flex h-10 shrink-0 select-none items-center border-b border-stroke" data-tauri-drag-region="deep">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <FolderOpen className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
          <span className="min-w-0 truncate text-content">Projects</span>
        </div>
        {IS_MAC ? null : <div className="w-[120px]" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {connection.status === "unreachable" ? (
          <AshOsDown message={connection.message} retrying={connection.retrying} onRetry={() => data.retry()} />
        ) : connection.status === "loading" || data.listProjects().length ? (
          // Reading the local store: a project's coding team opens a moment later, so say nothing rather than flash "No projects yet".
          <div data-hub-loading />
        ) : (
          <FirstTodayEmpty />
        )}
      </div>
    </div>
  );
}

/** The local store can't be reached: one calm sentence and one button. Never example data. */
function AshOsDown({ message, retrying, onRetry }: { message?: string; retrying?: boolean; onRetry: () => void }) {
  const heading = "The harness service is unavailable.";
  const help = message && message !== heading && !/\b(Ash|Hub) OS\b/.test(message) ? message : "Start it, then try again. Your projects and Needs come back on their own.";
  return (
    <div className="grid h-full place-items-center px-8" data-hub-down>
      <div className="flex max-w-[420px] flex-col items-center gap-3 text-center">
        <p className="text-[13px] text-content">{heading}</p>
        <p className="text-[13px] leading-5 text-content/60">{help}</p>
        <HomeTools />
        <button
          type="button"
          data-hub-down-retry
          disabled={retrying}
          onClick={onRetry}
          className="rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90 disabled:opacity-60"
        >
          {retrying ? "Trying…" : "Try again"}
        </button>
      </div>
    </div>
  );
}

/** Clean first launch: no projects yet. Start one, or restore from an export. */
function FirstTodayEmpty() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      setPendingImport(readImportText(f.name, await f.text()));
      showAppItem("restore");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't read that file.");
    }
  };
  const pick = async () => {
    try {
      const p = await pickExportForRestore();
      if (p === "browser") return fileRef.current?.click();
      if (!p) return;
      setPendingImport(p);
      showAppItem("restore");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't read that export.");
    }
  };
  return (
    <div className="grid h-full place-items-center px-8" data-hub-today-empty>
      <div className="flex max-w-[420px] flex-col items-center gap-3 text-center">
        <p className="text-[13px] text-content" data-hub-today-empty-line>No projects yet. Start one to talk with its coding team.</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-hub-today-new-project
            onClick={() => showAppItem("new-project")}
            className="rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90"
          >
            New project
          </button>
          <button
            type="button"
            data-hub-today-restore
            onClick={() => void pick()}
            className="rounded-md px-3 py-1.5 text-[13px] text-content/60 hover:bg-content/8 hover:text-content"
          >
            Restore from an export
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" data-hub-today-file
            onChange={(e) => void onFile(e.target.files?.[0])} />
        </div>
        {note ? <p className="text-[13px] text-content/60">{note}</p> : null}
      </div>
    </div>
  );
}

/** Local views remain accessible even while the shared service is unavailable. */
function HomeTools() {
  return <nav aria-label="Workspace shortcuts" className="flex flex-wrap gap-2" data-hub-home-tools>
    {(["Pages", "Notes", "Automations"] as const).map((name) => <button key={name} type="button" onClick={() => window.dispatchEvent(new CustomEvent("monocode:home-open", { detail: name.toLowerCase() }))}
      className="rounded-md bg-content/5 px-3 py-1.5 text-[12px] text-content/75 hover:bg-content/10">{name}</button>)}
  </nav>;
}
