// Dropwave (Ash, 11 Nov): the top of every sidebar, Home included. "Home" goes back to this project's home (or the
// main Home), and "Chief of Staff" opens its chat: on Home its own chat with everything in view, in a project its own
// chat for that project, geared to it. Both are the same one-to-one chat layout as any agent's.
import { useSyncExternalStore } from "react";
import { DashboardSquare, Sparkles } from "../../../shared/ui/icons";
import { RailAction } from "../../../app/shell/RailAction";
import { listMonos, monosSnapshot, subscribeMonos } from "../../monos/model/mono";
import { openChiefChat, pickChief } from "../../home/model/chief";
import { hubData, useHubDataVersion } from "../model/hubData";
import { PROJECT_HOME_ITEM, monoTeamInView, openMonoChat, openMonoSettings, showAppItem, showProjectHome, useHubSelection } from "../model/hubNav";

/** Opens the Chief of Staff's own chat for a project (made on first use). False when there is no Chief of Staff yet. */
export function openProjectChief(projectId: string): boolean {
  const chief = pickChief(listMonos());
  if (!chief) return false;
  openMonoChat(chief.id, { project: projectId });
  return true;
}

export function HubTopNav({
  onLeaveCovers,
  openSessionId,
  covered = false,
}: {
  onLeaveCovers?: () => void;
  /** The chat that covers the main area, if a Mono's does: the Chief of Staff's means its row, not Home, is open. */
  openSessionId?: string | null;
  /** Inbox, Notes, Automations, Search or Settings covers the main area: neither row is the open one. */
  covered?: boolean;
}) {
  useHubDataVersion();
  useSyncExternalStore(subscribeMonos, monosSnapshot, monosSnapshot);
  const sel = useHubSelection();
  const chief = pickChief(listMonos());
  // The Chief of Staff's chat with everything in view (opened from Home) belongs to Home, not to the project last
  // open underneath.
  const homeChiefOpen =
    !!chief && (monoTeamInView(sel) === chief.id || (!!openSessionId && openSessionId === chief.sessionId));
  const home = sel.item === "home" || sel.item === "agents" || !sel.project || homeChiefOpen;
  const project = home ? undefined : hubData().listProjects().find((p) => p.id === sel.project);
  const projectChiefOpen =
    !!chief && !!project && !!openSessionId && chief.projectSessions?.[project.id] === openSessionId;
  const chiefOpen = project ? projectChiefOpen : homeChiefOpen;
  const onHome = home ? sel.item === "home" : sel.item === PROJECT_HOME_ITEM;
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
        active={onHome && !chiefOpen && !covered && !openSessionId}
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
          active={chiefOpen && !covered}
          ariaLabel={project ? `Chief of Staff for ${project.name}` : "Chief of Staff"}
          // Ash (12 Nov): right-click opens its settings, where its model is chosen.
          onOpenContextMenu={() => {
            onLeaveCovers?.();
            openMonoSettings(chief.id);
          }}
          onClick={() => {
            if (project) openProjectChief(project.id);
            else {
              onLeaveCovers?.();
              openChiefChat(chief.id);
            }
          }}
        />
      ) : null}
    </div>
  );
}
