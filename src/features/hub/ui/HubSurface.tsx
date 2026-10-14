import { useRef, useState } from "react";
import { parseSetup, setPendingSetup } from "../model/setupFile";
import { signIn, useConnectorsVersion } from "../model/connectors";
import { RestorePreview } from "./RestorePreview";
import { Clock, Inbox, MessageMultiple as MessagesSquare, Play as PackageOpen, Wrench as Hammer, type IconComponent } from "../../../shared/ui/icons";
import { IS_MAC } from "../../../platform/tauri/platform";
import { hubData, sinceLabel } from "../model/hubData";
import { laterItems, setupItems, waitingOnAsh, type WaitingItem } from "../model/waiting";
import { setHubSelection } from "../model/hubNav";
import type { HubSelection } from "../model/hubNav";
import type { Need } from "../model/types";
import { GroupChatView, NewGroupChat } from "./GroupChatView";
import { StatusMark } from "./StatusMark";
import { BuildsView } from "./BuildsView";
import { BeingBuiltView } from "./BeingBuiltView";
import { ProposalView } from "./ProposalView";
import { NewProjectView } from "./NewProjectView";
import { useTemplatesVersion } from "../model/templates";
import { leadershipChatId, useHubChatsVersion } from "../model/hubChats";
import { useProposalsVersion } from "../model/proposals";
import { useHubBuildsVersion } from "../model/hubBuilds";


/**
 * Main area for the hub views. Unit 1 ships the shell: the title row matches
 * Monocode's own views (no breadcrumbs), the bodies are filled in later units.
 */
export function HubSurface({ selection }: { selection: HubSelection }) {
  useHubChatsVersion();
  useProposalsVersion();
  useTemplatesVersion();
  useConnectorsVersion();
  useHubBuildsVersion();
  if (selection.item === "new-project") return <NewProjectView />;
  if (selection.item === "restore") return <RestorePreview />;
  const data = hubData();
  if (selection.project !== "today") {
    if (selection.item === "leadership-team")
      return <GroupChatView key={selection.project} chatId={leadershipChatId(selection.project)} projectId={selection.project} />;
    if (selection.item.startsWith("chat:"))
      return <GroupChatView key={selection.item} chatId={selection.item.slice(5)} projectId={selection.project} />;
    if (selection.item === "new-chat") return <NewGroupChat projectId={selection.project} />;
    if (selection.item.startsWith("proposal:"))
      return <ProposalView key={selection.item} id={selection.item.slice(9)} />;
    if (selection.item === "being-built") return <BeingBuiltView key={selection.project} projectId={selection.project} />;
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
  if (!data.listProjects().length) return <FirstTodayEmpty />;
  const since = data.sinceSummary(projectId);
  const waiting = waitingOnAsh(projectId);
  const projects = data.listProjects().filter((p) => !projectId || p.id === projectId);
  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-6 px-8 py-8">
      <section>
        <h2 className="mb-2 text-xs text-content/60">{sinceLabel(data.lastActiveAt())}</h2>
        <p className="text-[13px] leading-5 text-content/85">{since.plainText}</p>
      </section>
      {!projectId && setupItems().length ? (
        <section data-hub-setup>
          <h2 className="mb-1 text-xs text-content/60">Setup</h2>
          <p className="px-2 pb-1 text-[13px] text-content/60">Passwords and keys never travel in the setup file.</p>
          <div className="flex flex-col">
            {setupItems().map((w) => (
              <StuckRow key={w.id} item={w} />
            ))}
          </div>
        </section>
      ) : null}
      {projects.map((p) => {
        const pStuck = waiting.filter((w) => w.projectId === p.id && w.state);
        const pNeeds = waiting.flatMap((w) => (w.projectId === p.id && w.need ? [w.need] : []));
        const pOther = waiting.filter((w) => w.projectId === p.id && !w.state && !w.need);
        if (!pNeeds.length && !pStuck.length && !pOther.length) return null;
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
              {pOther.map((w) => (
                <StuckRow key={w.id} item={w} />
              ))}
              {laterItems(p.id).length ? (
                <div className="px-2 pt-1 text-xs text-content/60" data-hub-later>
                  {laterItems(p.id).length} more under Later
                </div>
              ) : null}
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
function StuckRow({ item }: { item: WaitingItem }) {
  return (
    <div className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-content/5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-content">{item.title}</div>
        {item.detail ? <div className="line-clamp-2 text-[13px] text-content/60">{item.detail}</div> : null}
      </div>
      {item.state ? <StatusMark state={item.state} /> : null}
      {item.target || item.connectorId ? (
        <button
          type="button"
          data-hub-take-look={item.id}
          onClick={() => (item.connectorId ? signIn(item.connectorId) : item.target && setHubSelection(item.target))}
          className="shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12"
        >
          {item.actionLabel ?? "Take a look"}
        </button>
      ) : null}
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

/** Clean first launch: no projects yet. One calm action. */
function FirstTodayEmpty() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      setPendingSetup(parseSetup(await f.text()), f.name);
      setHubSelection({ project: "today", item: "restore" });
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't read that file.");
    }
  };
  return (
    <div className="grid h-full place-items-center px-8" data-hub-today-empty>
      <div className="flex max-w-[420px] flex-col items-center gap-3 text-center">
        <p className="text-[13px] text-content">No projects yet.</p>
        <p className="text-[13px] leading-5 text-content/60">
          Make your first project, or bring yours back from a setup file. Then Today fills up with what changed and what's waiting on you.
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-hub-today-new-project
            onClick={() => setHubSelection({ project: "today", item: "new-project" })}
            className="rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90"
          >
            New project
          </button>
          <button
            type="button"
            data-hub-today-restore
            onClick={() => fileRef.current?.click()}
            className="rounded-md px-3 py-1.5 text-[13px] text-content/60 hover:bg-content/8 hover:text-content"
          >
            Restore a setup file
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" data-hub-today-file
            onChange={(e) => void onFile(e.target.files?.[0])} />
        </div>
        {note ? <p className="text-[13px] text-content/60">{note}</p> : null}
      </div>
    </div>
  );
}
