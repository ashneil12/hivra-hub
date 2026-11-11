import type {
  Block,
  HarnessId,
  SessionGoal,
  TaskListMeta,
  TurnIntent,
} from "../../../features/sessions/model/session";
import { admitSpendTurn, noteUnpricedTurn, spendGateActive, type TurnOrigin } from "../../../features/usage/model/spendGate";
import { requireChatFolder } from "./chatFolder";
import { credentialBlock } from "./credentialGuard";
import { goalToolRefusal, goalTurnRefusal } from "../../../features/sessions/model/goalIntegrity";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { transferProviderSession } from "./child";
import type { GeneratedSessionTitle } from "../../../features/sessions/model/sessionTitle";
import type { PrContent } from "../../../features/source-control/model/gitText";
import { hasLiveCatalog } from "../../../features/sessions/model/models";
import type { UserQuestionReply } from "../../../features/sessions/model/userQuestion";
import type { NativeCommandProvider } from "./nativeCommands";
import { assertChatAcceptsTurns } from "../../../features/connections/model/teleportLock";
import { registryAgentIdForSession, unlinkRegistryChat } from "../../../features/registry/model/registryList";
import {
  clearWorkflowRuns,
  noteWorkflowRun,
} from "../../../features/sessions/model/workflowActivity";
import type {
  ApprovalDecision,
  CompactContextInput,
  HarnessEvent,
  LiveSettingsInput,
  LiveSettingsOutcome,
  RewindLastTurnInput,
  RewindLastTurnResult,
  SendTurnInput,
  SteerTurnInput,
} from "./types";

export type TitleInput = {
  sessionId: string;
  cwd: string;
  message: string;
  providerAccountId?: string;
};

/** One-shot, isolated text generation shared by titles and side questions. */
export type TextPromptInput = {
  cwd: string;
  providerAccountId?: string;
  model?: string;
  modelSettings?: Record<string, string>;
  /** Codex defaults to unsaved threads; false allows resumable side questions. */
  ephemeral?: boolean;
  codexStore?: "mono";
  threadId?: string;
  onThreadId?: (threadId: string) => void;
  intent?: TurnIntent;
  prompt: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: HarnessEvent) => void;
};

/**
 * Lifecycle contract for a live harness adapter.
 * App.tsx dispatches through the registry instead of harness-specific branches.
 */
export type HarnessAdapter = {
  id: HarnessId;
  /** True when this adapter can run live turns. */
  live: boolean;
  /** False when the harness cannot accept a follow-up while a turn is running. Default: same as live. */
  canSteer?: boolean;
  commands?: NativeCommandProvider;
  sendTurn(input: SendTurnInput): Promise<void>;
  /** Trigger provider-owned compaction outside MonoCode's normal user-turn path. */
  compactContext?(input: CompactContextInput): Promise<void>;
  /** Stop one background task (a whole workflow run) and leave the turn going. */
  stopTask?(sessionId: string, taskId: string): Promise<boolean>;
  /** Apply model, effort or permission changes to the running session now. */
  applySettings?(input: LiveSettingsInput): Promise<LiveSettingsOutcome>;
  /** Rewind provider state so the last user turn can be replaced. */
  rewindLastTurn?(input: RewindLastTurnInput): Promise<RewindLastTurnResult>;
  steerTurn(input: SteerTurnInput): Promise<void>;
  cancelTurn(sessionId: string): Promise<void>;
  /** Returns true only when a live call took the decision. Adapters that cannot confirm return nothing. */
  respondApproval(
    sessionId: string,
    requestId: number,
    decision: ApprovalDecision,
  ): boolean | void;
  respondQuestion?(
    sessionId: string,
    requestId: number,
    reply: UserQuestionReply,
  ): void;
  /** Keep a timed question open once the user starts answering it. */
  keepQuestionOpen?(sessionId: string, requestId: number): void;
  /** Kill the child but keep resume state for later rebind. */
  stopSession(sessionId: string): Promise<void>;
  /**
   * True while the chat's CLI still runs work the idle park must not stop: a backgrounded shell or monitor, a subagent
   * or a follow-up turn on its way. A throw counts as busy. Absent means the provider has no such work to protect.
   */
  hasBackgroundWork?(sessionId: string): boolean;
  /** Drop resume state and kill the child (delete, harness switch, idle detach). */
  forgetSession(sessionId: string): Promise<void>;
  /**
   * The chat was deleted for good: drop what forgetSession keeps on purpose
   * for a chat that goes on in a fresh conversation (a rotation).
   */
  dropSession?(sessionId: string): void;
  /** Seed resume state from a restored MonoCode session. */
  bindSession(
    threadId: string,
    providerSessionId: string,
    cwd: string,
    providerAccountId?: string,
  ): void;
  /** Seed provider task state from a restored session's persisted panels. */
  restoreTaskLists?(threadId: string, lists: TaskListMeta[]): void;
  /** Carry on with a restored session's saved goal (Claude Code's /goal). */
  restoreGoal?(threadId: string, goal: SessionGoal): void;
  /** Round 12: a restored transcript already left the launch folder, so relative paths wait again. */
  restoreMovedFolder?(threadId: string, blocks: Block[]): void;
  /** Refresh the model catalog overlay when supported. */
  refreshCatalog?(): Promise<void>;
  /** Optional LLM tab title for the first turn. */
  generateTitle?(input: TitleInput): Promise<GeneratedSessionTitle | null>;
  /** Optional LLM commit message from staged changes. */
  generateCommitMessage?(
    cwd: string,
    signal?: AbortSignal,
    paths?: readonly string[],
  ): Promise<string>;
  /** Optional LLM pull request title/body from branch diff context. */
  generatePrContent?(
    cwd: string,
  ): Promise<(PrContent & { base: string; head: string }) | null>;
  /** Optional LLM branch name from a user message. */
  generateBranchName?(cwd: string, message: string): Promise<string | null>;
  /** Optional warmup for text-generation backends. */
  warmupText?(cwd: string): Promise<void>;
  /** Run an isolated, read-only prompt without mutating the main session. */
  runTextPrompt?(input: TextPromptInput): Promise<string>;
  /** Stop an isolated text-generation backend. */
  stopTextPrompt?(): Promise<void>;
};

const adapters = new Map<HarnessId, HarnessAdapter>();

/**
 * After a turn settles, keep the child warm for follow-ups, then park it.
 * Resume state stays, so the next prompt respawns instead of starting over.
 */
export const HARNESS_IDLE_PARK_MS = 3 * 60_000;

/**
 * While the CLI still runs background work, the park looks again this often. Once the work ends, the chat gets a full
 * idle time before it is parked, so the agent can still be woken by the notification that work sends.
 */
const BACKGROUND_RECHECK_MS = 30_000;

/**
 * Hard ceiling on one background hold: once a provider has reported background work for this long, the chat is
 * parked anyway and a status line says so. A provider whose work never reports its end must not keep a CLI alive.
 */
export const BACKGROUND_HOLD_CEILING_MS = 60 * 60_000;

/**
 * Claude reports the end of its own backgrounded shells and subagents, and a long build or test run it started is real
 * work, so its hold has no ceiling (as before WP-174b). The ceiling guards the other adapters, whose end signals are new.
 */
const NO_HOLD_CEILING = new Set<HarnessId>(["claude"]);

/**
 * Each warm child is a CLI process of a few hundred MB, plus its MCP servers.
 * Past `limit` idle ones, the least recently settled is parked early, never
 * one `keep` claims (the conversation on screen) unless the limit is zero.
 * Running turns are not idle, so they never count.
 */
export type HarnessIdleParkPolicy = {
  limit: () => number;
  keep: (sessionId: string) => boolean;
};

let idleParkPolicy: HarnessIdleParkPolicy = {
  limit: () => Number.POSITIVE_INFINITY,
  keep: () => false,
};
let idleLimitCheck: ReturnType<typeof setTimeout> | undefined;

/** Map order is settle order: the first entry has been idle longest. */
const idleParkTimers = new Map<
  string,
  {
    harness: HarnessId;
    timer: ReturnType<typeof setTimeout>;
    /** The last check found background work, so the idle time starts again once it ends. */
    wasBusy: boolean;
    /** When the current background hold began: the first check that found work in this run of busy checks. */
    holdSince?: number;
  }
>();
/** Where a status line for a parked chat goes: the sink of its last turn, kept until the chat is stopped. */
const idleParkEvents = new Map<string, (event: HarnessEvent) => void>();
const sessionOperationTails = new Map<string, Promise<void>>();
const sessionSteerTails = new Map<string, Promise<void>>();
const activeTurnSessions = new Set<string>();

function queueSessionOperation<T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = sessionOperationTails.get(sessionId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  sessionOperationTails.set(sessionId, settled);
  void settled.then(() => {
    if (sessionOperationTails.get(sessionId) === settled) {
      sessionOperationTails.delete(sessionId);
    }
  });
  return current;
}

function queueSteerOperation<T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previousSteer = sessionSteerTails.get(sessionId) ?? Promise.resolve();
  // A live turn must remain steerable while its long-running send is pending.
  // Other provider-state operations still form a barrier for the steer.
  const barrier = activeTurnSessions.has(sessionId)
    ? Promise.resolve()
    : (sessionOperationTails.get(sessionId) ?? Promise.resolve());
  const current = Promise.all([
    previousSteer.catch(() => undefined),
    barrier.catch(() => undefined),
  ]).then(operation);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  sessionSteerTails.set(sessionId, settled);
  void settled.then(() => {
    if (sessionSteerTails.get(sessionId) === settled) {
      sessionSteerTails.delete(sessionId);
    }
  });
  return current;
}

function cancelIdlePark(sessionId: string): void {
  const idle = idleParkTimers.get(sessionId);
  if (idle) clearTimeout(idle.timer);
  idleParkTimers.delete(sessionId);
}

/** Whether the provider still runs work for this chat. A provider that throws is treated as busy: keep it warm. */
function hasBackgroundWork(harness: HarnessId, sessionId: string): boolean {
  const adapter = adapterFor(harness, sessionId);
  if (!adapter?.hasBackgroundWork) return false;
  try {
    return adapter.hasBackgroundWork(sessionId) === true;
  } catch {
    return true;
  }
}

function armIdlePark(
  harness: HarnessId,
  sessionId: string,
  delay: number,
  wasBusy: boolean,
  holdSince?: number,
): void {
  cancelIdlePark(sessionId);
  idleParkTimers.set(sessionId, {
    harness,
    wasBusy,
    holdSince,
    timer: setTimeout(() => {
      idleParkTimers.delete(sessionId);
      parkWhenQuiet(harness, sessionId, wasBusy, holdSince);
    }, delay),
  });
}

function parkWhenQuiet(
  harness: HarnessId,
  sessionId: string,
  wasBusy: boolean,
  holdSince?: number,
): void {
  if (hasBackgroundWork(harness, sessionId)) {
    const since = holdSince ?? Date.now();
    if (NO_HOLD_CEILING.has(harness) || Date.now() - since < BACKGROUND_HOLD_CEILING_MS) {
      armIdlePark(harness, sessionId, BACKGROUND_RECHECK_MS, true, since);
      return;
    }
    // The provider has reported work for the whole ceiling. Park it anyway, and say why in the chat.
    idleParkEvents.get(sessionId)?.({
      type: "status",
      text: "The provider still reported background work after 60 minutes, so the chat was parked. Send a message to continue.",
      key: "background-hold-ceiling",
    });
    void stopHarnessSession(harness, sessionId);
    return;
  }
  if (wasBusy) {
    armIdlePark(harness, sessionId, HARNESS_IDLE_PARK_MS, false);
    return;
  }
  void stopHarnessSession(harness, sessionId);
}

function scheduleIdlePark(harness: HarnessId, sessionId: string): void {
  armIdlePark(harness, sessionId, HARNESS_IDLE_PARK_MS, false);
  // Checked once the settling operation has left the queue, so a session
  // with a follow-up already queued is told apart from the one finishing.
  if (idleLimitCheck === undefined) {
    idleLimitCheck = setTimeout(enforceHarnessIdleLimit, 0);
  }
}

export function configureHarnessIdlePark(policy: HarnessIdleParkPolicy) {
  idleParkPolicy = policy;
}

/** Park the longest-idle children past the limit; also run when it drops. */
export function enforceHarnessIdleLimit(): void {
  clearTimeout(idleLimitCheck);
  idleLimitCheck = undefined;
  const limit = Math.max(0, idleParkPolicy.limit());
  let excess = idleParkTimers.size - limit;
  for (const [sessionId, { harness }] of [...idleParkTimers]) {
    if (excess <= 0) return;
    if (sessionOperationTails.has(sessionId)) continue;
    if (hasBackgroundWork(harness, sessionId)) continue;
    if (limit > 0 && idleParkPolicy.keep(sessionId)) continue;
    excess -= 1;
    void stopHarnessSession(harness, sessionId);
  }
}

/** Test seam. */
export function resetHarnessIdlePark(): void {
  for (const { timer } of idleParkTimers.values()) clearTimeout(timer);
  idleParkTimers.clear();
  idleParkEvents.clear();
  clearTimeout(idleLimitCheck);
  idleLimitCheck = undefined;
  idleParkPolicy = {
    limit: () => Number.POSITIVE_INFINITY,
    keep: () => false,
  };
}

export function registerHarness(adapter: HarnessAdapter): void {
  adapters.set(adapter.id, adapter);
}

/**
 * WP-134: an adapter one chat runs through instead of one of the eleven, for a More agents entry
 * (src/integrations/harness/moreAgents/). Its id is the entry's own, never a HarnessId, so it is never registered by
 * id, never listed with the eleven, and never reached through `getHarness`.
 */
export type SessionRouteAdapter = Omit<HarnessAdapter, "id"> & { id: string };

const sessionRoutes = new Map<string, SessionRouteAdapter>();

/** Route one chat's turns, stops and answers to `adapter`; null puts it back on its harness. */
export function routeHarnessSession(
  sessionId: string,
  adapter: SessionRouteAdapter | null,
): void {
  if (adapter) sessionRoutes.set(sessionId, adapter);
  else sessionRoutes.delete(sessionId);
}

export function sessionRoute(sessionId: string): SessionRouteAdapter | undefined {
  return sessionRoutes.get(sessionId);
}

/** The routed adapter when the chat has one, else its harness's. A routed chat never falls back to the harness. */
function adapterFor(
  harness: HarnessId,
  sessionId: string,
): SessionRouteAdapter | undefined {
  return sessionRoutes.get(sessionId) ?? adapters.get(harness);
}

function requireAdapterFor(
  harness: HarnessId,
  sessionId: string,
): SessionRouteAdapter {
  const adapter = adapterFor(harness, sessionId);
  if (!adapter) {
    throw new Error(`No harness adapter registered for "${harness}"`);
  }
  return adapter;
}

/** Whether this chat's adapter can take a follow-up mid-turn. A routed chat answers for itself. */
export function canSteerHarnessSession(
  harness: HarnessId,
  sessionId: string,
): boolean {
  const adapter = adapterFor(harness, sessionId);
  if (!adapter?.live) return false;
  return adapter.canSteer !== false;
}

export function getHarness(id: HarnessId): HarnessAdapter | undefined {
  return adapters.get(id);
}

export function requireHarness(id: HarnessId): HarnessAdapter {
  const adapter = adapters.get(id);
  if (!adapter) {
    throw new Error(`No harness adapter registered for "${id}"`);
  }
  return adapter;
}

export function isLiveHarness(id: HarnessId): boolean {
  return adapters.get(id)?.live === true;
}

export function listHarnesses(): HarnessAdapter[] {
  return [...adapters.values()];
}

/**
 * r101 (2, B5 842b): words the app adds on the wire to one turn of a chat (never shown in the transcript): the hub
 * gives a Lead the live count of Ash's Inbox asks with his status question. Identity when none is set.
 */
let decorateTurnText: (sessionId: string, text: string) => string = (_id, text) => text;
export function setTurnTextDecorator(fn: ((sessionId: string, text: string) => string) | undefined): void {
  decorateTurnText = fn ?? ((_id, text) => text);
}

export function sendHarnessTurn(input: SendTurnInput & { harness: HarnessId }) {
  // WP-177: a chat that is moving or has moved sends nothing; the refusal is the same promise a failed send gives.
  try {
    assertChatAcceptsTurns(input.sessionId);
  } catch (error) {
    return Promise.reject(error);
  }
  // WP-247: only Ash, from his own composer, sets or clears a chat's goal. Checked on the text as the caller gave it.
  const goalRefused = goalTurnRefusal(input.text, input.byOwner === true);
  if (goalRefused) return Promise.reject(new Error(goalRefused));
  input = { ...input, text: decorateTurnText(input.sessionId, input.text) };
  return queueSessionOperation(input.sessionId, async () => {
    // Before the control port or any provider hears of the turn: a chat with no folder starts nothing.
    requireChatFolder(input.cwd);
    const adapter = requireAdapterFor(input.harness, input.sessionId);
    if (!adapter.live) {
      throw new Error(`${input.harness} is not connected yet`);
    }
    // WP-176: the one admission point for spend. Every turn passes it, whatever started it (a person, a habit, a
    // worker or a task). A refused turn starts nothing, and the reason is what the chat shows.
    if (spendGateActive()) {
      const admitted = await admitSpendTurn({ sessionId: input.sessionId, cwd: input.cwd, harness: input.harness, model: input.model, origin: input.origin });
      if (!admitted.ok) throw new Error(admitted.reason);
    }
    cancelIdlePark(input.sessionId);
    idleParkEvents.set(input.sessionId, input.onEvent);
    const controlled = typeof isTauri === "function" && isTauri();
    if (controlled)
      await invoke("control_authorize_turn", {
        sessionId: input.sessionId,
        cwd: input.cwd,
        appAccess: input.appAccess === true,
      });
    activeTurnSessions.add(input.sessionId);
    try {
      await adapter.sendTurn({
        ...input,
        // Workflow runs also feed views outside the chat (Being built).
        onEvent: (event) => {
          // r65 (#13): every harness, not only Claude: a keychain or credential read is refused here before it reaches
          // the chat or any auto-approval, and the agent is left to ask Ash for it.
          // WP-247: a tool call that would set or clear the chat's own goal is refused the same way, on every CLI.
          if (event.type === "approval.requested" && (credentialBlock(event.call, input.cwd) || goalToolRefusal(event.call))) {
            // Some providers register the pending approval just after emitting it (grok, cursor, pi): answer next tick.
            setTimeout(() => adapter.respondApproval(input.sessionId, event.requestId, "deny"), 0);
            return;
          }
          if (event.type === "workflow.progress") {
            noteWorkflowRun(input.sessionId, event.run);
          }
          input.onEvent(event);
        },
        onAccepted: () => {
          input.onEvent({ type: "turn.ready" });
          input.onAccepted?.();
        },
      });
    } finally {
      clearWorkflowRuns(input.sessionId);
      activeTurnSessions.delete(input.sessionId);
      if (controlled)
        await invoke("control_turn_finished", { sessionId: input.sessionId });
      scheduleIdlePark(input.harness, input.sessionId);
    }
  });
}

/** Stop one workflow run (or other background task) inside a live turn. */
export async function stopHarnessTask(
  harness: HarnessId,
  sessionId: string,
  taskId: string,
): Promise<boolean> {
  const adapter = adapterFor(harness, sessionId);
  if (!adapter?.live || !adapter.stopTask) return false;
  return adapter.stopTask(sessionId, taskId);
}

/**
 * Hand a running session its new model, effort or permission mode now rather
 * than at the next message. Not queued behind the running turn: that is the
 * point. Harnesses without live changes pick them up on the next message.
 */
export async function applyHarnessSettings(
  input: LiveSettingsInput & { harness: HarnessId },
): Promise<LiveSettingsOutcome> {
  const adapter = adapterFor(input.harness, input.sessionId);
  if (!adapter?.live || !adapter.applySettings) return "idle";
  return adapter.applySettings(input);
}

export function canCompactHarnessContext(id: HarnessId): boolean {
  const adapter = adapters.get(id);
  return adapter?.live === true && adapter.compactContext != null;
}

export function compactHarnessContext(
  input: CompactContextInput & { harness: HarnessId },
): Promise<void> {
  // WP-177: a moved or frozen chat compacts nothing; the refusal is the same promise a failed compact gives.
  try {
    assertChatAcceptsTurns(input.sessionId);
  } catch (error) {
    return Promise.reject(error);
  }
  return queueSessionOperation(input.sessionId, async () => {
    requireChatFolder(input.cwd);
    const adapter = requireAdapterFor(input.harness, input.sessionId);
    if (!adapter.live) {
      throw new Error(`${input.harness} is not connected yet`);
    }
    if (!adapter.compactContext) {
      throw new Error(`${input.harness} does not support manual compaction`);
    }
    cancelIdlePark(input.sessionId);
    try {
      await adapter.compactContext(input);
    } finally {
      scheduleIdlePark(input.harness, input.sessionId);
    }
  });
}

export function canSteerHarness(id: HarnessId): boolean {
  const adapter = adapters.get(id);
  if (!adapter?.live) return false;
  return adapter.canSteer !== false;
}

/** True only when a live adapter says it cannot redirect a running turn. */
export function harnessCannotSteer(id: HarnessId): boolean {
  const adapter = adapters.get(id);
  if (!adapter?.live) return false;
  return adapter.canSteer === false;
}

export function canRewindHarnessLastTurn(id: HarnessId): boolean {
  const adapter = adapters.get(id);
  return adapter?.live === true && adapter.rewindLastTurn != null;
}

export function rewindHarnessLastTurn(
  input: RewindLastTurnInput & { harness: HarnessId },
): Promise<RewindLastTurnResult> {
  // WP-177: a moved chat's provider thread is not rolled back here; the refusal is the same as for a send.
  try {
    assertChatAcceptsTurns(input.sessionId);
  } catch (error) {
    return Promise.reject(error);
  }
  return queueSessionOperation(input.sessionId, async () => {
    requireChatFolder(input.cwd);
    const adapter = requireAdapterFor(input.harness, input.sessionId);
    if (!adapter.rewindLastTurn) {
      throw new Error(
        `${input.harness} does not support editing the last message`,
      );
    }
    cancelIdlePark(input.sessionId);
    try {
      return await adapter.rewindLastTurn(input);
    } finally {
      scheduleIdlePark(input.harness, input.sessionId);
    }
  });
}

export function steerHarnessTurn(
  input: SteerTurnInput & { harness: HarnessId },
): Promise<void> {
  try {
    assertChatAcceptsTurns(input.sessionId);
  } catch (error) {
    return Promise.reject(error);
  }
  const goalRefused = goalTurnRefusal(input.text, input.byOwner === true);
  if (goalRefused) return Promise.reject(new Error(goalRefused));
  return queueSteerOperation(input.sessionId, async () => {
    const adapter = requireAdapterFor(input.harness, input.sessionId);
    if (!adapter.live) {
      throw new Error(`${input.harness} is not connected yet`);
    }
    // WP-176: a steer is a turn too, so it passes the same admission (an automated steer over a limit is refused).
    if (spendGateActive()) {
      const admitted = await admitSpendTurn({ sessionId: input.sessionId, cwd: input.cwd, harness: input.harness, model: input.model, origin: input.origin });
      if (!admitted.ok) throw new Error(admitted.reason);
    }
    cancelIdlePark(input.sessionId);
    await adapter.steerTurn(input);
  });
}

export async function cancelHarnessTurn(
  harness: HarnessId,
  sessionId: string,
): Promise<void> {
  const adapter = adapterFor(harness, sessionId);
  if (!adapter?.live) return;
  cancelIdlePark(sessionId);
  await adapter.cancelTurn(sessionId);
  scheduleIdlePark(harness, sessionId);
}

/** True only when the harness confirmed it had a live call waiting for this decision. */
export function respondHarnessApproval(
  harness: HarnessId,
  sessionId: string,
  requestId: number,
  decision: ApprovalDecision,
): boolean {
  return adapterFor(harness, sessionId)?.respondApproval(sessionId, requestId, decision) === true;
}

export function respondHarnessQuestion(
  harness: HarnessId,
  sessionId: string,
  requestId: number,
  reply: UserQuestionReply,
): void {
  adapterFor(harness, sessionId)?.respondQuestion?.(sessionId, requestId, reply);
}

export function keepHarnessQuestionOpen(
  harness: HarnessId,
  sessionId: string,
  requestId: number,
): void {
  adapterFor(harness, sessionId)?.keepQuestionOpen?.(sessionId, requestId);
}

export async function stopHarnessSession(
  harness: HarnessId,
  sessionId: string,
): Promise<void> {
  cancelIdlePark(sessionId);
  idleParkEvents.delete(sessionId);
  const adapter = adapterFor(harness, sessionId);
  if (!adapter?.live) return;
  await adapter.stopSession(sessionId);
}

export async function forgetHarnessSession(
  harness: HarnessId,
  sessionId: string,
): Promise<void> {
  cancelIdlePark(sessionId);
  const adapter = adapterFor(harness, sessionId);
  if (!adapter) return;
  await adapter.forgetSession(sessionId);
}

/** A deleted chat: every adapter drops what it still keeps for it. */
export function dropHarnessSession(sessionId: string): void {
  // A More agents chat keeps its link until it is dropped; the list entry stays.
  if (registryAgentIdForSession(sessionId)) unlinkRegistryChat(sessionId);
  for (const adapter of adapters.values()) adapter.dropSession?.(sessionId);
  sessionRoutes.get(sessionId)?.dropSession?.(sessionId);
}

export function bindHarnessSession(
  harness: HarnessId,
  threadId: string,
  providerSessionId: string,
  cwd: string,
  providerAccountId?: string,
  /** Restored transcript, so the adapter can reseed its task state. */
  blocks?: Block[],
  /** The chat's saved /goal, so a restart carries on with it. */
  goal?: SessionGoal,
): void {
  const adapter = adapterFor(harness, threadId);
  adapter?.bindSession(threadId, providerSessionId, cwd, providerAccountId);
  if (goal) adapter?.restoreGoal?.(threadId, goal);
  // Round 12: before the task-list return, so a transcript with no task panel still drops the folder pin.
  if (blocks?.length) adapter?.restoreMovedFolder?.(threadId, blocks);
  if (!blocks || !adapter?.restoreTaskLists) return;
  const lists = blocks.flatMap((block) =>
    block.role === "tasks" && block.taskList ? [block.taskList] : [],
  );
  if (lists.length > 0) adapter.restoreTaskLists(threadId, lists);
}

/**
 * Continue a provider conversation under another account of the same provider.
 * The old process stops first so its transcript is complete, then the native
 * transcript is copied to the new account and the thread resumes from it.
 * Throws when the transcript cannot be carried, leaving the thread unbound.
 */
export async function transferHarnessSessionAccount(input: {
  harness: "claude" | "codex";
  threadId: string;
  providerSessionId: string;
  cwd: string;
  fromAccountId?: string;
  toAccountId: string;
  blocks?: Block[];
}): Promise<void> {
  await forgetHarnessSession(input.harness, input.threadId);
  await transferProviderSession(
    input.harness,
    input.fromAccountId,
    input.toAccountId,
    input.providerSessionId,
  );
  bindHarnessSession(
    input.harness,
    input.threadId,
    input.providerSessionId,
    input.cwd,
    input.toAccountId,
    input.blocks,
  );
}

/**
 * Probe model lists only for the harnesses the caller actually needs.
 * Boot used to refresh every adapter; that spawned unused CLIs (Pi with
 * extensions can sit at ~1GB) even when the workspace never touched them.
 */
/** `force` re-reads a catalog that already loaded, e.g. after a CLI update. */
export async function refreshHarnessCatalogs(
  ids: Iterable<HarnessId>,
  options?: { force?: boolean },
): Promise<void> {
  const wanted = new Set(ids);
  if (wanted.size === 0) return;
  await Promise.all(
    [...adapters.values()]
      .filter((adapter) => wanted.has(adapter.id))
      .map(async (adapter) => {
        if (!adapter.refreshCatalog) return;
        // `force` marks an explicit user action (Settings, or the provider
        // update notice); routine refreshes, and opening the model picker,
        // keep skipping adapters that already hold a catalog.
        if (!options?.force && hasLiveCatalog(adapter.id)) return;
        await adapter.refreshCatalog().catch((error: unknown) => {
          console.debug(`[monocode] ${adapter.id} catalog`, error);
        });
      }),
  );
}

/**
 * A text call the adapter makes for the app (a title, a commit message, a PR, a branch name). It is automated work, so
 * it passes the same spend admission as runHarnessTextPrompt, and what it ran is noted in the ledger as unpriced.
 */
async function gatedTextCall<T>(cwd: string, origin: TurnOrigin, run: () => Promise<T>): Promise<T> {
  const sessionId = `text-prompt-${(textPromptSeq += 1)}`;
  if (spendGateActive()) {
    const admitted = await admitSpendTurn({ sessionId, cwd, harness: "claude", origin });
    if (!admitted.ok) throw new Error(admitted.reason);
  }
  try {
    return await run();
  } finally {
    noteUnpricedTurn({ sessionId, cwd });
  }
}

export async function generateHarnessTitle(
  harness: HarnessId,
  input: TitleInput,
): Promise<GeneratedSessionTitle | null> {
  const adapter = getHarness(harness);
  if (!adapter?.generateTitle) return null;
  return gatedTextCall("", "automated", () => adapter.generateTitle!(input));
}

export async function generateHarnessCommitMessage(
  harness: HarnessId,
  cwd: string,
  signal?: AbortSignal,
  paths?: readonly string[],
  /** Who asked for it: a commit message Ash asks for is his turn (warned, not refused), otherwise automated. */
  origin: TurnOrigin = "automated",
): Promise<string> {
  const adapter = requireHarness(harness);
  if (!adapter.generateCommitMessage) {
    throw new Error(`${harness} does not support commit message generation`);
  }
  signal?.throwIfAborted();
  return gatedTextCall(cwd, origin, () =>
    paths === undefined
      ? adapter.generateCommitMessage!(cwd, signal)
      : adapter.generateCommitMessage!(cwd, signal, paths),
  );
}

export async function generateHarnessPrContent(
  harness: HarnessId,
  cwd: string,
): Promise<(PrContent & { base: string; head: string }) | null> {
  const adapter = getHarness(harness);
  if (!adapter?.generatePrContent) return null;
  return gatedTextCall(cwd, "automated", () => adapter.generatePrContent!(cwd));
}

export async function generateHarnessBranchName(
  harness: HarnessId,
  cwd: string,
  message: string,
): Promise<string | null> {
  const adapter = getHarness(harness);
  if (!adapter?.generateBranchName) return null;
  return gatedTextCall(cwd, "automated", () => adapter.generateBranchName!(cwd, message));
}

export async function warmupHarnessText(
  harness: HarnessId,
  cwd: string,
): Promise<void> {
  await getHarness(harness)?.warmupText?.(cwd);
}

export function canRunHarnessTextPrompt(harness: HarnessId): boolean {
  const adapter = getHarness(harness);
  return adapter?.live === true && adapter.runTextPrompt != null;
}

function stopTextPrompt(adapter: HarnessAdapter): Promise<void> {
  return adapter.stopTextPrompt
    ? adapter.stopTextPrompt().catch(() => undefined)
    : Promise.resolve();
}

const activeTextPromptOwners = new Map<HarnessAdapter, Set<symbol>>();

function beginTextPrompt(adapter: HarnessAdapter): symbol {
  const owner = Symbol("text-prompt");
  const owners = activeTextPromptOwners.get(adapter) ?? new Set<symbol>();
  owners.add(owner);
  activeTextPromptOwners.set(adapter, owners);
  return owner;
}

function finishTextPrompt(
  adapter: HarnessAdapter,
  owner: symbol,
  stopIfLast: boolean,
): void {
  const owners = activeTextPromptOwners.get(adapter);
  if (!owners?.delete(owner)) return;
  if (owners.size > 0) return;
  activeTextPromptOwners.delete(adapter);
  if (stopIfLast) void stopTextPrompt(adapter);
}

function cancelledTextPrompt(): Error {
  return new Error("By-the-way request cancelled");
}

let textPromptSeq = 0;

/**
 * A text prompt (a title, a commit message, a memory or verdict pass) is automated work. It passes the spend gate's
 * admission like any other automated turn, and what it ran is noted in the ledger as unpriced.
 */
export async function runHarnessTextPrompt(
  input: TextPromptInput & { harness: HarnessId },
): Promise<string> {
  const sessionId = input.threadId ?? `text-prompt-${(textPromptSeq += 1)}`;
  if (spendGateActive()) {
    const admitted = await admitSpendTurn({ sessionId, cwd: input.cwd, harness: input.harness, model: input.model, origin: "automated" });
    if (!admitted.ok) throw new Error(admitted.reason);
  }
  try {
    return await runTextPromptUngated(input);
  } finally {
    noteUnpricedTurn({ sessionId, cwd: input.cwd });
  }
}

async function runTextPromptUngated(
  input: TextPromptInput & { harness: HarnessId },
): Promise<string> {
  const adapter = requireHarness(input.harness);
  if (!adapter.live) {
    throw new Error(`${input.harness} is not connected yet`);
  }
  if (!adapter.runTextPrompt) {
    throw new Error(`${input.harness} does not support isolated text prompts`);
  }

  const signal = input.signal;
  if (signal?.aborted) {
    throw cancelledTextPrompt();
  }

  const owner = beginTextPrompt(adapter);
  let run: Promise<string>;
  try {
    run = adapter.runTextPrompt(input);
  } catch (error) {
    finishTextPrompt(adapter, owner, false);
    throw error;
  }
  if (!signal) {
    try {
      return await run;
    } finally {
      finishTextPrompt(adapter, owner, false);
    }
  }

  let abortHandler: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    abortHandler = () => {
      finishTextPrompt(adapter, owner, false);
      reject(cancelledTextPrompt());
    };
    signal.addEventListener("abort", abortHandler, { once: true });
    if (signal.aborted) abortHandler();
  });
  try {
    return await Promise.race([run, abortPromise]);
  } finally {
    if (abortHandler) signal.removeEventListener("abort", abortHandler);
    finishTextPrompt(adapter, owner, false);
  }
}

export async function stopHarnessTextPrompts(): Promise<void> {
  await Promise.all([...adapters.values()].map(stopTextPrompt));
}
