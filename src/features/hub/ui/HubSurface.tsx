import { Clock, Inbox, MessageMultiple as MessagesSquare, Play as PackageOpen, Wrench as Hammer, type IconComponent } from "../../../shared/ui/icons";
import { IS_MAC } from "../../../platform/tauri/platform";
import { hubData, sinceLabel, todayRows } from "../model/hubData";
import type { HubSelection } from "../model/hubNav";
import type { Need, StuckItem } from "../model/types";
import { GroupChatView, NewGroupChat } from "./GroupChatView";
import { StatusMark } from "./StatusMark";
import { BuildsView } from "./BuildsView";
import { leadershipChatId, useHubChatsVersion } from "../model/hubChats";


/**
 * Main area for the hub views. Unit 1 ships the shell: the title row matches
 * Monocode's own views (no breadcrumbs), the bodies are filled in later units.
 */
export function HubSurface({ selection }: { selection: HubSelection }) {
  useHubChatsVersion();
  const data = hubData();
  if (selection.project !== "today") {
    if (selection.item === "leadership-team")
      return <GroupChatView key={selection.project} chatId={leadershipChatId(selection.project)} projectId={selection.project} />;
    if (selection.item.startsWith("chat:"))
      return <GroupChatView key={selection.item} chatId={selection.item.slice(5)} projectId={selection.project} />;
    if (selection.item === "new-chat") return <NewGroupChat projectId={selection.project} />;
    const section = data.listProjectItems(selection.project).find((i) => i.id === selection.item);
    if (section?.sectionType === "builds-playtests")
      return <BuildsView key={selection.project} projectId={selection.project} title={section.title} />;
  }
  const project = data.listProjects().find((p) => p.id === selection.project);
  const item = project ? data.listProjectItems(project.id).find((i) => i.id === selection.item) : undefined;

  let Icon: IconComponent = Clock;
  let title = "Today";
  let body = <TodayBody projectId={undefined} />;
  if (project) {
    if (!item) {
      Icon = Inbox;
      title = "Inbox";
      body = <TodayBody projectId={project.id} />;
    } else {
      title = item.title;
      Icon = item.kind === "leadership-team" || item.kind === "group-chat" ? MessagesSquare : item.kind === "being-built" ? Hammer : PackageOpen;
      body = <Pending what={item.title} unit={item.kind === "leadership-team" ? 4 : item.kind === "being-built" ? 6 : 5} />;
    }
  }

  return (
    <div role="region" aria-label={title} data-hub-surface className="flex min-h-0 min-w-0 flex-1 flex-col text-content">
      <div className="flex h-10 shrink-0 select-none items-center border-b border-stroke" data-tauri-drag-region="deep">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <Icon className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
          <span className="min-w-0 truncate text-content">{title}</span>
        </div>
        {IS_MAC ? null : <div className="w-[120px]" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </div>
  );
}

function TodayBody({ projectId }: { projectId: string | undefined }) {
  const data = hubData();
  const since = data.sinceSummary(projectId);
  const { needs, stuck } = todayRows(projectId);
  const projects = data.listProjects().filter((p) => !projectId || p.id === projectId);
  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-6 px-8 py-8">
      <section>
        <h2 className="mb-2 text-xs text-content/60">{sinceLabel(data.lastActiveAt())}</h2>
        <p className="text-[13px] leading-5 text-content/85">{since.plainText}</p>
      </section>
      {projects.map((p) => {
        const pNeeds = needs.filter((n) => n.projectId === p.id);
        const pStuck = stuck.filter((s) => s.projectId === p.id);
        if (!pNeeds.length && !pStuck.length) return null;
        return (
          <section key={p.id}>
            {projectId ? null : <h2 className="mb-1 text-xs text-content/60">{p.name}</h2>}
            <div className="flex flex-col">
              {pStuck.map((s) => (
                <StuckRow key={s.id} item={s} />
              ))}
              {pNeeds.map((n) => (
                <NeedRow key={n.id} need={n} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function NeedRow({ need }: { need: Need }) {
  return (
    <div className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-content/5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-content">{need.title}</div>
        <div className="truncate text-[13px] text-content/60">{need.why}</div>
      </div>
      <button type="button" className="shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12">
        {need.actionLabel}
      </button>
    </div>
  );
}

/** The only rows that carry a status: a 14px circle and a plain word. */
function StuckRow({ item }: { item: StuckItem }) {
  return (
    <div className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-content/5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-content">{item.title}</div>
        <div className="truncate text-[13px] text-content/60">{item.detail}</div>
      </div>
      <StatusMark state={item.state} />
    </div>
  );
}

function Pending({ what, unit }: { what: string; unit: number }) {
  return (
    <div className="grid h-full place-items-center px-8 text-center">
      <p className="text-[13px] text-content/60">
        {what} is built in Unit {unit}. Unit 1 is the app shell.
      </p>
    </div>
  );
}
