// Dropwave (Ash, 11 Nov): the top of every sidebar, Home included. "Home" goes back to this project's home (or the
// main Home), and "Chief of Staff" opens its chat: on Home its own chat with everything in view, in a project the
// project's own Chief of Staff chat, geared to that project.
import { DashboardSquare, Sparkles } from "../../../shared/ui/icons";
import { RailAction } from "../../../app/shell/RailAction";
import { useSyncExternalStore } from "react";
import { listMonos, monosSnapshot, subscribeMonos } from "../../monos/model/mono";
import { openChiefChat, pickChief } from "../../home/model/chief";
import { captainChatId, ensureCaptainChat, useHubChatsVersion } from "../model/hubChats";
import { hubData, useHubDataVersion } from "../model/hubData";
import { PROJECT_HOME_ITEM, monoTeamInView, setHubSelection, showAppItem, showProjectHome, useHubSelection } from "../model/hubNav";

/** Opens a project's own Chief of Staff chat (made on first use). False when there is no Chief of Staff yet. */
export function openProjectChief(projectId: string): boolean {
  const chief = pickChief(listMonos());
  if (!chief) return false;
  const chat = ensureCaptainChat(projectId, chief.id);
  if (!chat) return false;
  setHubSelection({ project: projectId, item: `chat:${chat.id}` });
  return true;
}

export function HubTopNav({
  onLeaveCovers,
  openMonoId,
  covered = false,
}: {
  /** Inbox, Notes, Automations, Search or Settings covers the main area: neither row is the open one. */
  covered?: boolean;
  onLeaveCovers?: () => void;
  /** The Mono whose own chat covers the main area, if any: the Chief of Staff's means its row, not Home, is open. */
  openMonoId?: string | null;
}) {
  useHubDataVersion();
  useHubChatsVersion();
  useSyncExternalStore(subscribeMonos, monosSnapshot, monosSnapshot);
  const sel = useHubSelection();
  const chief = pickChief(listMonos());
  // The Chief of Staff's own chat (opened from Home) belongs to Home, not to the project last open underneath.
  const chiefOpen = !!chief && (monoTeamInView(sel) === chief.id || openMonoId === chief.id);
  // Another Mono's chat covering the main area: neither row is the open one.
  const otherMonoOpen = covered || (!!openMonoId && openMonoId !== chief?.id);
  const home = sel.item === "home" || sel.item === "agents" || !sel.project || chiefOpen;
  const project = home ? undefined : hubData().listProjects().find((p) => p.id === sel.project);
  const onHome = home ? sel.item === "home" : sel.item === PROJECT_HOME_ITEM;
  const onChief = project ? sel.item === `chat:${captainChatId(project.id)}` : chiefOpen;
  return (
    <div className="flex flex-col gap-px" data-hub-top-nav>
      {project ? (
        <div className="truncate px-2 pb-1 text-xs leading-5 text-content/50" data-hub-top-project>
          {project.name}
        </div>
      ) : null}
      <RailAction
        label="Home"
        icon={DashboardSquare}
        active={onHome && !chiefOpen && !otherMonoOpen}
        ariaLabel={project ? `${project.name} home` : "Home"}
        onClick={() => {
          onLeaveCovers?.();
          if (project) showProjectHome(project.id);
          else showAppItem("home");
        }}
      />
      {chief ? (
        <RailAction
          label={(chief.name ?? "").trim() || "Chief of Staff"}
          icon={Sparkles}
          active={onChief && !otherMonoOpen}
          ariaLabel={project ? `Chief of Staff for ${project.name}` : "Chief of Staff"}
          onClick={() => {
            onLeaveCovers?.();
            if (project) openProjectChief(project.id);
            else openChiefChat(chief.id);
          }}
        />
      ) : null}
    </div>
  );
}
