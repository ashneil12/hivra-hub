import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  bindHarnessSession,
  cancelHarnessTurn,
  forgetHarnessSession,
  isLiveHarness,
} from "../../integrations/harness/core/registry";
import {
  killAllChildren,
  killChild,
  listHarnessRuns,
  type HarnessProcessRun,
} from "../../integrations/harness/core/child";
import {
  hasInFlightSessions,
  inFlightRefs,
  isRunningWork,
  markTurnInterrupted,
  quitWhileBusyMessage,
  wasTurnInterrupted,
  withInFlightState,
  workspaceFromResumed,
  type ResumedWorkspace,
} from "../../features/sessions/model/inFlight";
import { leafIds, type WorkspaceTab } from "../../features/workspace/model/layout";
import { killPty } from "../../platform/tauri/pty";
import {
  projectTerminalFileIds,
  type DockSide,
  type ProjectTerminalDock,
} from "../../features/projects/model/projectTerminal";
import { openMoreAgentSession } from "../../integrations/harness/moreAgents/moreAgentAdapter";
import { sessionWorkCwd, type Session } from "../../features/sessions/model/session";
import { sessionChildHarnesses } from "../../features/sessions/model/handoff";
import {
  getSession,
  listInFlightSessions,
  listSessionsByProject,
  loadWorkspaceSnapshot,
  replaceInFlightSessions,
  saveWorkspaceSnapshot,
  shouldPersistSession,
  upsertSession,
  type SessionSummary,
} from "../../features/sessions/data/sessionStore";
import {
  collectWorkspaceSnapshot,
  hydrateWorkspaceSnapshot,
  parseWorkspaceSnapshot,
} from "../../features/workspace/model/workspaceSnapshot";
import { loadWindowTransfer } from "./windowTransferBootstrap";
import type { WindowTransferPayload } from "./windowTransfer";
import { lastProjectPath, normalizeProjectPath, sameProjectPath } from "../../features/projects/model/recents";
import type { ProjectReturnMemory } from "../../features/projects/model/projectReturn";

export type { ResumedWorkspace };
export { hasInFlightSessions };

export type BootWorkspace = {
  windowTransfer: WindowTransferPayload | null;
  resumed: ResumedWorkspace | null;
  /** Sidebar rows listed before first paint, so the rail is not empty. */
  history: SessionSummary[];
  historyCwd: string | null;
};

let resumedPromise: Promise<ResumedWorkspace | null> | null = null;
let bootPromise: Promise<BootWorkspace> | null = null;
let quitting = false;
let quitDialogOpen = false;
let bootingResumed: ResumedWorkspace | null = null;
let liveWorkspace: {
  sessions: () => Session[];
  tabs: () => WorkspaceTab[];
  activeTabId: () => string;
  projectCwd: () => string;
  projectTerminals: () => ProjectTerminalDock[];
  projectReturnMemory: () => ProjectReturnMemory;
  lastDockSide: () => DockSide | null;
  keepTab?: (tab: WorkspaceTab) => boolean;
  flush: () => void;
} | null = null;

export function isAppQuitting(): boolean {
  return quitting;
}

export function setQuitWorkspace(
  sessions: () => Session[],
  tabs: () => WorkspaceTab[],
  activeTabId: () => string,
  projectCwd: () => string,
  projectTerminals: () => ProjectTerminalDock[],
  projectReturnMemory: () => ProjectReturnMemory,
  flush: () => void,
  lastDockSide: () => DockSide | null = () => null,
  keepTab?: (tab: WorkspaceTab) => boolean,
): () => void {
  liveWorkspace = {
    sessions,
    tabs,
    activeTabId,
    projectCwd,
    projectTerminals,
    projectReturnMemory,
    lastDockSide,
    keepTab,
    flush,
  };
  bootingResumed = null;
  return () => {
    if (liveWorkspace?.sessions === sessions) liveWorkspace = null;
  };
}

/**
 * A quit ends a compact the app is running for an idle chat (WP-115). It is not a
 * turn, so Quit did not ask about it, but the CLI should be told to stop rather
 * than be cut mid-write, and the watcher then lets go of the chat and its claim.
 * Bounded: a CLI that does not answer never holds the quit up.
 */
async function cancelIdleCompactions(sessions: Session[]): Promise<void> {
  const held = sessions.filter((session) => session.idleCompacting);
  if (held.length === 0) return;
  await Promise.race([
    Promise.all(held.map((session) => cancelHarnessTurn(session.harness, session.id).catch(() => undefined))),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
}

/**
 * Persist this window for a quit the coordinator has already confirmed.
 * Exiting is `confirm_quit`'s job, once every window has reported ready.
 * `shipUpdate` names the ship when the quit is for an update: cut turns are
 * marked with it, so they resume with its receipt.
 */
export async function handleQuitRequested(shipUpdate?: string): Promise<boolean> {
  if (liveWorkspace) {
    liveWorkspace.flush();
    quitting = true;
    try {
      await cancelIdleCompactions(liveWorkspace.sessions());
      await persistQuitState(
        liveWorkspace.sessions(),
        liveWorkspace.tabs(),
        liveWorkspace.activeTabId(),
        liveWorkspace.projectCwd(),
        liveWorkspace.projectReturnMemory(),
        "quit",
        liveWorkspace.projectTerminals(),
        liveWorkspace.lastDockSide() ?? undefined,
        liveWorkspace.keepTab,
        shipUpdate,
      );
      return true;
    } catch {
      quitting = false;
      return false;
    }
  }
  const { resumed } = await loadBootWorkspace();
  const pending = resumed ?? bootingResumed;
  quitting = true;
  if (!pending) return true;
  try {
    await persistBootingResume(pending);
    return true;
  } catch {
    quitting = false;
    return false;
  }
}

/**
 * Each window counts its own live turns; Rust sums them into one decision.
 * A quit for update leaves out `exempt`, the session that asked for the ship:
 * its own turn is expected to be cut, and resumes with the receipt.
 */
export async function reportQuitPoll(
  id: number,
  exempt?: string | null,
): Promise<void> {
  let inFlight = 0;
  if (liveWorkspace) {
    liveWorkspace.flush();
    // Every running turn, not just the resumable ones `inFlightRefs` keeps:
    // an Inbox Ask still counts as work nobody agreed to throw away. r99 (Ash): a
    // chat only waiting on his answer isn't running; its ask is kept and asked again.
    inFlight = liveWorkspace
      .sessions()
      .filter((session) => isRunningWork(session) && session.id !== exempt).length;
  }
  await invoke("quit_poll_reply", { id, inFlight }).catch(() => undefined);
}

/**
 * r99 (Ash: "the bench must never trigger the app's 'chats still running' Mac dialog on Ash's screen again"): a quit the
 * verify driver asked for. If real work started running between its check and the quit, the quit is called off without
 * a dialog, and the bench reports it. Disarmed after one quit decision or a minute.
 */
let benchQuitUntil = 0;
export function armBenchQuit(now = Date.now()): void {
  benchQuitUntil = now + 60_000;
}

/** The one quit dialog, shown by whichever window the coordinator picked. */
export async function askQuitConfirmation(
  id: number,
  inFlight: number,
): Promise<void> {
  let confirmed = false;
  if (benchQuitUntil > Date.now()) {
    benchQuitUntil = 0;
    console.warn(`verify driver quit called off: ${inFlight} chat(s) started running; no dialog`);
    await invoke("quit_decision", { id, confirmed: false }).catch(() => undefined);
    return;
  }
  if (!quitDialogOpen) {
    quitDialogOpen = true;
    try {
      confirmed = await ask(quitWhileBusyMessage(inFlight), {
        title: "MonoCode",
        kind: "warning",
        okLabel: "Quit",
      });
    } catch {
      confirmed = false;
    } finally {
      quitDialogOpen = false;
    }
  }
  await invoke("quit_decision", { id, confirmed }).catch(() => undefined);
}

export async function commitQuit(
  id: number,
  shipUpdate?: string | null,
): Promise<void> {
  const persisted = await handleQuitRequested(shipUpdate ?? undefined);
  await invoke("quit_ready", { id, persisted }).catch(() => undefined);
}

/**
 * A quit that stopped part-way because another window could not save. This
 * window is staying open, so it must go back to persisting on unload.
 */
export function abortQuit(): void {
  quitting = false;
}

/** Confirm and stop this window's work without terminating other windows. */
export async function closeBusyWindow(): Promise<void> {
  if (!liveWorkspace) return;
  liveWorkspace.flush();
  await confirmAndCloseWindow(
    liveWorkspace.sessions(),
    liveWorkspace.tabs(),
    liveWorkspace.activeTabId(),
    liveWorkspace.projectCwd(),
    liveWorkspace.projectReturnMemory(),
    liveWorkspace.projectTerminals(),
    liveWorkspace.lastDockSide() ?? undefined,
  );
}

export function loadResumedWorkspace(): Promise<ResumedWorkspace | null> {
  if (!resumedPromise) resumedPromise = loadResumedWorkspaceOnce();
  return resumedPromise;
}

/** Transfer and restore run once; callers share the same promise. */
export function loadBootWorkspace(): Promise<BootWorkspace> {
  if (!bootPromise) {
    bootPromise = (async () => {
      const hintedCwd = lastProjectPath();
      const historyHint = listProjectHistory(hintedCwd);
      const windowTransfer = await loadWindowTransfer();
      if (windowTransfer) {
        const listed = await historyForCwd(
          windowTransfer.projectCwd,
          hintedCwd,
          historyHint,
        );
        return {
          windowTransfer,
          resumed: null,
          history: listed?.rows ?? [],
          historyCwd: listed?.cwd ?? null,
        };
      }
      const [resumed, hinted] = await Promise.all([
        loadResumedWorkspace(),
        historyHint,
      ]);
      const listed = await historyForCwd(
        resumed?.projectCwd ?? hintedCwd,
        hintedCwd,
        Promise.resolve(hinted),
      );
      return {
        windowTransfer: null,
        resumed,
        history: listed?.rows ?? [],
        historyCwd: listed?.cwd ?? null,
      };
    })();
  }
  return bootPromise;
}

async function listProjectHistory(
  cwd: string | null | undefined,
): Promise<{ cwd: string; rows: SessionSummary[] } | null> {
  if (!cwd || cwd === "~") return null;
  try {
    const rows = await listSessionsByProject(cwd);
    return { cwd: normalizeProjectPath(cwd), rows };
  } catch {
    return null;
  }
}

async function historyForCwd(
  cwd: string | null | undefined,
  hintedCwd: string | null | undefined,
  hinted: Promise<{ cwd: string; rows: SessionSummary[] } | null>,
): Promise<{ cwd: string; rows: SessionSummary[] } | null> {
  if (!cwd || cwd === "~") return null;
  if (hintedCwd && sameProjectPath(cwd, hintedCwd)) return hinted;
  return listProjectHistory(cwd);
}

export type LeftoverTurnDeps = {
  list(since: number): Promise<HarnessProcessRun[]>;
  kill(sessionId: string): Promise<void>;
  sleep(ms: number): Promise<void>;
};

const leftoverDeps: LeftoverTurnDeps = {
  // Called through, so a host without the command (or a test's stand-in) is just no leftover.
  list: async (since) => listHarnessRuns(since),
  kill: async (sessionId) => killChild(sessionId),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * A reload cuts the turns that were running: the page that went away marks them "Turn interrupted when MonoCode Hub
 * reloaded" and asks the app to stop their processes, but that last ask is sent while the page is being torn down and
 * can be lost. On the Mac (round 2, 21 Oct) the chat's Claude process ran on after the note said it had stopped, and
 * the soul tamper check took its run as over. So a page that boots with cut turns first ends any process of theirs
 * the app process still has alive, and waits (a few seconds at most) until it has exited: a turn is only shown as
 * interrupted once its process is gone, and the resume that follows starts clean. The app process's record keeps
 * when that process really ran (sessionRuns.ts). Returns the chats whose process was still alive.
 */
export async function endLeftoverTurns(
  sessionIds: ReadonlySet<string>,
  deps: LeftoverTurnDeps = leftoverDeps,
  waitMs = 3_000,
): Promise<string[]> {
  if (!sessionIds.size) return [];
  const alive = async () => {
    const runs = await deps.list(Date.now() - 60_000).catch(() => [] as HarnessProcessRun[]);
    return [...new Set(runs.filter((r) => r.end == null && sessionIds.has(r.sessionId)).map((r) => r.sessionId))];
  };
  const leftover = await alive();
  if (!leftover.length) return [];
  await Promise.all(leftover.map((id) => deps.kill(id).catch(() => undefined)));
  for (let waited = 0; waited < waitMs; waited += 100) {
    if (!(await alive()).length) break;
    await deps.sleep(100);
  }
  return leftover;
}

async function loadResumedWorkspaceOnce(): Promise<ResumedWorkspace | null> {
  const [snapshotRaw, refs] = await Promise.all([
    loadWorkspaceSnapshot().catch(() => null),
    listInFlightSessions().catch(() => []),
  ]);
  const interrupted = new Set(refs.map((ref) => ref.sessionId));
  await endLeftoverTurns(interrupted);
  const refById = new Map(refs.map((ref) => [ref.sessionId, ref]));
  const snapshot = parseWorkspaceSnapshot(snapshotRaw);

  const ids = new Set<string>();
  if (snapshot) {
    for (const stub of snapshot.sessions) ids.add(stub.id);
    for (const tab of snapshot.tabs) {
      for (const id of leafIds(tab.layout)) ids.add(id);
    }
  }
  for (const ref of refs) ids.add(ref.sessionId);

  const loaded = new Map<string, Session>();
  await Promise.all(
    [...ids].map(async (id) => {
      const record = await getSession(id).catch(() => null);
      if (record) loaded.set(id, record);
    }),
  );

  let workspace = snapshot
    ? hydrateWorkspaceSnapshot(snapshot, loaded, interrupted)
    : null;
  if (!workspace && refs.length > 0) {
    const sessions: Session[] = [];
    for (const ref of refs) {
      const record = loaded.get(ref.sessionId);
      if (!record) continue;
      sessions.push(markTurnInterrupted(record));
    }
    workspace = workspaceFromResumed(sessions);
  }
  // What each cut turn had running in the background, and how often it has resumed itself, ride on its row.
  if (workspace && refById.size > 0) {
    workspace = {
      ...workspace,
      sessions: workspace.sessions.map((session) =>
        withInFlightState(session, refById.get(session.id)),
      ),
    };
  }

  bootingResumed = workspace;
  if (workspace) {
    await Promise.all(
      workspace.sessions
        // Idle transcripts already came from disk. Rewriting every open chat
        // here serialized/indexed the entire workspace before first paint.
        .filter(
          (session) => interrupted.has(session.id) && shouldPersistSession(session),
        )
        .map((session) => upsertSession(session).catch(() => null)),
    );
  }
  return workspace;
}

export function bindResumedSessions(sessions: Session[]): void {
  for (const session of sessions) {
    // WP-134b: a More agents chat is routed to its entry before its saved ACP session is bound, so the bind never
    // reaches the harness it was saved with (the route effect in App runs later).
    if (session.registryAgentId && !session.worktreeRemoved) {
      openMoreAgentSession(session.id, session.registryAgentId);
    }
    if (
      session.worktreeRemoved ||
      !session.providerSessionId ||
      !isLiveHarness(session.harness)
    )
      continue;
    bindHarnessSession(
      session.harness,
      session.id,
      session.providerSessionId,
      sessionWorkCwd(session),
      session.providerAccountId,
      session.blocks,
      session.goal,
    );
  }
}

export async function hideCurrentWindow(): Promise<void> {
  await invoke("hide_window");
}

export async function closeCurrentWindow(): Promise<void> {
  await invoke("destroy_window");
}

export async function confirmReload(
  hasUnsavedFiles: boolean,
): Promise<boolean> {
  if (!hasUnsavedFiles) return true;
  return ask("Reload MonoCode and discard unsaved changes?", {
    title: "MonoCode",
    kind: "warning",
    okLabel: "Reload",
  });
}

export async function persistLiveTranscripts(
  sessions: Session[],
): Promise<void> {
  await Promise.all(
    sessions
      .filter(shouldPersistSession)
      .map((session) => upsertSession(session).catch(() => null)),
  );
}

export async function persistQuitState(
  sessions: Session[],
  tabs: WorkspaceTab[],
  activeTabId: string,
  projectCwd: string,
  memory: ProjectReturnMemory,
  mode: "quit" | "unload" = "quit",
  projectTerminals: ProjectTerminalDock[] = [],
  lastDockSide?: DockSide,
  keepTab?: (tab: WorkspaceTab) => boolean,
  shipUpdate?: string,
): Promise<void> {
  const refs = inFlightRefs(sessions, tabs);
  const interrupted = new Set(refs.map((ref) => ref.sessionId));
  // A quit ends the process, so a swallowed write is work that never comes
  // back: let it reject and let the caller call the quit off. An unload is a
  // reload, where best effort is enough and failing loudly helps nobody.
  const write = <T,>(pending: Promise<T>): Promise<T | null> =>
    mode === "quit" ? pending : pending.catch(() => null);

  await Promise.all(
    sessions.map(async (session) => {
      if (!shouldPersistSession(session)) return;
      const payload = interrupted.has(session.id)
        ? markTurnInterrupted(
            session,
            shipUpdate,
            // An unload is a reload of the window: the app keeps running and resumes the turn the same way.
            mode === "unload" ? "reload" : undefined,
          )
        : session;
      await write(upsertSession(payload));
    }),
  );
  await write(
    saveWorkspaceSnapshot(
      collectWorkspaceSnapshot(
        tabs,
        sessions,
        activeTabId,
        projectCwd,
        memory,
        projectTerminals,
        lastDockSide,
        keepTab,
      ),
    ),
  );
  // Vite/webview reload must not wipe a restored snapshot: those chats are idle
  // in this process until Continue runs.
  if (mode === "quit" || refs.length > 0) {
    await write(replaceInFlightSessions(refs));
  }
}

async function persistBootingResume(workspace: ResumedWorkspace): Promise<void> {
  await Promise.all(
    workspace.sessions
      .filter(shouldPersistSession)
      .map((session) => upsertSession(session).catch(() => null)),
  );
  await saveWorkspaceSnapshot(
    collectWorkspaceSnapshot(
      workspace.tabs,
      workspace.sessions,
      workspace.activeTabId,
      workspace.projectCwd,
      workspace.projectReturnMemory ?? new Map(),
      workspace.projectTerminals ?? [],
      workspace.lastDockSide,
    ),
  ).catch(() => undefined);
  await replaceInFlightSessions(
    workspace.sessions
      .filter(wasTurnInterrupted)
      .map((session) => ({
        sessionId: session.id,
        cwd: session.cwd,
        ...(session.cutWork?.length ? { background: session.cutWork } : {}),
        ...(session.autoResumes ? { resumes: session.autoResumes } : {}),
      })),
  ).catch(() => undefined);
}

async function confirmAndCloseWindow(
  sessions: Session[],
  tabs: WorkspaceTab[],
  activeTabId: string,
  projectCwd: string,
  memory: ProjectReturnMemory,
  projectTerminals: ProjectTerminalDock[] = [],
  lastDockSide?: DockSide,
): Promise<void> {
  if (quitDialogOpen) return;
  quitDialogOpen = true;
  try {
    const refs = inFlightRefs(sessions, tabs);
    if (refs.length > 0) {
      const ok = await ask(
        "Close this window and stop its running chats? Other windows will stay open.",
        { title: "MonoCode", kind: "warning", okLabel: "Close window" },
      );
      if (!ok) return;
    }
    quitting = true;
    try {
      await persistQuitState(
        sessions,
        tabs,
        activeTabId,
        projectCwd,
        memory,
        "quit",
        projectTerminals,
        lastDockSide,
      );
      await reapWindowRuntime(sessions, tabs, projectTerminals, false);
      await closeCurrentWindow();
    } catch {
      quitting = false;
    }
  } finally {
    quitDialogOpen = false;
  }
}

export async function reapWindowRuntime(
  sessions: Session[],
  tabs: WorkspaceTab[],
  projectTerminals: ProjectTerminalDock[] = [],
  includeAllChildren = true,
): Promise<void> {
  await Promise.all(
    sessions.map((session) =>
      Promise.all(
        sessionChildHarnesses(session).map((harness) =>
          forgetHarnessSession(harness, session.id),
        ),
      ),
    ),
  );
  await Promise.all(
    [...terminalFileIds(tabs), ...projectTerminalFileIds(projectTerminals)].map(
      (id) => killPty(id),
    ),
  );
  // Catalog probes, title generators, and usage scrapers are not session
  // children. Drop them so an unused Pi/Codex probe cannot outlive the window.
  if (includeAllChildren) await killAllChildren().catch(() => undefined);
}

function terminalFileIds(tabs: WorkspaceTab[]): string[] {
  const ids: string[] = [];
  for (const tab of tabs) {
    for (const pane of [...tab.editorPanes, ...(tab.terminalPanes ?? [])]) {
      for (const file of pane.files) {
        if (file.terminal) ids.push(file.id);
      }
    }
  }
  return ids;
}
