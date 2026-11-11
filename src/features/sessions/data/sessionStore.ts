import { syncTeleportLock } from "../../connections/model/teleportLock";
import { teleportStateOf } from "../../connections/model/teleportState";
import { isCliNotice } from "../../../integrations/harness/core/cliNotices";
import { invoke } from "@tauri-apps/api/core";
import { boundaryFromDisk } from "../../memory/model/privateChat";
import { parseWorkflowRun } from "../model/workflowRun";
import { isMonoSession } from "../../monos/model/mono";
import { parseCard } from "../../monos/model/monoCards";
import { sanitizeMonoSpawnedSessions } from "../../monos/model/monoSpawnedSessions";
import { forgetWorkSession } from "../../monos/model/monoWorkSessions";
import {
  isWeakToolTitle,
  titleFromToolInput,
} from "../../../integrations/harness/core/preview";
import { codexCommandPresentation } from "../../../integrations/harness/providers/codex/codexProtocol";
import { recoverCursorSubagents } from "../../../integrations/harness/providers/cursor/cursorSubagents";
import { dropHarnessSession } from "../../../integrations/harness/core/registry";
import { isProviderErrorClass } from "../../../integrations/harness/core/providerFailure";
import { persistableAttachment } from "../model/attachments";
import { isPersistableId } from "../model/persistableId";
import { ARTIFACT_KINDS } from "../../artifacts/artifacts";
import type { ContextUsage } from "../model/contextUsage";
import {
  isRemoteProjectPath,
  normalizeProjectPath,
} from "../../projects/model/recents";
import {
  claudeShellCommands,
  ompActiveAssistantTexts,
  ompSessionInterjections,
} from "../../../platform/tauri/fs";
import {
  backfillOmpInterjections,
  ompStatusSplitTexts,
} from "../model/ompInterjections";
import type {
  AgentRunMeta,
  AgentStep,
  Block,
  BtwMessage,
  BtwThread,
  CutWork,
  GeneratedImageMeta,
  HarnessId,
  HandoffMeta,
  HandoffStatus,
  InterjectionMeta,
  LinkedWorkItem,
  RuntimeMode,
  SecondOpinionMeta,
  Session,
  SessionGoal,
  TaskListMeta,
  PlanBlockMeta,
  QueuedMessage,
  MessageQueueStatus,
  TurnModel,
  TurnMetrics,
} from "../model/session";
import { restoredQueue } from "../model/messageQueue";
import { defaultModelId } from "../model/models";
import { readRetiredGrokModel } from "../model/grokRetirement";

import { HARNESSES, RUNTIME_MODES } from "../model/session";
import type { InFlightRef } from "../model/inFlight";

import { restoreOrchestrationProposal } from "../../orchestration/model/orchestrationPlan";

import type { OrchestrationSummary } from "../../orchestration/model/orchestrationSummary";

export type SessionSummary = {
  sidebarHidden?: boolean;
  /** WP-111: memory leaves this chat alone. */
  private?: boolean;
  orchestrationLeadId?: string;
  orchestration?: OrchestrationSummary;
  id: string;
  cwd: string;
  harness: HarnessId;
  model: string;
  runtimeMode: RuntimeMode;
  title: string;
  providerSessionId?: string;
  branch?: string;
  worktreeCwd?: string;
  worktreeRemoved?: boolean;
  repo?: string;
  additions?: number;
  deletions?: number;
  createdAt: number;
  updatedAt: number;
  archived?: boolean;
  pinned?: boolean;
  draft?: boolean;
  linkedWorkItem?: LinkedWorkItem;
  automationId?: string;
  // WP-85: a Claude session started in a terminal, not one Hivra started.
  terminal?: { state: string; folder: string };
};

type SessionRecord = {
  sidebarHidden?: boolean;
  /** WP-111 */
  private?: boolean;
  privateBoundaryId?: string;
  monoTranscript?: Session["monoTranscript"];
  orchestrationLeadId?: string;
  id: string;
  cwd: string;
  harness: string;
  model: string;
  modelSettings: Record<string, string>;
  runtimeMode: string;
  title: string;
  providerSessionId?: string | null;
  providerAccountId?: string | null;
  blocks: Block[];
  queuedMessages?: QueuedMessage[];
  queueStatus?: MessageQueueStatus;
  contextUsed?: number | null;
  contextWindow?: number | null;
  branch?: string | null;
  worktreeCwd?: string | null;
  worktreeRemoved?: boolean;
  linkedWorkItem?: LinkedWorkItem | null;
  automationId?: string | null;
  /** The open /goal saved with the chat (session_store.rs `goal_json`). */
  goal?: unknown;
  /** WP-177: the moved chat still owes its first turn the chat so far. */
  moveBriefOwed?: boolean;
  movedFrom?: string;
  /** WP-134: the More agents entry this chat belongs to. Absent on a chat saved before the column existed. */
  registryAgentId?: string | null;
  archived?: boolean;
  createdAt: number;
  updatedAt: number;
};

type SessionUpsertPayload = {
  sidebarHidden?: boolean;
  /** WP-111 */
  private?: boolean;
  privateBoundaryId?: string;
  id: string;
  cwd: string;
  harness: string;
  model: string;
  modelSettings: Record<string, string>;
  runtimeMode: string;
  title: string;
  providerSessionId?: string;
  providerAccountId?: string;
  blocks: Block[];
  queuedMessages?: QueuedMessage[];
  queueStatus?: MessageQueueStatus;
  contextUsed?: number;
  contextWindow?: number;
  branch?: string;
  worktreeCwd?: string;
  worktreeRemoved?: boolean;
  linkedWorkItem?: LinkedWorkItem;
  automationId?: string;
  goal?: SessionGoal;
  moveBriefOwed?: boolean;
  movedFrom?: string;
  /** WP-134: the More agents entry. Omitted when this save does not know it, which keeps the stored one. */
  registryAgentId?: string;
};

/** Only real chats belong in project history — blank tabs stay ephemeral. */
export function shouldPersistSession(session: Session): boolean {
  return (
    !session.ephemeral &&
    !session.inboxAsk &&
    !isRemoteProjectPath(session.cwd) &&
    session.cwd !== "~" &&
    // WP-177: a chat moved to another machine is saved as its marker alone, so the release survives a reload.
    (teleportStateOf(session).moved ||
      session.blocks.some((block) => block.role === "user") ||
      (isMonoSession(session.id) &&
        (session.blocks.length > 0 || !!session.monoTranscript)))
  );
}

const REGISTRY_AGENT_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** An entry id from the row or a save. A harness id or a bad slug is not one. */
function registryAgentFromRow(value: unknown): string | undefined {
  if (typeof value !== "string" || !REGISTRY_AGENT_ID.test(value)) return undefined;
  if ((HARNESSES as readonly string[]).includes(value)) return undefined;
  return value;
}

function persistableMeta(
  session: Session,
  includeQueue = true,
): Omit<SessionUpsertPayload, "blocks"> {
  const linkedWorkItem = sanitizeLinkedWorkItem(session.linkedWorkItem);
  const queuedMessages = includeQueue
    ? sanitizeQueuedMessages(session.queuedMessages)
    : [];
  const registryAgentId = registryAgentFromRow(session.registryAgentId);
  return {
    id: session.id,
    cwd: normalizeProjectPath(session.cwd),
    harness: session.harness,
    model: session.model,
    modelSettings: session.modelSettings,
    runtimeMode: session.runtimeMode,
    title: session.title,
    ...(session.sidebarHidden === true ? { sidebarHidden: true } : {}),
    // WP-111: omitted when off, so an old chat stays readable. The boundary is only a real message id.
    ...(session.private === true ? { private: true } : {}),
    ...(boundaryFromDisk(session.privateBoundaryId)
      ? { privateBoundaryId: boundaryFromDisk(session.privateBoundaryId) }
      : {}),
    ...(queuedMessages.length
      ? {
          queuedMessages,
          queueStatus: session.queueStatus ?? "active",
        }
      : {}),
    ...(session.providerSessionId && isPersistableId(session.providerSessionId)
      ? { providerSessionId: session.providerSessionId }
      : {}),
    ...(session.providerAccountId && isPersistableId(session.providerAccountId)
      ? { providerAccountId: session.providerAccountId }
      : {}),
    ...(session.context ? { contextUsed: session.context.used } : {}),
    ...(session.context?.window
      ? { contextWindow: session.context.window }
      : {}),
    ...(session.branch ? { branch: session.branch } : {}),
    ...(session.worktreeCwd ? { worktreeCwd: session.worktreeCwd } : {}),
    ...(session.worktreeRemoved ? { worktreeRemoved: true } : {}),
    ...(linkedWorkItem ? { linkedWorkItem } : {}),
    ...(session.automationId && isPersistableId(session.automationId)
      ? { automationId: session.automationId }
      : {}),
    // Only a goal still open is saved; a met, cleared or stopped one is dropped from the row, so it never comes back.
    ...(openGoal(session.goal) ? { goal: openGoal(session.goal) } : {}),
    // WP-177: without these the stored row forgets that the next turn must carry the chat so far.
    ...(session.moveBriefOwed === true ? { moveBriefOwed: true } : {}),
    ...(session.movedFrom && session.movedFrom.trim()
      ? { movedFrom: session.movedFrom.trim().slice(0, 200) }
      : {}),
    ...(registryAgentId ? { registryAgentId } : {}),
  };
}

/**
 * Claude Code's /goal as the chat saves and restores it: one still open (active or paused), well formed and bounded,
 * or nothing.
 */
export function openGoal(value: unknown): SessionGoal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const goal = value as Record<string, unknown>;
  const objective = typeof goal.objective === "string" ? goal.objective.trim().slice(0, 1_000) : "";
  if (!objective || (goal.status !== "active" && goal.status !== "paused")) return undefined;
  const checks = typeof goal.checks === "number" && Number.isFinite(goal.checks) ? Math.max(0, Math.floor(goal.checks)) : 0;
  const setAt = typeof goal.setAt === "number" && Number.isFinite(goal.setAt) ? goal.setAt : 0;
  return {
    objective,
    checks,
    status: goal.status,
    setAt,
    ...(typeof goal.lastCheck === "string" && goal.lastCheck.trim()
      ? { lastCheck: goal.lastCheck.slice(0, 1_000) }
      : {}),
    ...(typeof goal.providerSessionId === "string" && isPersistableId(goal.providerSessionId)
      ? { providerSessionId: goal.providerSessionId }
      : {}),
  };
}

/** A checker's note on its turn (hub/model/hubChecks.ts): its id, the message and the finding, bounded. */
function sanitizeMonoCheck(value: unknown): Block["monoCheck"] {
  if (!value || typeof value !== "object") return undefined;
  const check = value as Record<string, unknown>;
  if (typeof check.id !== "string" || !isPersistableId(check.id)) return undefined;
  return {
    id: check.id,
    ...(typeof check.dumpId === "string" && isPersistableId(check.dumpId)
      ? { dumpId: check.dumpId }
      : {}),
    ...(typeof check.finding === "string" && check.finding.trim()
      ? { finding: check.finding.slice(0, 1_000) }
      : {}),
  };
}

/** A room's or another Mono's hidden turn (hub rooms): what its quiet line shows, bounded. */
function sanitizeMonoNote(value: unknown): Block["monoNote"] {
  if (!value || typeof value !== "object") return undefined;
  const note = value as Record<string, unknown>;
  if ((note.kind !== "room" && note.kind !== "message") || typeof note.from !== "string" || !note.from.trim()) return undefined;
  return {
    kind: note.kind,
    from: note.from.slice(0, 200),
    // A room id ("hub:leadership") or a Mono id.
    ...(typeof note.ref === "string" && note.ref.length <= 200 && /^[\w.:-]+$/.test(note.ref) ? { ref: note.ref } : {}),
    ...(typeof note.line === "string" && note.line.trim() ? { line: note.line.slice(0, 300) } : {}),
  };
}

function sanitizeMonoSessionCompletion(
  value: unknown,
): Block["monoSessionCompletion"] {
  if (!value || typeof value !== "object") return undefined;
  const completion = value as NonNullable<Block["monoSessionCompletion"]>;
  if (
    typeof completion.sessionId !== "string" ||
    !isPersistableId(completion.sessionId) ||
    typeof completion.title !== "string" ||
    !["completed", "failed", "cancelled"].includes(completion.status)
  )
    return undefined;
  return {
    sessionId: completion.sessionId,
    title: completion.title,
    status: completion.status,
    ...(typeof completion.sessionCount === "number" &&
    Number.isInteger(completion.sessionCount) &&
    completion.sessionCount > 1
      ? { sessionCount: completion.sessionCount }
      : {}),
    ...(completion.question === true ? { question: true as const } : {}),
  };
}

/** Pending images need their bytes until delivery; object URLs never survive reloads. */
function sanitizeQueuedMessages(value: unknown): QueuedMessage[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const message = entry as QueuedMessage;
    if (
      typeof message.id !== "string" ||
      !isPersistableId(message.id) ||
      seen.has(message.id) ||
      typeof message.text !== "string"
    )
      return [];
    seen.add(message.id);
    // A room's wake belongs to the room's turn that sent it, which a restart ends: it isn't kept.
    const monoNote = sanitizeMonoNote(message.monoNote);
    if (monoNote?.kind === "room") return [];
    const attachments = Array.isArray(message.attachments)
      ? message.attachments.flatMap((file) => {
          if (
            !file ||
            typeof file.id !== "string" ||
            typeof file.name !== "string" ||
            typeof file.mimeType !== "string" ||
            !["image", "audio", "file"].includes(file.kind) ||
            typeof file.size !== "number" ||
            !Number.isFinite(file.size) ||
            file.size < 0
          )
            return [];
          return [
            {
              ...persistableAttachment(file),
              ...(!file.path &&
              file.kind === "image" &&
              typeof file.data === "string"
                ? { data: file.data }
                : {}),
            },
          ];
        })
      : [];
    const noteMeta = sanitizeNoteCard(message.noteCard);
    const completion = sanitizeMonoSessionCompletion(
      message.monoSessionCompletion,
    );
    const noteCard =
      noteMeta && typeof message.noteCard?.body === "string"
        ? { ...noteMeta, body: message.noteCard.body }
        : undefined;
    const handoff = message.handoffCard;
    const handoffCard =
      handoff &&
      typeof handoff.brief === "string" &&
      HARNESSES.includes(handoff.from) &&
      HARNESSES.includes(handoff.to)
        ? handoff
        : undefined;
    if (
      !message.text.trim() &&
      !attachments.length &&
      !noteCard &&
      !handoffCard
    )
      return [];
    return [
      {
        id: message.id,
        ...(typeof message.blockId === "string" &&
        isPersistableId(message.blockId)
          ? { blockId: message.blockId }
          : {}),
        text: message.text,
        attachments,
        ...(noteCard ? { noteCard } : {}),
        ...(handoffCard ? { handoffCard } : {}),
        ...(completion ? { monoSessionCompletion: completion } : {}),
        // An app brief's request id and "wait behind the current work" survive a restart with it.
        ...(typeof message.appRequestId === "string" &&
        isPersistableId(message.appRequestId)
          ? { appRequestId: message.appRequestId }
          : {}),
        ...(message.waitForIdle === true ? { waitForIdle: true } : {}),
        // WP-243: Ash typed it himself. Never on an app note.
        ...(message.byOwner === true && !monoNote && !completion ? { byOwner: true } : {}),
        ...(monoNote ? { monoNote } : {}),
        ...(["default", "plan", "build", "orchestrate"].includes(
          message.intent ?? "",
        )
          ? { intent: message.intent }
          : {}),
        ...(typeof message.error === "string" && message.error
          ? { error: message.error }
          : {}),
      },
    ];
  });
}

export function sanitizeLinkedWorkItem(
  value: unknown,
): LinkedWorkItem | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const item = value as Partial<LinkedWorkItem>;
  const kind = item.kind;
  const repo = typeof item.repo === "string" ? item.repo.trim() : "";
  const number = item.number;
  if (
    (kind !== "issue" && kind !== "pr") ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number <= 0
  ) {
    return undefined;
  }
  return {
    kind,
    repo,
    number,
    url: `https://github.com/${repo}/${kind === "pr" ? "pull" : "issues"}/${number}`,
  };
}

export function sanitizeSessionForPersist(
  session: Session,
): SessionUpsertPayload {
  const firstUser = session.blocks.findIndex((block) => block.role === "user");
  return {
    ...persistableMeta(session),
    blocks: session.blocks
      .map((block, index) =>
        sanitizeBlock(
          index === firstUser && session.orchestrationLeadId
            ? { ...block, orchestrationLeadId: session.orchestrationLeadId }
            : block,
        ),
      )
      .filter((block): block is Block => block != null),
  };
}

/**
 * `session_upsert` runs off the main thread, so two writes for the same
 * session could otherwise land in either order and let an older transcript
 * overwrite a newer one. Chain them per session; different sessions still
 * write concurrently.
 */
const sessionWriteQueues = new Map<string, Promise<unknown>>();
const sessionWriteLeadById = new Map<string, string>();
const deletedSessionIds = new Set<string>();

function enqueueSessionWrite<T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = sessionWriteQueues.get(sessionId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  sessionWriteQueues.set(sessionId, tail);
  void tail.then(() => {
    if (sessionWriteQueues.get(sessionId) === tail) {
      sessionWriteQueues.delete(sessionId);
      sessionWriteLeadById.delete(sessionId);
    }
  });
  return run;
}

/**
 * WP-177: the chats saved as moved to another machine. A save of an older, pre-move copy of one of them is refused, so
 * no writer (quit, a queue drain, a stale window) can bring a chat back to life on this Mac. A chat returns only with its
 * "teleported-back" notice. Filled when a chat is read, so the guard holds after a restart too.
 */
const movedSessionIds = new Map<string, number>();

/** Test-only reset: a new process starts with no moved rows known, and reads fill the set again. */
export function forgetMovedRowsForTests(): void {
  movedSessionIds.clear();
}

/** When a chat was moved away (the marker's time), or 0 when the row does not say. */
function movedAtOf(session: Session): number {
  const moved = session.blocks.find((b) => b.notice === "teleported");
  return moved?.startedAt ?? 0;
}

/** A "Moved back" notice counts only when it is newer than the move away it answers (M3). */
function returnedAfterMove(session: Session, movedAt: number): boolean {
  return session.blocks.some((b) => b.notice === "teleported-back" && (b.startedAt ?? 0) > movedAt);
}

/** One step of a chat move (WP-177). The store checks that the step makes only its own change. */
export type TeleportStep = {
  moveId: string;
  op:
    | "freeze"
    | "thaw"
    | "release"
    | "incoming"
    | "discard"
    | "activate"
    | "abort"
    | "freeze-ask"
    | "clear-freeze-ask"
    | "settle";
};

/** The store refused a move step because the chat is not in the state the step needs (another move holds it). */
export class TeleportConflict extends Error {}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A reply saved after a move step read the row. Release and activate send a new transcript on purpose; every other
 * step keeps a block the stored row gained and the step's copy does not have.
 */
function withRepliesSavedSince(stored: Block[], stepBlocks: Block[]): Block[] {
  const seen = new Set(stepBlocks.map((block) => block.id));
  const extra = stored.filter(
    (block) => !(block.notice ?? "").startsWith("teleport") && !seen.has(block.id),
  );
  return extra.length === 0 ? stepBlocks : [...stepBlocks, ...extra];
}

export async function upsertSession(
  session: Session,
  teleport?: TeleportStep,
): Promise<SessionSummary | null> {
  if (!shouldPersistSession(session) || deletedSessionIds.has(session.id)) {
    return null;
  }
  const moved = teleportStateOf(session).moved;
  const returning = returnedAfterMove(session, movedSessionIds.get(session.id) ?? 0);
  // A move step is checked by the store itself (session_upsert's guard). Only an ordinary save uses this window's copy.
  if (!teleport && movedSessionIds.has(session.id) && !moved && !returning) return null;
  if (moved) movedSessionIds.set(session.id, movedAtOf(session));
  else if (returning) movedSessionIds.delete(session.id);
  const mono = !!session.monoTranscript || isMonoSession(session.id);
  const snapshot = mono
    ? session.blocks.filter((block) => monoPersistedBlock(block) !== null)
    : session.blocks;
  // Mono writes sanitize only the changed suffix inside the serialized queue.
  const payload = mono
    ? persistableMeta(session)
    : sanitizeSessionForPersist(session);
  if (session.orchestrationLeadId) {
    sessionWriteLeadById.set(session.id, session.orchestrationLeadId);
  } else {
    sessionWriteLeadById.delete(session.id);
  }
  const summary = await enqueueSessionWrite(session.id, async () => {
    if (deletedSessionIds.has(session.id)) return null;
    if (mono) {
      const previous = monoSavedBlocks.get(session.id);
      let same = 0;
      if (previous) {
        while (
          same < previous.length &&
          same < snapshot.length &&
          previous[same] === snapshot[same]
        )
          same++;
      }
      const changed =
        !previous || same !== previous.length || same !== snapshot.length;
      const summary = await invoke<SessionSummary>("mono_session_upsert", {
        session: {
          ...payload,
          blocks: changed
            ? snapshot.slice(same).map((block) => monoPersistedBlock(block)!)
            : [],
        },
        afterBlockId: same > 0 ? snapshot[same - 1].id : null,
        fromBlockId:
          same === 0
            ? previous !== undefined
              ? (previous[0]?.id ?? null)
              : (session.monoTranscript?.firstBlockId ?? null)
            : null,
        blocksChanged: changed,
        appendOnly: previous?.length === 0,
      });
      monoSavedBlocks.set(session.id, snapshot);
      return summary;
    }
    // WP-177: a step is applied to the row as it is now, inside this write, so a reply saved since the step read
    // the row is not overwritten. An ordinary save is not read first; the store keeps the move notes itself.
    if (teleport && teleport.op !== "release" && teleport.op !== "activate") {
      try {
        const stored = await readSession(session.id);
        if (stored) {
          (payload as SessionUpsertPayload).blocks = withRepliesSavedSince(
            stored.blocks,
            (payload as SessionUpsertPayload).blocks,
          );
        }
      } catch {
        // A failed read leaves the step as the caller built it.
      }
    }
    return invoke<SessionSummary>("session_upsert", {
      session: {
        ...payload,
        blocks: (payload as SessionUpsertPayload).blocks.map((block) =>
          block.orchestrationLeadId &&
          deletedSessionIds.has(block.orchestrationLeadId)
            ? { ...block, orchestrationLeadId: undefined }
            : block,
        ),
        ...(teleport ? { teleport: { moveId: teleport.moveId, op: teleport.op } } : {}),
      },
    }).catch((error: unknown) => {
      // The store's own guard (WP-177): a conflict is the move's answer; a refused ordinary save is dropped, not an error.
      const message = errorText(error);
      if (message.startsWith("teleport-conflict")) throw new TeleportConflict(message);
      if (message.startsWith("teleport-refused")) return null;
      throw error;
    });
  });
  return summary ? normalizeSummary(summary) : null;
}

/**
 * Blocks are replaced, never mutated in place, so identity stands in for
 * content. Serializing the session here instead meant a full deep copy and a
 * `JSON.stringify` of the whole transcript — megabytes on a long chat — on the
 * main thread every time a save was considered. Header fields go through
 * `persistableMeta` so a new persisted column cannot be forgotten here.
 */
const blockTokens = new WeakMap<Block, number>();
const queuedMessageTokens = new WeakMap<QueuedMessage, number>();
let lastBlockToken = 0;
let lastQueuedMessageToken = 0;

function blockToken(block: Block): number {
  const seen = blockTokens.get(block);
  if (seen !== undefined) return seen;
  const token = ++lastBlockToken;
  blockTokens.set(block, token);
  return token;
}

export function persistFingerprint(session: Session): string {
  // Pasted image bytes can be megabytes. Like transcript blocks, queue rows
  // are immutable, so their identity detects edits without serializing bytes.
  const queue = (session.queuedMessages ?? []).map((message) => {
    let token = queuedMessageTokens.get(message);
    if (token === undefined) {
      token = ++lastQueuedMessageToken;
      queuedMessageTokens.set(message, token);
    }
    return token;
  });
  return `${JSON.stringify(persistableMeta(session, false))}|${queue.length ? (session.queueStatus ?? "active") : ""}:${queue.join(",")}|${session.orchestrationLeadId ?? ""}|${session.blocks
    .map(blockToken)
    .join(",")}`;
}

export async function listSessionsByProject(
  cwd: string,
): Promise<SessionSummary[]> {
  if (!cwd || cwd === "~") return [];
  const rows = await invoke<SessionSummary[]>("session_list_by_project", {
    cwd: normalizeProjectPath(cwd),
  });
  return rows.map(normalizeSummary);
}

/** Chats that have no folder (an import cleared it, docs/PORTABLE.md): the sidebar's "Needs a folder" group. */
export async function listFolderlessSessions(): Promise<SessionSummary[]> {
  const rows = await invoke<SessionSummary[]>("session_list_folderless");
  return rows.map(normalizeSummary);
}

export function rebaseProjectSessions(
  fromCwd: string,
  toCwd: string,
): Promise<void> {
  return invoke<void>("session_rebase_project", {
    fromCwd: normalizeProjectPath(fromCwd),
    toCwd: normalizeProjectPath(toCwd),
  });
}

export async function listLinkedSessions(): Promise<SessionSummary[]> {
  const rows = await invoke<SessionSummary[]>("session_list_linked");
  return rows.map(normalizeSummary);
}

export type SessionSearchHit = {
  kind: "conversation" | "message";
  sessionId: string;
  cwd: string;
  harness: string;
  title: string;
  updatedAt: number;
  blockId?: string;
  role?: string;
  preview: string;
};

export type SessionSearchResult = {
  hits: SessionSearchHit[];
  truncated: boolean;
};

export async function searchSessions(options: {
  query: string;
  searchOwner: string;
  cwd?: string;
  includeArchived?: boolean;
}): Promise<SessionSearchResult> {
  const query = options.query.trim();
  if (!query) return { hits: [], truncated: false };
  const result = await invoke<SessionSearchResult>("session_search", {
    options: {
      query,
      searchOwner: options.searchOwner,
      ...(options.cwd && options.cwd !== "~"
        ? { cwd: normalizeProjectPath(options.cwd) }
        : {}),
      ...(options.includeArchived ? { includeArchived: true } : {}),
    },
  });
  return {
    hits: Array.isArray(result?.hits) ? result.hits : [],
    truncated: !!result?.truncated,
  };
}

export function cancelSessionSearch(searchOwner: string): Promise<void> {
  return invoke<void>("cancel_session_search", { searchOwner });
}

const monoSavedBlocks = new Map<string, Block[]>();
const monoBlockPayloads = new WeakMap<Block, Block | null>();
function monoPersistedBlock(block: Block): Block | null {
  if (monoBlockPayloads.has(block)) return monoBlockPayloads.get(block)!;
  const payload = sanitizeBlock(block);
  monoBlockPayloads.set(block, payload);
  return payload;
}

export const MONO_PAGE_TURNS = 10;
export type MonoTranscriptPage = {
  blocks: Block[];
  before: number | null;
  hasNewer: boolean;
};

export async function getMonoTranscriptPage(
  sessionId: string,
  options: {
    before?: number;
    beforeBlockId?: string;
    aroundBlockId?: string;
  } = {},
): Promise<MonoTranscriptPage> {
  const page = await invoke<MonoTranscriptPage>("mono_session_page", {
    sessionId,
    before: options.before ?? null,
    beforeBlockId: options.beforeBlockId ?? null,
    aroundBlockId: options.aroundBlockId ?? null,
  });
  return {
    ...page,
    blocks: page.blocks
      .map((block) => sanitizeBlock(block, { hydrate: true }))
      .filter((block): block is Block => !!block),
  };
}

export function findMonoTranscript(
  sessionId: string,
  query: string,
): Promise<string[]> {
  return invoke("mono_session_find", { sessionId, query });
}

export async function getSession(sessionId: string): Promise<Session | null> {
  const session = await readSession(sessionId);
  return session ? repairSession(session) : null;
}

/**
 * WP-177: the row a move hashes. The sidebar read drops tool output over 512 bytes, which would make a plan taken from
 * the window disagree with the move. This read keeps that output. A build or a test double without the command falls
 * back to the sidebar read, so both sides of the move still hash the same bytes.
 */
export async function readSessionForMove(sessionId: string): Promise<Session | null> {
  try {
    const record = await invoke<SessionRecord | null>("session_get_for_move", { sessionId });
    if (record && typeof record === "object" && typeof record.id === "string") {
      const session = recordToSession(record);
      syncTeleportLock(session);
      if (teleportStateOf(session).moved) movedSessionIds.set(session.id, movedAtOf(session));
      return repairSession(session);
    }
  } catch {
    // Test doubles and older builds have no full-row command.
  }
  try {
    return await getSession(sessionId);
  } catch {
    // No desktop store here (the browser fixture). The caller keeps the chat it already holds.
    return null;
  }
}

/** Read the saved conversation without waiting for optional provider-log repairs. */
export async function readSession(sessionId: string): Promise<Session | null> {
  const record = await invoke<SessionRecord | null>(
    isMonoSession(sessionId) ? "mono_session_get" : "session_get",
    {
      sessionId,
    },
  );
  if (!record) return null;
  const session = recordToSession(record);
  if (session.monoTranscript) monoSavedBlocks.set(sessionId, session.blocks);
  // WP-177: every read of a saved chat sets its send lock (moved or frozen), so a restart keeps it.
  syncTeleportLock(session);
  if (teleportStateOf(session).moved) movedSessionIds.set(session.id, movedAtOf(session));
  return session;
}

/** Fetched output stays off its block, so saves never ship it back. */
const TOOL_DETAIL_CACHE_CHARS = 2_000_000;
const toolDetailCache = new Map<string, string | null>();
let toolDetailCacheChars = 0;

/**
 * Output a loaded transcript omitted (`detailOmitted`), read when its row is
 * expanded. `stepId` names a step inside the block's subagent run.
 */
export async function loadToolDetail(
  sessionId: string,
  blockId: string,
  stepId?: string,
): Promise<string | null> {
  const key = `${sessionId}\0${blockId}\0${stepId ?? ""}`;
  const cached = toolDetailCache.get(key);
  if (cached !== undefined) {
    toolDetailCache.delete(key);
    toolDetailCache.set(key, cached);
    return cached;
  }
  const detail = await invoke<string | null>("session_tool_detail", {
    sessionId,
    blockId,
    stepId: stepId ?? null,
  });
  toolDetailCache.set(key, detail);
  toolDetailCacheChars += detail?.length ?? 0;
  for (const [oldest, value] of toolDetailCache) {
    if (toolDetailCacheChars <= TOOL_DETAIL_CACHE_CHARS) break;
    if (oldest === key) break;
    toolDetailCache.delete(oldest);
    toolDetailCacheChars -= value?.length ?? 0;
  }
  return detail;
}

/** A progressive caller publishes the repair against current state before persisting. */
export async function repairSession(
  source: Session,
  { persist = true }: { persist?: boolean } = {},
): Promise<Session> {
  const session = { ...source };
  if (session.harness === "claude" && session.providerSessionId) {
    const toolIds = shellPlaceholderIds(session.blocks);
    if (toolIds.length) {
      try {
        const commands = await claudeShellCommands(
          session.providerSessionId,
          session.providerAccountId,
          toolIds,
        );
        const blocks = backfillClaudeShellCommands(session.blocks, commands);
        if (blocks !== session.blocks) {
          session.blocks = blocks;
          if (persist) await upsertSession(session);
        }
      } catch {
        // A missing or unreadable Claude transcript must not block the session.
      }
    }
  }
  if (session.harness === "codex") {
    // Relabel from the command already saved on the row. Codex sends it with
    // the item and `shellCommandPreview` stores it as the preview title, so
    // this needs no disk read at all.
    const blocks = backfillCodexShellCommands(session.blocks);
    if (blocks !== session.blocks) {
      session.blocks = blocks;
      // A failed write must not cost the reader the session. The repair stays
      // in memory and the next load retries it.
      if (persist) await upsertSession(session).catch(() => undefined);
    }
  }
  if (session.harness !== "omp" || !session.providerSessionId) {
    return recoverCursorSubagents(session);
  }
  try {
    const anchors = await ompSessionInterjections(session.providerSessionId);
    // Missing source order must not prevent the existing anchored repair.
    const source = ompStatusSplitTexts(session.blocks).length
      ? await ompActiveAssistantTexts(session.providerSessionId).catch(() => [])
      : [];
    const blocks = backfillOmpInterjections(session.blocks, anchors, source);
    if (blocks !== session.blocks) {
      session.blocks = blocks;
      // Persist before exposing the restored session to a new live turn.
      // Re-reading the source on later loads allows partial repairs to retry;
      // deterministic IDs ensure already repaired transcripts are not written.
      if (persist) await upsertSession(session);
    }
  } catch {
    // Source logs may be absent/unreadable. Even a failed write must not stop
    // restore; the recovered in-memory boundaries can still be displayed.
  }
  return session;
}

/** Never let a delayed repair replace a newer stream, edit, or provider binding. */
export function applySessionRepair(
  current: Session,
  source: Session,
  repaired: Session,
): Session {
  if (
    current.id !== source.id ||
    current.blocks !== source.blocks ||
    current.harness !== source.harness ||
    current.providerSessionId !== source.providerSessionId ||
    current.providerAccountId !== source.providerAccountId ||
    repaired.blocks === source.blocks
  )
    return current;
  return { ...current, blocks: repaired.blocks };
}

export function backfillClaudeShellCommands(
  blocks: Block[],
  commands: Record<string, string>,
): Block[] {
  let changed = false;
  const repaired = blocks.map((block) => {
    const callId = block.tool?.callId;
    const value = callId ? commands[callId] : undefined;
    const command = typeof value === "string" ? value.trim() : undefined;
    if (
      block.role !== "tool" ||
      block.tool?.kind !== "execute" ||
      block.text.trim() !== "Shell" ||
      !command
    ) {
      return block;
    }
    changed = true;
    const title = titleFromToolInput("Bash", "execute", { command });
    return {
      ...block,
      text: title,
      tool: { ...block.tool, title },
    };
  });
  return changed ? repaired : blocks;
}

/** Exec rows that were saved without their command, keyed by their tool call. */
function shellPlaceholderIds(blocks: Block[]): string[] {
  return blocks.flatMap((block) =>
    block.role === "tool" &&
    block.tool?.kind === "execute" &&
    block.text.trim() === "Shell" &&
    block.tool.callId
      ? [block.tool.callId]
      : [],
  );
}

/**
 * Relabel exec rows that were saved without their command.
 *
 * The command is already on the row: Codex sends it with the item, and
 * `shellCommandPreview` stores it as the preview title. Reading it back from
 * there keeps whatever Codex chose to show the user — including anything it
 * redacted — and never re-reads a secret off disk into the transcript store. A
 * row saved without a usable preview has no command left to recover, so it keeps
 * its placeholder label.
 */
export function backfillCodexShellCommands(blocks: Block[]): Block[] {
  let changed = false;
  const repaired = blocks.map((block) => {
    if (
      block.role !== "tool" ||
      block.tool?.kind !== "execute" ||
      block.text.trim() !== "Shell"
    ) {
      return block;
    }
    const saved = block.tool.preview?.title?.trim();
    if (!saved || isWeakToolTitle(saved)) return block;
    changed = true;
    const { title, preview } = codexCommandPresentation({}, saved);
    return {
      ...block,
      text: title,
      tool: {
        ...block.tool,
        title,
        ...(preview ? { preview } : {}),
      },
    };
  });
  return changed ? repaired : blocks;
}

export async function deleteSession(
  sessionId: string,
  imagePaths: string[] = [],
): Promise<void> {
  deletedSessionIds.add(sessionId);
  try {
    // A lead with workers still has writes in flight. Finish those before
    // the deletion transaction strips their ownership metadata.
    const pendingWrites = [...sessionWriteQueues.entries()]
      .filter(
        ([queuedSessionId]) =>
          queuedSessionId === sessionId ||
          sessionWriteLeadById.get(queuedSessionId) === sessionId,
      )
      .map(([, pending]) => pending);
    if (pendingWrites.length > 0) await Promise.all(pendingWrites);
    await enqueueSessionWrite(sessionId, () =>
      invoke<void>("session_delete", { sessionId, imagePaths }),
    );
    monoSavedBlocks.delete(sessionId);
    // A deleted session is no longer a Mono's running or Done work (the Sessions badge counts those marks).
    forgetWorkSession(sessionId);
    // What the harness kept for this chat past forgetting it (a goal for a rotation) has nothing left to serve.
    dropHarnessSession(sessionId);
    const tombstone = setTimeout(
      () => deletedSessionIds.delete(sessionId),
      60_000,
    );
    if (typeof tombstone === "object") tombstone.unref();
  } catch (error) {
    deletedSessionIds.delete(sessionId);
    throw error;
  }
}

/** Delete a draft-only record while allowing its still-open blank session id to be saved later. */
export async function discardDraftSessionRecord(
  sessionId: string,
): Promise<void> {
  await enqueueSessionWrite(sessionId, () =>
    invoke<void>("session_delete", { sessionId, imagePaths: [] }),
  );
  monoSavedBlocks.delete(sessionId);
}

export async function setSessionArchived(
  sessionId: string,
  archived: boolean,
): Promise<void> {
  await enqueueSessionWrite(sessionId, () =>
    invoke<void>("session_set_archived", { sessionId, archived }),
  );
}

export async function setSessionPinned(
  sessionId: string,
  pinned: boolean,
): Promise<void> {
  await invoke<void>("session_set_pinned", { sessionId, pinned });
}

/** WP-111: the private flag, on its own so a transcript save cannot clear it. A miss is tried again. */
export async function setSessionPrivate(
  sessionId: string,
  on: boolean,
  boundaryId?: string,
): Promise<void> {
  await enqueueSessionWrite(sessionId, async () => {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await invoke<void>("session_set_private", {
          sessionId,
          privateChat: on,
          privateBoundaryId: boundaryId && boundaryId.length > 0 ? boundaryId : null,
        });
        return;
      } catch (error) {
        last = error;
      }
    }
    throw last instanceof Error ? last : new Error("Couldn't update this chat.");
  });
}

export async function setSessionLinkedWorkItem(
  sessionId: string,
  value: LinkedWorkItem | undefined,
): Promise<void> {
  const linkedWorkItem = sanitizeLinkedWorkItem(value);
  await enqueueSessionWrite(sessionId, () =>
    invoke<void>("session_set_linked_work_item", {
      sessionId,
      linkedWorkItem: linkedWorkItem ?? null,
    }),
  );
}

/** Drain pending saves before a worktree removal changes stored session context. */
export async function flushSessionWrites(): Promise<void> {
  await Promise.all([...sessionWriteQueues.values()]);
}

/**
 * `session_set_in_flight` runs off the main thread, so two replaces could
 * otherwise land in either order and restore a stale busy snapshot.
 */
let inFlightWrite: Promise<unknown> = Promise.resolve();

export async function replaceInFlightSessions(
  refs: InFlightRef[],
): Promise<void> {
  const run = inFlightWrite
    .catch(() => undefined)
    .then(() =>
      invoke("session_set_in_flight", {
        sessions: refs.map((ref) => ({
          sessionId: ref.sessionId,
          cwd: normalizeProjectPath(ref.cwd),
          background: ref.background ?? [],
          resumes: ref.resumes ?? 0,
        })),
      }),
    );
  inFlightWrite = run;
  await run;
}

/**
 * One chat leaves the quit snapshot (it stopped resuming itself after restarts). Queued behind any replace, so a
 * replace already on its way can't bring it back.
 */
export async function dropInFlightSession(sessionId: string): Promise<void> {
  const run = inFlightWrite
    .catch(() => undefined)
    .then(() => invoke("session_drop_in_flight", { sessionId }));
  inFlightWrite = run;
  await run;
}

type InFlightRow = {
  sessionId: string;
  cwd: string;
  background?: CutWork[];
  resumes?: number;
};

/** The row as the app keeps it: no empty list, no zero count. */
function inFlightRef(row: InFlightRow): InFlightRef {
  const background = Array.isArray(row.background) ? row.background : [];
  const resumes =
    typeof row.resumes === "number" && row.resumes > 0 ? row.resumes : 0;
  return {
    sessionId: row.sessionId,
    cwd: row.cwd,
    ...(background.length ? { background } : {}),
    ...(resumes ? { resumes } : {}),
  };
}

/** Kept across Vite reloads; boot must not delete the only copy. */
export async function listInFlightSessions(): Promise<InFlightRef[]> {
  const rows = await invoke<InFlightRow[]>("session_list_in_flight");
  return Array.isArray(rows) ? rows.map(inFlightRef) : [];
}

/** Destructive: the first window to boot after a quit owns these chats. */
export async function takeInFlightSessions(): Promise<InFlightRef[]> {
  const rows = await invoke<InFlightRow[]>("session_take_in_flight");
  return Array.isArray(rows) ? rows.map(inFlightRef) : [];
}

/**
 * `workspace_set_snapshot` runs off the main thread, so two saves could
 * otherwise finish out of order and keep an older layout.
 */
let workspaceWrite: Promise<unknown> = Promise.resolve();

export async function saveWorkspaceSnapshot(snapshot: unknown): Promise<void> {
  const run = workspaceWrite
    .catch(() => undefined)
    .then(() => invoke("workspace_set_snapshot", { snapshot }));
  workspaceWrite = run;
  await run;
}

export async function loadWorkspaceSnapshot(): Promise<unknown | null> {
  const raw = await invoke<unknown | null>("workspace_get_snapshot");
  return raw ?? null;
}

function sanitizeBlock(
  block: Block,
  options?: { hydrate?: boolean },
): Block | null {
  // r63: a CLI notice saved before the filter (cliNotices.ts) is left out when the chat loads.
  if (options?.hydrate && block.role === "system" && !block.notice && isCliNotice(block.text)) return null;
  const next: Block = {
    id: block.id,
    role: block.role,
    text: block.text,
  };
  if (block.attachments?.length) {
    next.attachments = block.attachments.map(persistableAttachment);
  }
  const image = sanitizeGeneratedImage(block.image);
  if (block.role === "image" && !image) return null;
  if (image) next.image = image;
  if (block.startedAt != null) next.startedAt = block.startedAt;
  if (block.durationMs != null) next.durationMs = block.durationMs;
  if (
    (block.role === "assistant" || block.role === "approval") &&
    typeof block.monoHabit?.id === "string" &&
    block.monoHabit.id.trim() &&
    typeof block.monoHabit.name === "string" &&
    block.monoHabit.name.trim() &&
    typeof block.monoHabit.at === "number" &&
    Number.isFinite(block.monoHabit.at)
  ) {
    next.monoHabit = {
      id: block.monoHabit.id,
      name: block.monoHabit.name,
      at: block.monoHabit.at,
    };
  }
  if (block.monoCard && typeof block.monoCard === "object") {
    try {
      next.monoCard = parseCard(block.monoCard as unknown as Record<string, unknown>);
    } catch {
      // A card that doesn't parse is dropped. The words stay.
    }
  }
  // WP-123: the last message copied into a fork; its next send carries the recap until a turn is taken.
  if (block.forkPoint === true) next.forkPoint = true;
  if (block.role === "user" && typeof block.sentAt === "number")
    next.sentAt = block.sentAt;
  const turnModel = sanitizeTurnModel(block.turnModel);
  if (block.role === "user" && turnModel) next.turnModel = turnModel;
  if (block.role === "user" && block.draft) next.draft = true;
  if (block.role === "user" && block.monocode) next.monocode = true;
  if (
    block.role === "user" &&
    (block.intent === "plan" || block.intent === "orchestrate")
  )
    next.intent = block.intent;
  if (
    block.role === "user" &&
    typeof block.appRequestId === "string" &&
    /^[A-Za-z0-9_-]{1,512}$/.test(block.appRequestId)
  )
    next.appRequestId = block.appRequestId;
  if (
    block.role === "user" &&
    typeof block.providerTurnId === "string" &&
    isPersistableId(block.providerTurnId)
  )
    next.providerTurnId = block.providerTurnId;
  if (
    block.role === "user" &&
    typeof block.orchestrationLeadId === "string" &&
    isPersistableId(block.orchestrationLeadId)
  )
    next.orchestrationLeadId = block.orchestrationLeadId;
  // Without this the transcript would show the app's orchestration turns as
  // the user's own after a reload.
  if (block.role === "user" && block.internal) next.internal = true;
  // WP-243: Ash typed it himself. Only exactly `true`, and never on a hidden turn.
  if (block.role === "user" && block.byOwner === true && !block.internal) next.byOwner = true;
  // WP-243: a withdrawn turn stays withdrawn after a restart.
  if (block.role === "user" && (block.withdrawn === "stopped" || block.withdrawn === "failed")) next.withdrawn = block.withdrawn;
  const completion = sanitizeMonoSessionCompletion(block.monoSessionCompletion);
  if (block.role === "user" && block.internal && completion)
    next.monoSessionCompletion = completion;
  const check = sanitizeMonoCheck(block.monoCheck);
  if (block.role === "user" && block.internal && check) next.monoCheck = check;
  const note = sanitizeMonoNote(block.monoNote);
  if (block.role === "user" && block.internal && note) next.monoNote = note;
  const spawned = sanitizeMonoSpawnedSessions(block.monoSpawnedSessions);
  if (block.role === "user" && spawned.length)
    next.monoSpawnedSessions = spawned;
  const turnMetrics = sanitizeTurnMetrics(block.turnMetrics);
  if (block.role === "user" && turnMetrics) next.turnMetrics = turnMetrics;
  if (block.tool) next.tool = block.tool;
  if (block.approval?.decided) {
    const covered = block.approval.coveredBy;
    next.approval = {
      requestId: block.approval.requestId,
      decided: block.approval.decided,
      // WP-243: the words that allowed it, kept so "Because you said" survives a restart.
      ...(block.approval.decided === "allow" &&
      covered &&
      (covered.source === "message" || covered.source === "rule" || covered.source === "routine") &&
      typeof covered.quote === "string" &&
      covered.quote.trim()
        ? { coveredBy: { source: covered.source, quote: covered.quote.slice(0, 300) } }
        : {}),
    };
  } else if (block.approval && !block.approval.decided) {
    // Drop stale live approval prompts; request ids don't survive restarts.
    if (block.role === "approval") return null;
  }
  const agentRun = sanitizeAgentRun(block.agentRun);
  if (agentRun) next.agentRun = agentRun;
  const workflowRun = parseWorkflowRun(block.workflowRun, {
    hydrate: options?.hydrate === true,
  });
  if (block.tool && workflowRun) next.workflowRun = workflowRun;
  const taskList = sanitizeTaskList(block.taskList);
  if (taskList) next.taskList = taskList;
  else if (block.role === "tasks") return null;
  const plan = sanitizePlan(block.plan, block.text);
  if (block.orchestration)
    next.orchestration = restoreOrchestrationProposal(block.orchestration);
  if (plan) next.plan = plan;
  else if (block.role === "plan") {
    next.plan = { status: "ready", originalText: block.text };
  }
  const handoff = sanitizeHandoff(block.handoff);
  if (handoff) next.handoff = handoff;
  else if (block.role === "handoff") return null;
  const secondOpinion = sanitizeSecondOpinion(block.secondOpinion);
  if (secondOpinion) next.secondOpinion = secondOpinion;
  if (block.role === "user") {
    const btwThreads = sanitizeBtwThreads(
      block.btwThreads,
      options?.hydrate === true,
    );
    if (btwThreads) next.btwThreads = btwThreads;
  }
  const noteCard = sanitizeNoteCard(block.noteCard);
  if (noteCard) next.noteCard = noteCard;
  if (Array.isArray(block.artifactCards)) {
    const cards = block.artifactCards.flatMap((card) => {
      if (
        !card ||
        !ARTIFACT_KINDS.includes(card.kind) ||
        typeof card.id !== "string" ||
        !isPersistableId(card.id) ||
        typeof card.title !== "string" ||
        !card.title.trim()
      )
        return [];
      return [
        {
          id: card.id,
          kind: card.kind,
          title: card.title.slice(0, 200),
          ...(typeof card.summary === "string" && card.summary.trim()
            ? { summary: card.summary.slice(0, 280) }
            : {}),
        },
      ];
    });
    if (cards.length) next.artifactCards = cards;
  }
  if (
    block.role === "user" &&
    typeof block.ciContext === "string" &&
    block.ciContext
  ) {
    next.ciContext = block.ciContext;
  }
  // Interjection chrome survives restarts only on system blocks; a malformed
  // payload keeps the ordinary system row rather than losing its body.
  if (block.role === "system") {
    const interjection = sanitizeInterjection(block.interjection);
    if (interjection) next.interjection = interjection;
    if (
      block.notice === "error" ||
      block.notice === "interrupt" ||
      block.notice === "resume-stopped" ||
      block.notice === "recovered" ||
      block.notice === "still-running" ||
      block.notice === "account-moved" ||
      block.notice === "waiting-on-you" ||
block.notice === "teleported" ||
block.notice === "teleported-back" ||
block.notice === "teleport-frozen" ||
block.notice === "teleport-incoming" ||
block.notice === "teleport-aborted" ||
      block.notice === "teleport-release-owed" ||
      block.notice === "teleport-freeze-asked"
    ) {
      next.notice = block.notice;
    }
    const still = block.stillRunning;
    if (
      block.notice === "still-running" &&
      Array.isArray(still?.taskIds) &&
      still.taskIds.length <= 50 &&
      still.taskIds.every((id) => typeof id === "string" && isPersistableId(id)) &&
      (still.briefId === undefined || (typeof still.briefId === "string" && isPersistableId(still.briefId)))
    )
      next.stillRunning = {
        taskIds: [...still.taskIds],
        ...(still.briefId !== undefined ? { briefId: still.briefId } : {}),
      };
    // Why a turn failed (turnFailure.ts): the rail, Today and Being built keep showing it after a restart.
    const failure = block.failure;
    if (block.notice === "error" && failure && typeof failure === "object") {
      const kept = {
        ...(isProviderErrorClass(failure.errorClass) ? { errorClass: failure.errorClass } : {}),
        ...(typeof failure.retryable === "boolean" ? { retryable: failure.retryable } : {}),
        ...(sanitizeTimestamp(failure.resetsAt) !== undefined ? { resetsAt: sanitizeTimestamp(failure.resetsAt) } : {}),
        ...(sanitizeTimestamp(failure.at) !== undefined ? { at: sanitizeTimestamp(failure.at) } : {}),
      };
      if (Object.keys(kept).length) next.failure = kept;
    }
    // The ship whose restart cut the turn: the resume carries its receipt (src-tauri/src/ship.rs).
    if (
      block.notice === "interrupt" &&
      typeof block.shipUpdate === "string" &&
      /^[A-Za-z0-9._-]{1,96}$/.test(block.shipUpdate)
    ) {
      next.shipUpdate = block.shipUpdate;
    }
  }
  return next;
}

function sanitizeNestedId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  if (!id || id.length > 256 || /[\u0000-\u001f]/.test(id)) return undefined;
  return id;
}
function sanitizeStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const safeKey = sanitizeNestedId(key);
    const safeValue = sanitizeNestedId(raw);
    if (safeKey && safeValue) next[safeKey] = safeValue;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function sanitizeTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function sanitizeBtwMessage(value: unknown): BtwMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = sanitizeNestedId(record.id);
  const text = typeof record.text === "string" ? record.text : undefined;
  const createdAt = sanitizeTimestamp(record.createdAt);
  const role =
    record.role === "user" || record.role === "assistant"
      ? record.role
      : undefined;
  if (!id || text == null || createdAt == null || !role) return undefined;
  const blocks = Array.isArray(record.blocks)
    ? record.blocks.flatMap((block) => {
        const next = sanitizeBlock(block as Block);
        return next ? [next] : [];
      })
    : [];
  return {
    id,
    role,
    text,
    createdAt,
    ...(blocks.length > 0 ? { blocks } : {}),
  };
}

function sanitizeBtwThreads(
  value: unknown,
  hydrate: boolean,
): BtwThread[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const threads = value.flatMap((entry): BtwThread[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const id = sanitizeNestedId(record.id);
    const sourceEndBlockId = sanitizeNestedId(record.sourceEndBlockId);
    const createdAt = sanitizeTimestamp(record.createdAt);
    const updatedAt = sanitizeTimestamp(record.updatedAt);
    const status =
      record.status === "running" ||
      record.status === "ready" ||
      record.status === "error"
        ? record.status
        : undefined;
    const messages = Array.isArray(record.messages)
      ? record.messages.flatMap((message) => {
          const next = sanitizeBtwMessage(message);
          return next ? [next] : [];
        })
      : [];
    if (
      !id ||
      !sourceEndBlockId ||
      createdAt == null ||
      updatedAt == null ||
      !status ||
      messages.length === 0
    ) {
      return [];
    }
    const error = typeof record.error === "string" ? record.error.trim() : "";
    const model = typeof record.model === "string" ? record.model.trim() : "";
    const harness =
      typeof record.harness === "string" &&
      record.harness.trim() &&
      HARNESSES.includes(record.harness as HarnessId)
        ? (record.harness as HarnessId)
        : undefined;
    const modelSettings = sanitizeStringRecord(record.modelSettings);
    const providerThreadId = sanitizeNestedId(record.providerThreadId);
    const interrupted = hydrate && status === "running";
    return [
      {
        id,
        sourceEndBlockId,
        createdAt,
        updatedAt,
        status: interrupted ? "error" : status,
        messages,
        ...(harness ? { harness } : {}),
        ...(model ? { model } : {}),
        ...(modelSettings ? { modelSettings } : {}),
        ...(providerThreadId ? { providerThreadId } : {}),
        ...(interrupted
          ? {
              error:
                error ||
                "This by-the-way request was interrupted before reload.",
            }
          : error
            ? { error }
            : {}),
      },
    ];
  });
  return threads.length > 0 ? threads : undefined;
}

function sanitizeGeneratedImage(
  value: unknown,
): GeneratedImageMeta | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  // An empty path is kept: it says the picture's file is not on this Mac (a chat imported from another one).
  const path = typeof record.path === "string" ? record.path.trim() : null;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const mimeType =
    typeof record.mimeType === "string" ? record.mimeType.trim() : "";
  const size = record.size;
  if (
    path === null ||
    !name ||
    !mimeType.startsWith("image/") ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size <= 0
  ) {
    return undefined;
  }
  const alt = typeof record.alt === "string" ? record.alt.trim() : "";
  return {
    path,
    name,
    mimeType,
    size,
    ...(alt ? { alt } : {}),
  };
}

function sanitizeTurnMetrics(value: unknown): TurnMetrics | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const rec = value as Record<string, unknown>;
  const number = (key: keyof TurnMetrics): number | undefined => {
    const candidate = rec[key];
    return typeof candidate === "number" &&
      Number.isFinite(candidate) &&
      candidate >= 0
      ? candidate
      : undefined;
  };
  const metrics: TurnMetrics = {
    ...(number("inputTokens") != null
      ? { inputTokens: number("inputTokens") }
      : {}),
    ...(number("outputTokens") != null
      ? { outputTokens: number("outputTokens") }
      : {}),
    ...(number("cacheReadTokens") != null
      ? { cacheReadTokens: number("cacheReadTokens") }
      : {}),
    ...(number("cacheWriteTokens") != null
      ? { cacheWriteTokens: number("cacheWriteTokens") }
      : {}),
    ...(number("cacheHitPercent") != null
      ? { cacheHitPercent: number("cacheHitPercent") }
      : {}),
    // WP-108: the CLI's own price, kept only when it is a usable number.
    ...(number("costUsd") != null ? { costUsd: number("costUsd") } : {}),
  };
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

function sanitizeTurnModel(value: unknown): TurnModel | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const harness = record.harness;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (
    typeof harness !== "string" ||
    !HARNESSES.includes(harness as HarnessId) ||
    !id ||
    !name
  ) {
    return undefined;
  }
  return { harness: harness as HarnessId, id, name };
}

function sanitizeInterjection(
  value: Block["interjection"],
): InterjectionMeta | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const customType =
    typeof record.customType === "string" ? record.customType.trim() : "";
  if (!customType) return undefined;
  const severity = record.severity;
  return {
    customType,
    ...(severity === "nit" || severity === "concern" || severity === "blocker"
      ? { severity }
      : {}),
  };
}

function sanitizePlan(value: unknown, text: string): PlanBlockMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (
    status !== "streaming" &&
    status !== "ready" &&
    status !== "building" &&
    status !== "built"
  ) {
    return null;
  }
  const key = typeof record.key === "string" ? record.key.trim() : "";
  const originalText =
    typeof record.originalText === "string" ? record.originalText : text;
  const approvedText =
    typeof record.approvedText === "string" ? record.approvedText : "";
  return {
    ...(key ? { key } : {}),
    // A restarted app cannot still be executing this approval.
    status: status === "streaming" || status === "building" ? "ready" : status,
    ...(originalText ? { originalText } : {}),
    ...(approvedText ? { approvedText } : {}),
    ...(record.edited === true ? { edited: true } : {}),
  };
}

/**
 * How much of a delegated run's trail a saved session keeps. Reopening a
 * session is for reading what the subagent concluded, not for replaying every
 * call it made, and a long run would otherwise dominate the snapshot.
 */
const PERSISTED_AGENT_STEPS = 100;

function sanitizeAgentRun(value: unknown): AgentRunMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.steps)) return null;
  const steps = record.steps.flatMap((entry): AgentStep[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : "";
    const kind = row.kind;
    if (
      !id ||
      (kind !== "tool" && kind !== "message" && kind !== "reasoning")
    ) {
      return [];
    }
    const text = typeof row.text === "string" ? row.text : "";
    return [
      {
        id,
        kind,
        text,
        ...(typeof row.toolKind === "string" ? { toolKind: row.toolKind } : {}),
        ...(typeof row.status === "string" ? { status: row.status } : {}),
        ...(typeof row.detail === "string" ? { detail: row.detail } : {}),
        ...(row.detailOmitted === true && typeof row.detail !== "string"
          ? { detailOmitted: true }
          : {}),
        ...(row.preview && typeof row.preview === "object"
          ? { preview: row.preview as AgentStep["preview"] }
          : {}),
      },
    ];
  });
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name && steps.length === 0) return null;
  return {
    name: name || "Subagent",
    ...(typeof record.model === "string" && record.model.trim()
      ? { model: record.model.trim() }
      : {}),
    ...(typeof record.agentType === "string" && record.agentType.trim()
      ? { agentType: record.agentType.trim() }
      : {}),
    steps: steps.slice(-PERSISTED_AGENT_STEPS),
  };
}

function sanitizeTaskList(value: unknown): TaskListMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.items)) return null;
  const items = record.items.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const text = typeof row.text === "string" ? row.text.trim() : "";
    const status = row.status;
    if (
      !text ||
      (status !== "pending" &&
        status !== "in_progress" &&
        status !== "completed" &&
        status !== "cancelled")
    ) {
      return [];
    }
    const id =
      typeof row.id === "string"
        ? row.id.trim()
        : typeof row.id === "number" && Number.isFinite(row.id)
          ? String(row.id)
          : "";
    return [
      { ...(id ? { id } : {}), text, status },
    ] satisfies TaskListMeta["items"];
  });
  if (items.length === 0) return null;
  const key = typeof record.key === "string" ? record.key.trim() : "";
  const providerSessionId =
    typeof record.providerSessionId === "string"
      ? record.providerSessionId.trim()
      : "";
  const explanation =
    typeof record.explanation === "string" ? record.explanation.trim() : "";
  return {
    ...(key ? { key } : {}),
    ...(providerSessionId ? { providerSessionId } : {}),
    ...(explanation ? { explanation } : {}),
    items,
  };
}

function normalizeSummary(summary: SessionSummary): SessionSummary {
  const linkedWorkItem = sanitizeLinkedWorkItem(summary.linkedWorkItem);
  return {
    ...summary,
    harness: asHarness(summary.harness),
    ...(typeof summary.model === "string"
      ? { model: readRetiredGrokModel(summary.model, defaultModelId("claude")) }
      : {}),
    runtimeMode: asRuntimeMode(summary.runtimeMode),
    ...(summary.providerSessionId
      ? { providerSessionId: summary.providerSessionId }
      : {}),
    ...(summary.branch ? { branch: summary.branch } : {}),
    ...(summary.repo ? { repo: summary.repo } : {}),
    additions: summary.additions ?? 0,
    deletions: summary.deletions ?? 0,
    archived: summary.archived || undefined,
    pinned: summary.pinned || undefined,
    draft: summary.draft || undefined,
    sidebarHidden: summary.sidebarHidden === true || undefined,
    private: summary.private === true || undefined,
    linkedWorkItem,
    ...(typeof summary.automationId === "string" &&
    isPersistableId(summary.automationId)
      ? { automationId: summary.automationId }
      : {}),
  };
}

function recordToSession(record: SessionRecord): Session {
  const blocks = Array.isArray(record.blocks)
    ? record.blocks
        .map((block) => sanitizeBlock(block, { hydrate: true }))
        .filter((block): block is Block => block != null)
    : [];
  const linkedWorkItem = sanitizeLinkedWorkItem(record.linkedWorkItem);
  const queuedMessages = sanitizeQueuedMessages(record.queuedMessages);
  const goal = openGoal(record.goal);
  // WP-134: the entry id is on the row. Browser storage is not read. The stored harness stays one of the eleven.
  const registryAgentId = registryAgentFromRow(record.registryAgentId);
  return {
    id: record.id,
    sidebarHidden: record.sidebarHidden === true || undefined,
    private: record.private === true || undefined,
    ...(boundaryFromDisk(record.privateBoundaryId)
      ? { privateBoundaryId: boundaryFromDisk(record.privateBoundaryId) }
      : {}),
    cwd: record.cwd,
    harness: asHarness(record.harness),
    ...(registryAgentId ? { registryAgentId } : {}),
    // WP-16: the retired Grok model id reads as the default Claude model. Nothing is written back.
    model: readRetiredGrokModel(record.model, defaultModelId("claude")),
    modelSettings:
      record.modelSettings && typeof record.modelSettings === "object"
        ? record.modelSettings
        : {},
    runtimeMode: asRuntimeMode(record.runtimeMode),
    title: record.title,
    blocks,
    // A restart interrupted the active turn: Ash resumes his own pending messages; what the app queued (briefs other
    // chats sent, a Mono's reports) goes in by itself once the chat is idle again (messageQueue.restoredQueue).
    ...restoredQueue(queuedMessages, blocks, {
      status: record.queueStatus,
      archived: record.archived === true,
    }),
    // Its /goal, if one was still open: the Goal row is back, and the harness carries on with it once bound.
    ...(goal ? { goal } : {}),
    ...(record.moveBriefOwed === true ? { moveBriefOwed: true } : {}),
    ...(typeof record.movedFrom === "string" && record.movedFrom.trim()
      ? { movedFrom: record.movedFrom.trim().slice(0, 200) }
      : {}),
    ...(record.monoTranscript ? { monoTranscript: record.monoTranscript } : {}),
    busy: false,
    orchestrationLeadId:
      record.orchestrationLeadId ??
      blocks.find(
        (block) =>
          block.orchestrationLeadId && block.orchestrationLeadId !== record.id,
      )?.orchestrationLeadId,
    ...(record.providerSessionId
      ? { providerSessionId: record.providerSessionId }
      : {}),
    ...(record.providerAccountId
      ? { providerAccountId: record.providerAccountId }
      : {}),
    ...(record.branch ? { branch: record.branch } : {}),
    ...(record.worktreeCwd ? { worktreeCwd: record.worktreeCwd } : {}),
    ...(record.worktreeRemoved ? { worktreeRemoved: true } : {}),
    ...(linkedWorkItem ? { linkedWorkItem } : {}),
    ...(record.automationId && isPersistableId(record.automationId)
      ? { automationId: record.automationId }
      : {}),
    ...(contextFromRecord(record) ?? {}),
  };
}

/**
 * Last known reading from a stored session. The harness re-reports on the next
 * turn, so this only has to survive until then.
 */
function contextFromRecord(
  record: SessionRecord,
): { context: ContextUsage } | undefined {
  const used = record.contextUsed;
  if (typeof used !== "number" || !Number.isFinite(used) || used <= 0) {
    return undefined;
  }
  const window = record.contextWindow;
  return {
    context:
      typeof window === "number" && Number.isFinite(window) && window > 0
        ? { used, window }
        : { used },
  };
}

function asHarness(value: string): HarnessId {
  return (HARNESSES as string[]).includes(value)
    ? (value as HarnessId)
    : "cursor";
}

const HANDOFF_STATUSES: HandoffStatus[] = ["preparing", "ready"];

function sanitizeHandoff(value: Block["handoff"]): HandoffMeta | undefined {
  if (!value) return undefined;
  if (!(HARNESSES as string[]).includes(value.from)) return undefined;
  if (!(HARNESSES as string[]).includes(value.to)) return undefined;
  if (!HANDOFF_STATUSES.includes(value.status)) return undefined;
  const interrupted = value.status === "preparing";
  return {
    from: value.from,
    to: value.to,
    status: "ready",
    pending: interrupted || !!value.pending,
  };
}

function sanitizeSecondOpinion(
  value: Block["secondOpinion"],
): SecondOpinionMeta | undefined {
  if (!value) return undefined;
  if (!(HARNESSES as string[]).includes(value.from)) return undefined;
  if (!(HARNESSES as string[]).includes(value.to)) return undefined;
  const request =
    typeof value.request === "string" ? value.request.trim().slice(0, 240) : "";
  const files =
    typeof value.files === "number" && Number.isFinite(value.files)
      ? Math.max(0, Math.round(value.files))
      : 0;
  return {
    from: value.from,
    to: value.to,
    ...(request ? { request } : {}),
    ...(files > 0 ? { files } : {}),
    ...(value.kind === "handoff" ? { kind: "handoff" as const } : {}),
  };
}

function sanitizeNoteCard(value: Block["noteCard"]): Block["noteCard"] {
  if (!value || typeof value !== "object") return undefined;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id) return undefined;
  const slug = typeof value.slug === "string" ? value.slug.trim() : "";
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const sourceCwd =
    typeof value.sourceCwd === "string" ? value.sourceCwd.trim() : "";
  return {
    id,
    slug,
    title,
    ...(sourceCwd ? { sourceCwd } : {}),
  };
}

function asRuntimeMode(value: string): RuntimeMode {
  return (RUNTIME_MODES as string[]).includes(value)
    ? (value as RuntimeMode)
    : "supervised";
}
