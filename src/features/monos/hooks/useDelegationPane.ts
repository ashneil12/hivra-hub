// What a chat's pane adds for the delegation tree (H4): a worker's chat runs on its own ("Runs on its own · Open
// <Lead>" in place of the composer, until Ash jumps in), and a Mono with work out reads "2 working: API, UI" with one
// Stop (leadFlow.ts), while it goes on talking with Ash, and a card for each worker that is stuck (asking, stalled or
// failed; workerStuck.ts), which the line names too ("1 stuck: Tests").
import {
  delegationActions,
  hasJumpedIn,
  jumpIn,
  noteStopFailures,
  stopFailures,
  stopUnloaded,
  useDelegationRows,
} from "../model/delegationStore";
import { isOpenDelegation } from "../model/delegations";
import {
  delegationOf,
  startedByMono,
  waitingOn,
} from "../model/delegationView";
import { workingOn } from "../model/leadFlow";
import { findMono, listMonos, monoForSession, monoLook } from "../model/mono";
import {
  leadRollup,
  stuckOf,
  stuckOwnedBy,
  useStuckDismissalsVersion,
  type StuckWorker,
} from "../model/workerStuck";
import { useClock } from "./useStuckWorkers";
import {
  codingTeamChatProject,
  codingTeamName,
  startedByCodingTeamChat,
  useCodingTeamVersion,
} from "../../hub/model/codingTeam";
import { hubData } from "../../hub/model/hubData";
import { leadFor } from "../../hub/model/hubLeads";
import { openCodingTeam } from "../../hub/model/hubNav";
import { briefedTeams, type BriefTeam, type BriefedTeam } from "../model/briefedTeams";

/** A hub project by id, for its name. */
function hubProjectNamed(id: string) {
  return hubData().listProjects().find((project) => project.id === id);
}

/** The coding team a Lead's chat is (briefedTeams.ts): its project, the team's name and the Lead's. */
function briefTeamOf(leadChat: string): BriefTeam | undefined {
  const mono = monoForSession(leadChat);
  const lead = mono ? leadFor(mono.id) : undefined;
  const project = lead ? hubProjectNamed(lead.projectId) : undefined;
  return mono && lead && project ? { projectId: project.id, team: codingTeamName(project), leadName: monoLook(mono).name } : undefined;
}

export type DelegationPane =
  | {
      kind: "worker";
      ownerName: string;
      state: "running" | "asking" | "finished";
      /** How it is stuck, if it is (asking, stalled or failed): answerable right here, without jumping in. */
      stuck?: StuckWorker;
      now: number;
      onOpenOwner?: () => void;
      onJumpIn: () => void;
    }
  | {
      kind: "lead";
      count: number;
      /** What is out, by title: still running (a stalled one is stuck instead), and asking this chat a question. */
      working: string[];
      asking: string[];
      /** "Delegated 3: 2 working, 1 failed": the count of the work it has out now. */
      rollup?: string;
      /** Its workers that are stuck, oldest first, read at `now`. */
      stuck: StuckWorker[];
      now: number;
      failed: string[];
      /** Chats whose workers the last Stop couldn't load: they may still be running. */
      unloaded: string[];
      onStopAll?: () => Promise<unknown>;
      /** Its briefs out to coding teams: one live line each, which opens that coding team on its Lead. */
      briefs: BriefedTeam[];
      onOpenBrief?: (brief: BriefedTeam) => void;
    };

/**
 * `orchestrator`: a chat Ash talks to (a Mono's own chat, or a coding-team chat: monos/model/orchestrators.ts), which
 * reads what it has out; anything else may be a worker, which runs on its own.
 */
export function useDelegationPane(
  sessionId: string,
  orchestrator: boolean,
): DelegationPane | undefined {
  const rows = useDelegationRows();
  useStuckDismissalsVersion();
  useCodingTeamVersion();
  const now = useClock();
  if (orchestrator) {
    const count = waitingOn(sessionId, rows);
    const stuck = stuckOwnedBy(sessionId, rows, now);
    const rollup = leadRollup(sessionId, rows, now);
    const failed = stopFailures(sessionId).map(
      (id) => delegationOf(id, rows)?.title?.trim() || "a worker",
    );
    const unloaded = stopUnloaded(sessionId).map((id) => {
      if (id === sessionId) return "this chat";
      const mono = monoForSession(id);
      return (
        delegationOf(id, rows)?.title?.trim() ||
        (mono ? monoLook(mono).name : "a worker")
      );
    });
    if (!count && !failed.length && !unloaded.length && !stuck.length)
      return undefined;
    const actions = delegationActions();
    // A brief to a coding team is its own line (briefedTeams.ts), not a name on the working line.
    const briefs = briefedTeams(sessionId, rows, now, briefTeamOf);
    return {
      kind: "lead",
      count,
      // A stalled worker is named as stuck, not working.
      ...workingOn(
        sessionId,
        rows.filter((row) => !(row.state === "running" && row.stallKind) && row.follow !== "lead"),
      ),
      briefs,
      onOpenBrief: (brief) => {
        if (brief.to) openCodingTeam(brief.to.projectId, { lead: true });
      },
      ...(rollup ? { rollup } : {}),
      stuck,
      now,
      failed,
      unloaded,
      ...(actions
        ? {
            onStopAll: () =>
              actions
                .stopTree(sessionId)
                .then((result) => noteStopFailures(sessionId, result)),
          }
        : {}),
    };
  }
  if (hasJumpedIn(sessionId)) return undefined;
  const row = delegationOf(sessionId, rows);
  const owner = row
    ? ((row.ownerMono ? findMono(row.ownerMono) : undefined) ??
      monoForSession(row.ownerSession))
    : startedByMono(sessionId, listMonos());
  // A coding-team chat's worker answers to that chat, which is named as its coding team.
  const teamChat = owner ? undefined : (row?.ownerSession ?? startedByCodingTeamChat(sessionId));
  const team = teamChat ? codingTeamChatProject(teamChat) : undefined;
  if (!owner && !team) return undefined;
  const ownerSession = row?.ownerSession ?? owner?.sessionId ?? teamChat;
  const actions = delegationActions();
  const stuck = row ? stuckOf(row, now) : undefined;
  return {
    kind: "worker",
    ownerName: owner ? monoLook(owner).name : codingTeamName(hubProjectNamed(team!)),
    ...(stuck ? { stuck } : {}),
    now,
    state:
      row?.state === "question"
        ? "asking"
        : row && isOpenDelegation(row)
          ? "running"
          : "finished",
    ...(actions && ownerSession
      ? { onOpenOwner: () => actions.openOwner(ownerSession) }
      : {}),
    onJumpIn: () => jumpIn(sessionId),
  };
}
