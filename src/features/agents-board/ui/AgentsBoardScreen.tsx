// Live Agents board. Counts, cost, time and checks come from the stores. A missing figure stays missing.

import { useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { pickChief } from "../../home/model/chief";
import { codingTeamChatProject, useCodingTeamVersion } from "../../hub/model/codingTeam";
import { hubData, useHubDataVersion } from "../../hub/model/hubData";
import { useProjectPrefsVersion } from "../../hub/model/projectPrefs";
import { isGlobalProject } from "../../hub/model/hubProjects";
import { leadMono, leadSpecFor } from "../../hub/model/hubLeads";
import { useDelegationRows } from "../../monos/model/delegationStore";
import type { Delegation } from "../../monos/model/delegations";
import { listMonos, monosSnapshot, subscribeMonos } from "../../monos/model/mono";
import { currentPrWatches, usePrWatchesVersion } from "../../pr-watch/model/prWatchBoard";
import type { Block, Session } from "../../sessions/model/session";
import { SessionStateContext } from "../../sessions/model/sessionStateStore";
import { openBoardRow } from "../model/boardOpen";
import { boardFromStores, mateStatus, type StoreCheck } from "../model/fromStores";
import { liveBoardSessions } from "../model/liveSessions";
import { agentsBoardSessionStopVersion, stopBoardRow, subscribeAgentsBoardSessionStop } from "../model/sessionStop";
import { flattenBoard } from "../model/tree";
import { taskWords, workerBrief } from "../model/words";
import { AgentsBoard } from "./AgentsBoard";

const emptySubscribe = () => () => undefined;
const noSessions = (): Session[] => [];
const NO_LINES: Record<string, readonly string[]> = {};
const lineCache = new WeakMap<readonly Block[], readonly string[]>();

export function AgentsBoardScreen() {
  const hubSnap = useHubDataVersion();
  const prefsVersion = useProjectPrefsVersion();
  const codingVersion = useCodingTeamVersion();
  const watchVersion = usePrWatchesVersion();
  const stopVersion = useSyncExternalStore(
    subscribeAgentsBoardSessionStop,
    agentsBoardSessionStopVersion,
    agentsBoardSessionStopVersion,
  );
  const delegations = useDelegationRows();
  const monos = useSyncExternalStore(subscribeMonos, monosSnapshot);
  const store = useContext(SessionStateContext);
  const sessions = useSyncExternalStore(store ? store.subscribeShell : emptySubscribe, store ? store.snapshot : noSessions);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const board = useMemo(() => {
    const listed = hubData().listProjects().filter((project) => !isGlobalProject(project.id));
    const projects = listed.map((project) => ({ id: project.id, name: project.name, folder: project.folder }));
    return boardFromStores({
      now,
      projects,
      sessions: liveBoardSessions({
        sessions,
        childSessionIds: delegations.map((row) => row.childSession),
        projectOfChat: codingTeamChatProject,
        homeSessionId: pickChief(listMonos())?.sessionId ?? null,
      }),
      mates: listed.map((project) => {
        const spec = leadSpecFor(project);
        const sessionId = leadMono(spec)?.sessionId ?? null;
        return {
          id: spec.id,
          name: spec.name,
          projectId: project.id,
          sessionId,
          department: "coding",
          status: mateStatus(sessionId, sessions),
        };
      }),
      delegations: delegations.map((row) => ({
        id: row.id,
        title: row.title,
        project: row.project,
        ownerMono: row.ownerMono,
        ownerSession: row.ownerSession,
        parentId: row.parentId,
        childSession: row.childSession,
        status: row.status,
        state: row.state,
        createdAt: row.createdAt,
        startedAt: row.createdAt,
        settledAt: row.settledAt,
        brief: workerBrief(row.brief, row.statusNotice),
      })),
      checks: checksFor(delegations),
      costs: sessions.map((session) => ({ id: session.id, blocks: session.blocks })),
    });
  }, [codingVersion, delegations, hubSnap, monos, now, prefsVersion, sessions, stopVersion, watchVersion]);

  return (
    <AgentsBoard
      tree={board.tree}
      projects={board.projects}
      now={now}
      lines={NO_LINES}
      readLines={(id) => transcriptFor(id, sessions, delegations)}
      onStop={(id) => stopBoardRow(id, { delegations, sessions })}
      onOpen={(id) => {
        const node = flattenBoard(board.tree).find((item) => item.id === id);
        if (!node) return;
        const owner = delegations.find((row) => row.id === id)?.ownerSession ?? null;
        openBoardRow(node, owner);
      }}
    />
  );
}

function checksFor(delegations: readonly Delegation[]): StoreCheck[] {
  const watches = currentPrWatches()?.all() ?? [];
  const out: StoreCheck[] = [];
  for (const watch of watches) {
    if (typeof watch.number !== "number" || watch.number <= 0) continue;
    const row =
      delegations.find((item) => item.childSession === watch.ownerSession) ??
      delegations.find((item) => item.ownerSession === watch.ownerSession);
    if (!row) continue;
    const failing = watch.status.failed.length;
    out.push({
      delegationId: row.id,
      prNumber: watch.number,
      failing,
      pending: watch.status.pending,
      passed: watch.status.passed === true && failing === 0,
    });
  }
  return out;
}

/** One row's chat. A worker row uses its child session. Nothing else is read. */
function transcriptFor(id: string, sessions: readonly Session[], delegations: readonly Delegation[]): readonly string[] {
  const child = delegations.find((row) => row.id === id)?.childSession;
  const sessionId = child?.trim() ? child : id;
  const session = sessions.find((item) => item.id === sessionId);
  return session ? textLines(session.blocks) : [];
}

function textLines(blocks: readonly Block[] | undefined): readonly string[] {
  if (!blocks?.length) return [];
  const cached = lineCache.get(blocks);
  if (cached) return cached;
  const lines: string[] = [];
  for (const block of blocks) {
    const text = taskWords(block.text);
    if (text) lines.push(text);
  }
  const shown = lines.slice(-12);
  lineCache.set(blocks, shown);
  return shown;
}
