// Live Agents board. Counts, cost, time and checks come from the stores. A missing figure stays missing.

import { useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { pickChief } from "../../home/model/chief";
import { codingTeamChatProject, useCodingTeamVersion } from "../../hub/model/codingTeam";
import { hubData, useHubDataVersion } from "../../hub/model/hubData";
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
import { stopBoardRow } from "../model/sessionStop";
import { flattenBoard } from "../model/tree";
import { taskWords } from "../model/words";
import { AgentsBoard } from "./AgentsBoard";

const emptySubscribe = () => () => undefined;
const noSessions = (): Session[] => [];

export function AgentsBoardScreen() {
  useHubDataVersion();
  useCodingTeamVersion();
  usePrWatchesVersion();
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
        brief: row.brief ?? row.statusNotice,
      })),
      checks: checksFor(delegations),
      costs: sessions.map((session) => ({ id: session.id, blocks: session.blocks })),
    });
  }, [delegations, monos, now, sessions]);

  const lines = useMemo(() => transcriptLines(sessions, delegations), [sessions, delegations]);

  return (
    <AgentsBoard
      tree={board.tree}
      projects={board.projects}
      now={now}
      lines={lines}
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

function transcriptLines(sessions: readonly Session[], delegations: readonly Delegation[]): Record<string, string[]> {
  const bySession = new Map(sessions.map((session) => [session.id, session]));
  const out: Record<string, string[]> = {};
  for (const session of sessions) {
    const lines = textLines(session.blocks);
    if (lines.length) out[session.id] = lines;
  }
  for (const row of delegations) {
    const session = row.childSession ? bySession.get(row.childSession) : undefined;
    const lines = session ? textLines(session.blocks) : [];
    if (lines.length) out[row.id] = lines;
  }
  return out;
}

function textLines(blocks: readonly Block[]): string[] {
  const lines: string[] = [];
  for (const block of blocks) {
    const text = taskWords(block.text);
    if (text) lines.push(text);
  }
  return lines.slice(-12);
}
