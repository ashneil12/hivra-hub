// What a chat's pane adds for the delegation tree (H4): a worker's chat runs on its own ("Runs on its own · Open
// <Lead>" in place of the composer, until Ash jumps in), and a Mono with work out reads "2 working: API, UI" with one
// Stop (leadFlow.ts), while it goes on talking with Ash, and a card for each worker that is stuck (asking, stalled or
// failed; workerStuck.ts), which the line names too ("1 stuck: Tests").
import {
  delegationActions,
  handBack,
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
  stuckForLeadComposer,
  stuckShownInLeadChat,
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
import { crewBriefLines } from "../../crew/model/briefLine";
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

/**
 * The coding team a chat reports for (teamReport.ts): its name when the chat is a project Lead's ("EXO coding team"),
 * "" for a Lead whose project isn't known, undefined for any other chat.
 */
export function reportTeamOf(sessionId: string): string | undefined {
  const mono = monoForSession(sessionId);
  const lead = mono ? leadFor(mono.id) : undefined;
  if (!lead) return undefined;
  const project = hubProjectNamed(lead.projectId);
  return project ? codingTeamName(project) : "";
}

export type DelegationPane =
  // MOCK-UP BRANCH: the owner took this worker's chat over; its first mate waits for it back.
  | { kind: "driving"; ownerName: string; onHandBack: () => void }
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
      /** WP-15: one compact line per brief, counted from derive_status. Opens the Crew tab. */
      crewLines: { id: string; text: string }[];
    };

/**
 * `orchestrator`: a chat Ash talks to (a Mono's own chat, or a coding-team chat: monos/model/orchestrators.ts), which
 * reads what it has out; anything else may be a worker, which runs on its own.
 */
export function useDelegationPane(
  sessionId: string,
  orchestrator: boolean,
  /** This chat is asking Ash a question itself right now (a Lead relaying a worker's question). */
  leadAsking = false,
): DelegationPane | undefined {
  const rows = useDelegationRows();
  useStuckDismissalsVersion();
  useCodingTeamVersion();
  const now = useClock();
  if (orchestrator) {
    const count = waitingOn(sessionId, rows);
    const stuck = stuckForLeadComposer(stuckShownInLeadChat(stuckOwnedBy(sessionId, rows, now), leadAsking), rows, now);
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
    // WP-15: a done or paused brief still gets its line, so this returns before the empty check.
    const crewLines = crewBriefLines(sessionId, rows);
    if (!count && !failed.length && !unloaded.length && !stuck.length && !crewLines.length)
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
      crewLines,
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
  if (hasJumpedIn(sessionId)) {
    const mine = delegationOf(sessionId, rows);
    const lead = mine?.ownerMono ? findMono(mine.ownerMono) : undefined;
    return lead ? { kind: "driving", ownerName: monoLook(lead).name, onHandBack: () => handBack(sessionId) } : undefined;
  }
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
