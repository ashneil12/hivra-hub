import {
  hasProbedHarnessAvailability,
  isHarnessAvailable,
  probeHarnessAvailability,
} from "../../../integrations/harness/core/availability";

/**
 * Which CLIs are installed is unknown until the first probe ends, and every harness reads as missing before it. A
 * Lead that resumes right after a restart can call sessions.start in that window; it waits for the probe instead of
 * being told its own harness "is not available".
 */
async function harnessesProbed(): Promise<void> {
  if (!hasProbedHarnessAvailability()) await probeHarnessAvailability();
}
import { looksLikeProject } from "../../projects/model/recents";
import {
  isBridgeModelId,
  mergeModelSettings,
  modelEffortLabel,
  modelEffortSetting,
  modelsFor,
  preferredModelId,
  resolveModel,
} from "../../sessions/model/models";
import { claudeRunsOnSubscriptionBridge } from "../../../integrations/harness/providers/claude/claudeDeepseekBridge";
import type { CrewRule } from "../../crew/model/rules";
import { cleanCliFallback } from "../../crew/model/cliFallback";
import { cleanRanFrom } from "../../crew/model/workerChoice";
import type { Pick as WorkerPick } from "../../crew/model/resolve";
import { isCustomModelId } from "../../sessions/model/customModels";
import {
  HARNESSES,
  RUNTIME_MODE_HINT,
  RUNTIME_MODE_LABEL,
  RUNTIME_MODES,
  type HarnessId,
  type Session,
} from "../../sessions/model/session";
import { givesOrders, ORDER_REFUSAL } from "../../memory/model/orderScan";
import { isPrivateChat } from "../../memory/model/privateChat";
import {
  addSessionToFolder,
  createFolderWithSessions,
  loadSessionFolders,
  placeSessionInFolder,
  saveSessionFolders,
  setFolderCustomColor,
} from "../../sessions/model/sessionFolders";
import {
  normalizeNoteTags,
  noteTitle,
  type Note,
  type NoteUpsert,
} from "../../notes";
import {
  ARTIFACT_KINDS,
  type Artifact,
  type ArtifactCard,
  type ArtifactKind,
  type ArtifactUpsert,
} from "../../artifacts/artifacts";
import type { QuickLaunch } from "../../quick-composer/model/quickComposer";
import type { Worktree, Worktrees } from "../../source-control/model/worktrees";
import type {
  ActionRun,
  ActionsListing,
} from "../../projects/model/projectActions";
import { pathKey, projectName } from "../../../shared/lib/paths";
import type { SplitDir } from "../../workspace/model/layout";
import { consumeOperatorCommand } from "../../sessions/model/operatorCommand";
import { sessionConversationPage, type SessionReadOptions } from "./sessionConversation";
import {
  CARD_FIELDS,
  parseCard,
  type MonoCard,
} from "../../monos/model/monoCards";
import {
  HABITS_MAX,
  checkHabitsNow,
  habitRunningSince,
  habitSchedule,
  habitScheduleLabel,
  newHabit,
  nextHabitRunAt,
  type Habit,
} from "../../monos/model/monoHabits";
import {
  memoryWithinBudget,
  MonoFileConflict,
  type AgentFilePath,
  type MonoFiles,
} from "../../monos/model/monoFiles";
import {
  addMemoryEntry,
  archiveMemoryEntries,
  fitMemoryBudget,
  memoryDate,
  memoryEntry,
  memoryUseKey,
  removeMemoryEntry,
  searchMemory,
  sinceDate,
  supersedeMemoryEntry,
  topicName,
  type MemoryUse,
} from "../../monos/model/monoMemory";
import { parseDoc } from "../../memory/model/doc";
import { fadeNow, livedClockOf } from "../../memory/model/fade";
import { appIdentity, type AppIdentity } from "../../../app/model/appIdentity";
import {
  sendMode,
  type Delivery,
  type SendMode,
} from "../../monos/model/followedBriefs";
import {
  handleTasks,
  isAppDelegate,
  TASK_FIELDS,
  APP_DELEGATE_FIELDS,
  gateSessionStart,
  type AgentAppTasksHost,
  type DelegationMeta,
} from "./agentAppTasks";
import { handleTaskStore, isTaskStoreAction, TASK_STORE_FIELDS } from "../../tasks/model/agentTasks";
import { handleProgramme, isProgrammeAction, PROGRAMME_FIELDS } from "../../programme/model/programme";
import { handlePrs, PR_FIELDS, type AgentAppPrsHost } from "./agentAppPrs";
// WP-92: the vault's three actions (secrets.request, secrets.list, secrets.run).
import {
  handleSecrets,
  SECRET_FIELDS,
  type WorkerArmOutcome,
  type WorkerArmRequest,
} from "./agentAppSecrets";
import { handleTimers, TIMER_FIELDS, type AgentAppTimersHost } from "./agentAppTimers";
import { handleWorkLog, WORK_LOG_FIELDS, type WorkLogBackend } from "./agentAppWorkLog";
import { handleRooms, ROOM_FIELDS, type AgentAppRoomsHost } from "./agentAppRooms";
import { handleSelfBuild, SELF_BUILD_FIELDS } from "./agentAppSelfBuild";
import { DOC_FIELDS, handleDocs } from "./agentDocs";
import { handleActivity, handleMemoryRecall } from "../../chief/model/tools";
import { captainCanRead, captainHandoff, delegationId, filedTaskId, handoffGoal } from "../../chief/model/handoff";
import { hasCaptainCharter, isCaptainMono, withLockedRole } from "../../chief/model/charter";
import { recordNote } from "../../chief/model/notes";
import { checkBrief } from "../../firstmate/model/brief";
import type { DocCreateInput, DocRecord, DocUpdateInput, DocWriteResult } from "../../docs/gateway";

/** What a Mono hears if it reaches for the old proposal path. */
/** Hivra WP-10: the definition of done for a hub change's worker (its brief says what to build and check). */
export const SELF_BUILD_GOAL = "The change is made in the preview copy, the checks its brief names pass, and the report says how to see it.";

/** A handoff that filed and then failed to delegate, keyed by the host so a retry on that host reuses the task. */
const handoffOrphans = new WeakMap<object, Map<string, string>>();

function handoffMemory(host: object): {
  recall(key: string): string | undefined;
  remember(key: string, taskId: string): void;
  forget(key: string): void;
} {
  let kept = handoffOrphans.get(host);
  if (!kept) {
    kept = new Map();
    handoffOrphans.set(host, kept);
  }
  const box = kept;
  return {
    recall: (key) => box.get(key),
    remember: (key, id) => {
      box.set(key, id);
    },
    forget: (key) => {
      box.delete(key);
    },
  };
}

export const MONO_ONE_WAY = "There is one way to make a Mono: mono_create, in your chat with Ash. Draft it with him, he says yes, and it is made. Nothing is filed on Settings > Teams any more.";
import { CHECKER_MONO_ID } from "../../hub/model/hubMcp";
import { recordSelfWrite } from "../../hub/model/botChanges";
import { mergeSoul, readForMerge, type SoulMergeCaller } from "../../hub/model/soulMerge";
import type { SoulTemplate } from "../../hub/model/soulRefresh";
import { waitingOnAshLine } from "../../hub/model/chatQuestions";
import {
  AUTOPILOT_FIELDS,
  handleAutopilotApp,
} from "../../autopilot/model/autopilotApp";
import { forUser } from "../../hub/model/userName";
import { isReviewSession, REVIEW_REQUEST_PREFIX } from "../../security-review/model/launch";

export type AppSessionListing = {
  id: string;
  title: string;
  harness: HarnessId;
  model: string;
  busy: boolean;
  hasDraft: boolean;
  archived: boolean;
};

/** A brief the caller sent that waits in another chat's queue (sessions.queue). */
export type QueuedBrief = {
  sessionId: string;
  title: string;
  requestId: string;
  /** Its place in that chat's queue, from 1. */
  position: number;
  prompt: string;
};

export type AppSessionPlacement = {
  direction: SplitDir;
  besideSessionId: string;
};

export type AgentAppHost = {
  /** Tests and proofs: the skill names that exist (else the app's skill catalog for the Mono's folder). */
  installedSkills?: () => Promise<string[]>;
  start(
    launch: QuickLaunch,
    id: string,
    placement?: AppSessionPlacement,
    notifyMonoId?: string,
    /** A delegation (tasks.delegate): what its stored row records beyond a plain monitored launch. */
    delegation?: DelegationMeta,
  ): Promise<void>;
  sessions(cwd: string): Promise<AppSessionListing[]>;
  session(id: string): Promise<Session | null>;
  readConversation?(session: Session, options: SessionReadOptions): Promise<ReturnType<typeof sessionConversationPage>>;
  send(
    id: string,
    prompt: string,
    requestId: string,
    notifyMonoId?: string,
    /** A busy target: queue behind its work (auto, queue) or steer into it (steer). */
    mode?: SendMode,
  ): Promise<{ alreadySubmitted: boolean; delivery?: Delivery }>;
  /**
   * The briefs `caller` sent that still wait in a chat's queue (sessions.queue), in every project it reaches or one
   * session; `unqueue` takes one back out (its request id, as sessions.send got it).
   */
  queued?(caller: string, sessionId?: string): Promise<QueuedBrief[]>;
  unqueue?(caller: string, requestId: string): Promise<boolean>;
  draft(
    id: string,
    prompt: string,
    requestId: string,
  ): Promise<{ alreadySaved: boolean; draft: boolean }>;
  stop(id: string): Promise<void>;
  /**
   * `sessions.stop {"cascade":true}` (H4, monos/model/stopTree.ts): stop the session, then everything beneath it,
   * depth first, touching only rows owned by a chat it stopped. Returns the chats that would not stop.
   */
  stopTree?(id: string): Promise<{
    stopFailed: string[];
    stopped: string[];
    cancelled: string[];
    /** Chats whose workers couldn't be loaded, so they may still be running. */
    unloaded?: string[];
  }>;
  remove(id: string, mode: "archive" | "delete"): Promise<void>;
  worktrees(cwd: string): Promise<Worktrees>;
  createWorktree(
    cwd: string,
    branch: string,
    base: string,
    existing: boolean,
    options?: { runSetup?: boolean },
  ): Promise<Worktree>;
  /** The project's imported actions (.monocode/project.json) and recent runs. */
  projectActions?(cwd: string): Promise<ActionsListing>;
  /** WP-90: the same stack rows the stack card shows, names and fake services included. */
  stacks?(cwd: string): Promise<unknown>;
  /** Start one in a checkout of the project; returns at once. */
  runProjectAction?(checkoutCwd: string, actionId: string): Promise<ActionRun>;
  waitProjectAction?(runId: string, timeoutMs: number): Promise<ActionRun>;
  notes(): Promise<Note[]>;
  note(id: string): Promise<Note | null>;
  saveNote(note: NoteUpsert): Promise<Note>;
  artifacts?(): Promise<Artifact[]>;
  artifact?(id: string): Promise<Artifact | null>;
  saveArtifact?(artifact: ArtifactUpsert): Promise<Artifact>;
  postArtifact?(sourceSessionId: string, card: ArtifactCard): void | Promise<void>;
  /** Whether the session is a Mono's own conversation, which owns memory. */
  isMono(sessionId: string): boolean;
  /**
   * The Mono a session works for: its own conversation or one of its habit
   * runs. Its projects are the ones it may name with "project".
   */
  monoOf?(sessionId: string): {
    id: string;
    /** Its name, as briefs it sends are signed. */
    name?: string;
    projects: readonly string[];
    showStartedSessionsInSidebar?: boolean;
    /** Files the sessions it starts into a folder named after it. */
    folder?: { name: string; color: string };
    /**
     * Its own team's folder (hub/model/monoTeams.ts), once it has one: its own workers run there, so it may start, read
     * and steer sessions there as in its projects.
     */
    team?: string;
    /** WP-21: crew rules stored on this Mono. */
    crewRules?: CrewRule[];
    /** WP-88: the soul text and the person's switch. Scope stays off unless both say yes. */
    instructions?: string;
    everyProject?: boolean;
    /** WP-89: the worker default stored on this Mono. */
    workerDefault?: WorkerPick;
  } | undefined;
  /**
   * The Mono a session belongs to, workers included (hub/model/hubMcp.ts chatMonoOwner): a worker works as the Mono
   * that started it, so the skills it improves are that Mono's. `monoOf` answers only a Mono's own chat and habit
   * runs; this is not widened to them because a worker may not write a soul or memory.
   */
  ownerMonoOf?(sessionId: string): string | undefined;
  /** A Mono's name by id, for the Bot changes rows its own writes leave (D1). */
  monoNameOf?(monoId: string): string | undefined;
  /** A hidden run of one of a Mono's habits: it may remember, not schedule. */
  isHabitRun?(sessionId: string): boolean;
  /** A Mono's long chat (monoTreeStore.ts), when it has "Keep one long chat" on. */
  tree?: {
    on(monoId: string): boolean;
    zoom(monoId: string, id: number, n: number, at: number): Promise<string>;
    date(monoId: string, id: number): Promise<string>;
  };
  /** Puts a card in the Mono's chat, or holds it for a habit run's report. */
  postCard?(sourceSessionId: string, card: MonoCard): void;
  /** WP-89: one line in the activity log. Absent in a build that has no log. */
  noteActivity?(entry: {
    kind: string;
    summary: string;
    project: string;
    target: string;
    actorId: string;
    actorName: string;
  }): void;
  habits?: {
    load(monoId: string): Promise<Habit[]>;
    update<T>(
      monoId: string,
      change: (habits: Habit[]) => { habits: Habit[]; result: T },
    ): Promise<T>;
  };
  agentFiles(monoId: string): Promise<MonoFiles>;
  readAgentFile(
    monoId: string,
    path: AgentFilePath,
  ): Promise<{ text: string | null; hash: string }>;
  /** Throws `MonoFileConflict` when the file moved past `hash`. */
  writeAgentFile(
    monoId: string,
    path: AgentFilePath,
    text: string,
    hash: string,
  ): Promise<string>;
  /** The clock entries are dated by; tests pin it. */
  now?(): Date;
  /** The app's soul for each Mono that has one (soulRefresh.ts soulTemplates); tests pass their own. */
  soulTemplates?(): SoulTemplate[];
  /** This app's identity and build stamp; defaults to what the app injected into the window. */
  identity?(): AppIdentity | null;
  /**
   * `app.ship` (src-tauri/src/ship.rs): check, stage and schedule the build in `repo` for the daily app, on behalf of
   * `requestedBy`. Resolves within seconds with the ship's id; rejects with why it was refused.
   */
  ship?(input: {
    repo: string;
    requestedBy: string;
    whenBusy?: "wait" | "restart";
  }): Promise<unknown>;
  /** The newest ship and its receipt, reported by app.version. */
  shipStatus?(): unknown;
  /**
   * The project whose coding team this chat is in (hub/model/codingTeam.ts): an orchestrator like the project's Lead,
   * which delegates and watches pull requests from its own chat. Undefined for a Mono's chat, a worker or another chat.
   */
  codingTeamOf?(sessionId: string): { project: string; name: string; folder: string } | undefined;
  /** The delegate tool's task rows (agentAppTasks.ts); a Mono's own chat or a coding-team chat only. */
  tasks?: AgentAppTasksHost;
  /** WP-88: projects on this copy. A Mono that reads every project cannot name one that is not here. */
  knownProjects?: () => readonly { id: string; name: string; folder: string | null }[];
  /** WP-88: the activity log. The handler sets the project; the model cannot widen it. */
  activityList?: (query: Record<string, unknown>) => Promise<unknown>;
  /** WP-88: reviewed memory for recall. Writes stay on memory.add. */
  memoryDoc?: () => Promise<unknown>;
  /** WP-100: the facts a Mono read through memory.recall are used, so they are topped up. A miss is not final. */
  markMemoryUsed?: (ids: readonly string[], at: number) => Promise<unknown>;
  /** WP-88: mate ids on this copy, for a wide recall. */
  mateIds?: () => readonly string[];
  /** WP-70: the shared task list. The handler sets who is asking; the model cannot. */
  taskStore?(
    command: "tasks_list" | "tasks_get" | "tasks_create" | "tasks_update",
    args: {
      actor: { id: string; project: string; kind: "agent" };
      project?: unknown;
      id?: string;
      input?: Record<string, unknown>;
    },
  ): Promise<unknown>;
  /** WP-159: the programme board. The handler sets who is asking; the model cannot. */
  programmeStore?(
    command: "programme_list" | "programme_enqueue" | "programme_set_status" | "programme_park",
    args: {
      actor: { id: string; project: string; kind: "first-mate" };
      input?: Record<string, unknown>;
    },
  ): Promise<unknown>;
  /** The PR watch (agentAppPrs.ts, src-tauri/src/pr_watch); a Mono's own chat or a coding-team chat only. */
  prs?: AgentAppPrsHost;
  /** Hivra WP-11: timers a first mate sets (agentAppTimers.ts); the app's own store when absent. */
  timers?: AgentAppTimersHost;
  /** WP-157: the work log. The app's own store when absent. */
  workLog?: WorkLogBackend;
  /**
   * WP-92: a delegated worker's keys (`delegate_task`'s `secrets`). Rust checks each name, asks the person where
   * needed, and arms the handles for the child session; no value crosses to this side.
   */
  secretsWorkerArm?(sessionId: string, request: WorkerArmRequest): Promise<WorkerArmOutcome>;
  /**
   * The rooms (agentAppRooms.ts): private messages between Monos, and `delegated`, told of each delegation so work
   * started from a room comes back to it.
   */
  rooms?: AgentAppRoomsHost & { delegated?(source: Session, result: unknown): void };
  /** WP-72: docs are notes. Page text comes back as data, never as instructions. */
  docs?: {
    list: () => Promise<DocRecord[]>;
    get: (id: string) => Promise<DocRecord | null>;
    create: (page: DocCreateInput) => Promise<DocWriteResult>;
    update: (page: DocUpdateInput) => Promise<DocWriteResult>;
  };
};

const FIELDS = new Map<string, readonly string[]>([
  ["app.version", []],
  ["app.ship", ["worktree", "whenBusy", "project"]],
  ["models.list", []],
  ["sessions.list", ["project"]],
  ["sessions.read", ["sessionId", "before", "limit", "maxChars", "project"]],
  ["sessions.send", ["sessionId", "prompt", "project", "notifyOnComplete", "mode"]],
  ["sessions.queue", ["sessionId", "project", "cancel"]],
  ["sessions.draft", ["sessionId", "prompt", "project"]],
  ["sessions.stop", ["sessionId", "project", "cascade"]],
  ["sessions.archive", ["sessionId", "project"]],
  ["sessions.delete", ["sessionId", "project"]],
  [
    "sessions.start",
    [
      "prompt",
      "draft",
      "harness",
      "model",
      "modelSettings",
      "effort",
      "runtimeMode",
      "reveal",
      "workspaceMode",
      "worktreeBase",
      "worktreeCwd",
      "placement",
      "besideSessionId",
      "project",
      "notifyOnComplete",
    ],
  ],
  ["worktrees.list", ["project"]],
  ["worktrees.create", ["branch", "base", "existing", "runSetup", "project"]],
  ["actions.list", ["project"]],
  ["actions.run", ["action", "worktreeCwd", "waitSeconds", "project"]],
  ["stacks.list", ["project"]],
  ["folders.list", ["project"]],
  ["folders.move", ["sessionId", "folderId", "newFolderName", "project"]],
  ["notes.list", ["limit", "offset"]],
  ["notes.read", ["id"]],
  ["notes.write", ["id", "title", "body", "tags"]],
  ["artifacts.list", ["kind", "limit", "offset"]],
  ["artifacts.read", ["id"]],
  ["artifacts.write", ["id", "kind", "title", "body", "summary"]],
  ["soul.read", []],
  ["soul.update", ["text", "expectedHash"]],
  ["souls.read", ["mono"]],
  ["souls.merge", ["mono", "text", "expectedHash"]],
  ["memory.read", ["topic"]],
  ["memory.search", ["query", "since"]],
  // WP-88: reviewed memory across this copy, read only.
  ["memory.recall", ["query"]],
  ["memory.add", ["fact", "topic", "until"]],
  ["memory.replace", ["find", "fact", "topic", "until"]],
  ["memory.remove", ["find", "topic"]],
  ["skills.list", []],
  ["skills.read", ["name"]],
  ["skills.write", ["name", "text", "expectedHash"]],
  ["tree.zoom", ["id", "n", "at"]],
  ["tree.date", ["id"]],
  ["habits.list", []],
  ["habits.add", ["name", "instructions", "schedule"]],
  ["habits.update", ["id", "name", "instructions", "schedule", "enabled"]],
  ["habits.run", ["id"]],
  ["habits.remove", ["id"]],
  ["chat.card", [...CARD_FIELDS]],
  ["monos.propose", ["name", "brief", "lane", "team", "engine", "projects", "connectors", "soul"]],
  ...TASK_FIELDS,
  // WP-70: the shared task list. Not the delegation tools above.
  ...TASK_STORE_FIELDS,
  // WP-159: the programme board. Not the per-job worker queue.
  ...PROGRAMME_FIELDS,
  ...AUTOPILOT_FIELDS,
  ...PR_FIELDS,
  ...TIMER_FIELDS,
  // WP-157: the work log. Add and read, not the delegation tools above.
  ...WORK_LOG_FIELDS,
  ...ROOM_FIELDS,
  ...SELF_BUILD_FIELDS,
  ...DOC_FIELDS,
  // WP-92: the vault. Handles only; no action here returns a value.
  ...SECRET_FIELDS,
  // WP-88: the activity log, read only.
  ["activity.list", ["project", "agent", "kind", "search", "before", "limit"]],
  // WP-215: file a task, then hand it to the project's first mate. A first mate notes a call it settled.
  ["captain.handoff", ["project", "department", "title", "brief"]],
  ["decisions.note", ["project", "what", "reason"]],
]);

/**
 * The checker's lane (hub/model/hubChecker.ts, docs/PHASE-2-DESIGN.md H6): its chat and its habit runs only read their
 * own memory and soul and the model list. No sessions, delegations or tasks, no worktrees, actions, habits, notes,
 * artifacts, cards or ship, and nothing added later: it never starts work.
 */
const CHECKER_ACTIONS: ReadonlySet<string> = new Set([
  "models.list",
  "memory.read",
  "memory.search",
  "memory.add",
  "memory.replace",
  "memory.remove",
  "soul.read",
]);

/** Every app action there is (the checker's lane is tested against all of them). */
export function appActions(): string[] {
  return [...FIELDS.keys()];
}

function checkerLane(source: Session, action: string, host: AgentAppHost): void {
  if (host.monoOf?.(source.id)?.id === CHECKER_MONO_ID && !CHECKER_ACTIONS.has(action))
    throw new Error(
      `The checker only reads: it may use ${[...CHECKER_ACTIONS].join(", ")}. It never starts, sends to or delegates to a session.`,
    );
}

/**
 * Who may ship the daily app (`app.ship`): any Mono's own chat. Never a delegated worker's chat, a habit run or the
 * checker (dev copies are refused by their identity).
 */
function shipCaller(source: Session, host: AgentAppHost): void {
  const mono =
    host.isMono(source.id) && !host.isHabitRun?.(source.id)
      ? host.monoOf?.(source.id)
      : undefined;
  if (!mono || mono.id === CHECKER_MONO_ID)
    throw new Error(
      "Only a Mono ships, from its own chat. The checker does not. Report that it's ready to ship instead.",
    );
}

function fields(action: string, input: Record<string, unknown>) {
  const allowed = FIELDS.get(action);
  if (!allowed) throw new Error(`Unknown app action: ${action}`);
  // WP-171: fanout, originalRequest and originalRequestChars are the app's own replay fields. An agent's call has no mark.
  const replay = action === "tasks.delegate" && isAppDelegate(input);
  const unknown = Object.keys(input).filter(
    (key) => !allowed.includes(key) && !(replay && (APP_DELEGATE_FIELDS as readonly string[]).includes(key)),
  );
  if (unknown.length)
    throw new Error(`Unknown ${action} fields: ${unknown.join(", ")}`);
}

function requiredString(value: unknown, name: string, max = 30_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(
      `${name} must be a non-empty string under ${max} characters`,
    );
  return value.trim();
}

function agentPrompt(value: unknown): string {
  const prompt = requiredString(value, "prompt", 240_000);
  if (consumeOperatorCommand(prompt).matched)
    throw new Error("App calls cannot enable /operator in another session");
  return prompt;
}

function completionRecipient(
  source: Session,
  input: Record<string, unknown>,
  host: AgentAppHost,
  defaultForMono = false,
): string | undefined {
  const requested = input.notifyOnComplete;
  if (requested !== undefined && typeof requested !== "boolean")
    throw new Error("notifyOnComplete must be a boolean");
  const isMono = host.isMono(source.id);
  if (!(requested ?? (defaultForMono && isMono && !input.draft)))
    return undefined;
  // The chats Ash talks to hear back from what they start: a Mono's, and a coding-team chat (hub/model/codingTeam.ts).
  if (!isMono && !host.codingTeamOf?.(source.id))
    throw new Error(
      "Completion notifications are only available in a Mono's chat or a coding-team chat",
    );
  if (input.draft === true)
    throw new Error("An unsent draft cannot send a completion notification");
  return source.id;
}

function optionalString(
  value: unknown,
  name: string,
  max = 512,
): string | undefined {
  return value === undefined ? undefined : requiredString(value, name, max);
}

function noteBody(value: unknown): string {
  if (typeof value !== "string" || value.length > 240_000)
    throw new Error("body must be a string under 240000 characters");
  return value.replace(/\r\n?/g, "\n");
}

function noteTags(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 20 ||
    value.some((tag) => typeof tag !== "string" || tag.length > 48)
  )
    throw new Error(
      "tags must be an array of at most 20 strings under 48 characters each",
    );
  return normalizeNoteTags(value as string[]);
}

/**
 * The project an action works in. A session works in its own; a Mono works on
 * several, so it names one with "project" (its path or name), and may leave it
 * out when it has one project or is in one of its own.
 */
function requireProject(
  source: Session,
  input: Record<string, unknown>,
  host: AgentAppHost,
): string {
  const mono = host.monoOf?.(source.id);
  const named = optionalString(input.project, "project", 4096);
  if (!mono) {
    if (named) throw new Error("project is only for a Mono");
    if (!looksLikeProject(source.cwd))
      throw new Error("Choose a project folder in this session first");
    return source.cwd;
  }
  const choices = () =>
    mono.projects.length
      ? mono.projects.map((path) => `${projectName(path)} (${path})`).join(", ")
      : "none yet; the user adds them from your details panel";
  if (named) {
    if (mono.team && pathKey(mono.team) === pathKey(named)) return mono.team;
    const byPath = mono.projects.find(
      (path) => pathKey(path) === pathKey(named),
    );
    const byName = mono.projects.filter(
      (path) => projectName(path) === named,
    );
    const match = byPath ?? (byName.length === 1 ? byName[0] : undefined);
    if (!match) throw new Error(`Not one of your projects. Yours: ${choices()}`);
    return match;
  }
  const own = mono.projects.find(
    (path) => pathKey(path) === pathKey(source.cwd),
  );
  if (own) return own;
  if (mono.projects.length === 1) return mono.projects[0];
  throw new Error(`Pass "project" to choose one. Yours: ${choices()}`);
}

/** The lead a handoff briefs. With no coding-team map, the project path is still a lead the delegate call can name. */
function handoffLead(project: string, host: AgentAppHost): string {
  const work = host.tasks?.monoWork;
  if (!work) return project;
  const id = work.codingTeam(project)?.projectId?.trim();
  if (!id) throw new Error("That project has no first mate.");
  return id;
}

/** A coding-team chat notes its own project only. */
function teamFolder(
  team: { project: string; name: string; folder: string },
  input: Record<string, unknown>,
): string {
  const named = optionalString(input.project, "project", 4096);
  if (!named) return team.folder;
  if (pathKey(named) === pathKey(team.folder) || pathKey(named) === pathKey(team.project) || named === team.project) {
    return team.folder;
  }
  throw new Error("A coding-team chat notes its own project.");
}

/** A Mono's chat lives outside its projects; project access follows its roster. */
export function canAccessAgentAppProject(
  source: Session,
  cwd: string,
  monoProjects?: readonly string[],
): boolean {
  return (monoProjects ?? [source.cwd]).some(
    (project) => pathKey(project) === pathKey(cwd),
  );
}

async function projectSession(
  source: Session,
  id: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
): Promise<Session> {
  const cwd = requireProject(source, input, host);
  if (!(await host.sessions(cwd)).some((session) => session.id === id))
    throw new Error("Session was not found in this project");
  const target = await host.session(id);
  if (!target || pathKey(target.cwd) !== pathKey(cwd))
    throw new Error("Session was not found in this project");
  return target;
}

const RUN_TAIL_FOR_AGENTS = 20;

function actionRunSummary(run: ActionRun) {
  return {
    runId: run.id,
    action: run.actionId,
    cwd: run.cwd,
    status: run.status,
    exitCode: run.exitCode,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    trigger: run.trigger,
    logPath: run.logPath,
    tail: run.tail.slice(-RUN_TAIL_FOR_AGENTS),
    ...(run.error ? { error: run.error } : {}),
    ...(run.status === "running"
      ? {
          note: run.longRunning
            ? forUser("It keeps running until stopped; Ash stops it in Settings > Worktrees.")
            : "Still running: call actions.list later to see how it ended.",
        }
      : {}),
  };
}

/** What a Lead sees: the imported actions only, and the last few runs. */
export function actionsListing(listing: ActionsListing) {
  const { status } = listing;
  const note =
    status.state === "trusted"
      ? undefined
      : status.state === "changed"
        ? forUser("The project file changed since Ash imported it; the imported version still runs until he imports the new one.")
        : status.state === "none"
          ? "This project has no .monocode/project.json."
          : forUser("Ash hasn't imported this project's .monocode/project.json yet; nothing in it runs until he does, once, in Settings > Worktrees.");
  return {
    project: status.projectRoot,
    projectFile: {
      path: status.path,
      state: status.state,
      ...(status.error ? { error: status.error } : {}),
    },
    actions: listing.actions.map((action) => ({
      id: action.id,
      name: action.name,
      command: action.command,
      ...(action.description ? { description: action.description } : {}),
      ...(action.runOnWorktreeCreate ? { runOnWorktreeCreate: true } : {}),
      ...(action.longRunning ? { longRunning: true } : {}),
      // It asks Ash before it runs (Ship): actions.run refuses it; ask him in your chat.
      ...(action.confirm ? { confirm: true } : {}),
    })),
    runs: listing.runs.slice(0, 10).map(actionRunSummary),
    ...(note ? { note } : {}),
  };
}

/** Two short body paragraphs, with a hard cap independent of Markdown length. */
export function notePreview(body: string): string {
  return body
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 2)
    .join("\n\n")
    .slice(0, 400);
}

/**
 * Puts a session a Mono started into the sidebar folder named after it,
 * making that folder in its color the first time.
 */
function fileInMonoFolder(
  cwd: string,
  sessionId: string,
  folder: { name: string; color: string },
): void {
  const folders = loadSessionFolders(cwd);
  const own = folders.find((entry) => entry.name === folder.name);
  if (own) {
    saveSessionFolders(cwd, addSessionToFolder(folders, own.id, sessionId));
    return;
  }
  const created = createFolderWithSessions(folders, [sessionId], folder.name);
  saveSessionFolders(
    cwd,
    setFolderCustomColor(created.folders, created.id, folder.color),
  );
}

/** A started session goes into the starting Mono's sidebar folder, when it has one and the session is shown. */
function fileStarted(
  source: Session,
  launch: QuickLaunch,
  id: string,
  host: AgentAppHost,
): void {
  const folder = host.monoOf?.(source.id)?.folder;
  if (folder && !launch.sidebarHidden) fileInMonoFolder(launch.cwd, id, folder);
}

function startLaunch(
  source: Session,
  input: Record<string, unknown>,
  host: AgentAppHost,
): QuickLaunch {
  const cwd = requireProject(source, input, host);
  const prompt = agentPrompt(input.prompt);
  const title = optionalString(input.title, "title");
  const draft = input.draft ?? false;
  if (typeof draft !== "boolean") throw new Error("draft must be a boolean");
  const harness = input.harness ?? source.harness;
  if (!HARNESSES.includes(harness as HarnessId))
    throw new Error("Unknown harness; run models.list for available providers");
  const chosenHarness = harness as HarnessId;
  if (!isHarnessAvailable(chosenHarness))
    throw new Error(`${chosenHarness} is not available in MonoCode`);
  const requestedModel = optionalString(input.model, "model");
  const model = requestedModel
    ? // One of Ash's own models ("Other models") keeps its own id; the router reads its route (customModels.ts). On the
      // DeepSeek launcher, so does DeepSeek, which no catalog lists: a worker the app routes there was refused here
      // as an unknown model, and the Lead fell back to another CLI.
      chosenHarness === "claude" &&
      (isCustomModelId(requestedModel) || (isBridgeModelId(requestedModel) && claudeRunsOnSubscriptionBridge()))
      ? resolveModel(chosenHarness, requestedModel)
      : modelsFor(chosenHarness).find((entry) => entry.id === requestedModel)
    : resolveModel(
        chosenHarness,
        chosenHarness === source.harness
          ? source.model
          : preferredModelId(chosenHarness),
      );
  if (!model || model.harness !== chosenHarness)
    throw new Error("Unknown model; run models.list for exact model IDs");
  const rawSettings = input.modelSettings;
  if (
    rawSettings !== undefined &&
    (!rawSettings ||
      typeof rawSettings !== "object" ||
      Array.isArray(rawSettings))
  )
    throw new Error(
      "modelSettings must be an object of setting IDs and values",
    );
  const requestedSettings = {
    ...((rawSettings ?? {}) as Record<string, unknown>),
  };
  if (input.effort !== undefined) {
    const effort = modelEffortSetting(model);
    if (!effort)
      throw new Error(`${model.id} does not expose an effort setting`);
    requestedSettings[effort.id] = requiredString(input.effort, "effort", 128);
  }
  for (const [key, value] of Object.entries(requestedSettings)) {
    const setting = model.settings?.find((entry) => entry.id === key);
    if (
      !setting ||
      typeof value !== "string" ||
      !setting.options.some((option) => option.value === value)
    )
      throw new Error(
        `Invalid model setting ${key}; run models.list for allowed values`,
      );
  }
  const runtimeMode = input.runtimeMode ?? source.runtimeMode;
  if (!RUNTIME_MODES.includes(runtimeMode as Session["runtimeMode"]))
    throw new Error(`runtimeMode must be one of: ${RUNTIME_MODES.join(", ")}`);
  const reveal = input.reveal ?? false;
  if (typeof reveal !== "boolean") throw new Error("reveal must be a boolean");
  const workspaceMode = input.workspaceMode ?? "current";
  if (workspaceMode !== "current" && workspaceMode !== "worktree")
    throw new Error("workspaceMode must be current or worktree");
  const worktreeBase = optionalString(input.worktreeBase, "worktreeBase");
  if (worktreeBase && workspaceMode !== "worktree")
    throw new Error("worktreeBase requires workspaceMode worktree");
  const worktreeCwd = optionalString(input.worktreeCwd, "worktreeCwd");
  if (worktreeCwd && workspaceMode !== "current")
    throw new Error("worktreeCwd requires workspaceMode current");
  const startingMono = host.monoOf?.(source.id);
  const currentWorktree =
    worktreeCwd ||
    (pathKey(cwd) === pathKey(source.cwd) ? source.worktreeCwd : undefined);
  return {
    cwd,
    prompt,
    ...(title ? { title: title.slice(0, 200) } : {}),
    // Only a Mono's own preference hides what it starts. A regular session
    // with /operator has no Mono, and its launches belong in the sidebar.
    ...(startingMono && startingMono.showStartedSessionsInSidebar !== true
      ? { sidebarHidden: true }
      : {}),
    ...(draft ? { draft: true } : {}),
    harness: chosenHarness,
    model: model.id,
    modelSettings: mergeModelSettings(model, {
      ...(chosenHarness === source.harness && model.id === source.model
        ? source.modelSettings
        : {}),
      ...(requestedSettings as Record<string, string>),
    }),
    runtimeMode: runtimeMode as Session["runtimeMode"],
    // A Mono delegates work without navigating the user out of their chat.
    reveal: host.isMono(source.id) ? false : reveal,
    workspaceMode,
    ...(workspaceMode === "current" && currentWorktree
      ? { worktreeCwd: currentWorktree }
      : {}),
    ...(worktreeBase ? { worktreeBase } : {}),
    // WP-89: the start card names where this came from, and the effort only when this launch set one.
    ...launchCard(input, model, requestedSettings),
  };
}

/** The source line, effort and CLI fallback a start card shows. An unknown source or line is left off. */
function launchCard(
  input: Record<string, unknown>,
  model: ReturnType<typeof resolveModel>,
  settings: Record<string, unknown>,
): { ranFrom?: string; ranEffort?: string; cliFallback?: string } {
  const ranFrom = cleanRanFrom(input.ranFrom);
  const ranEffort =
    input.effort !== undefined ? modelEffortLabel(model, settings as Record<string, string>) : undefined;
  const cliFallback = cleanCliFallback(input.cliFallback);
  return {
    ...(ranFrom ? { ranFrom } : {}),
    ...(ranEffort ? { ranEffort } : {}),
    ...(cliFallback ? { cliFallback } : {}),
  };
}

function memoryPath(topic: unknown): AgentFilePath {
  return topic === undefined
    ? "MEMORY.md"
    : `memory/${topicName(requiredString(topic, "topic", 80))}.md`;
}

/** The name a Mono's own writes show under: its name, or its id when the app can't match one. */
function selfWriter(host: AgentAppHost, monoId: string): string {
  return host.monoNameOf?.(monoId) ?? monoId;
}

/** A memory file in plain words: "its memory", or "its “deploy” note". */
function memoryAbout(path: AgentFilePath): string {
  return path === "MEMORY.md"
    ? "its memory"
    : `its “${path.slice("memory/".length, -".md".length)}” note`;
}

/** A line of the Mono's own writing, short enough to read in a Bot changes row. */
function briefly(text: string, max = 90): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

async function handleSoul(
  source: Session,
  action: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
): Promise<unknown> {
  const monoId = host.isMono(source.id)
    ? host.monoOf?.(source.id)?.id
    : undefined;
  if (!monoId)
    throw new Error("A soul can only be changed from that Mono's own chat");
  if (action === "soul.read") {
    const files = await host.agentFiles(monoId);
    return { file: "SOUL.md", text: files.soul, hash: files.soulHash };
  }
  if (typeof input.text !== "string" || input.text.length > 240_000)
    throw new Error("text must be a string under 240000 characters");
  const expectedHash = requiredString(input.expectedHash, "expectedHash", 128);
  // The file as this write found it, so its Bot changes row can put it back (D1).
  const before = await host.readAgentFile(monoId, "SOUL.md");
  if (hasCaptainCharter(before.text) && !hasCaptainCharter(input.text)) {
    throw new Error("The captain charter is fixed. Edit the personality beside it.");
  }
  const nextSoul = hasCaptainCharter(input.text) ? withLockedRole(input.text) : input.text;
  try {
    const hash = await host.writeAgentFile(
      monoId,
      "SOUL.md",
      nextSoul,
      expectedHash,
    );
    const bot = selfWriter(host, monoId);
    recordSelfWrite({
      monoId,
      bot,
      file: "SOUL.md",
      line: `${bot} changed its soul`,
      before: before.text ?? "",
      after: nextSoul,
      run: source.id,
    });
    return { file: "SOUL.md", updated: true, hash };
  } catch (error) {
    if (error instanceof MonoFileConflict)
      throw new Error(
        "SOUL.md changed since you read it. Run soul.read and reapply the user's requested changes to the current text before calling soul.update again.",
      );
    throw error;
  }
}

/**
 * Read, change and write one memory file over the version it read, again
 * from the top when the user saved the same file in between. `before` is the
 * text the edit was applied to and `after` the text left, for the Bot changes
 * row the caller records (D1); both are equal when nothing was written.
 */
async function editAgentFile<T>(
  host: AgentAppHost,
  monoId: string,
  path: AgentFilePath,
  edit: (text: string) => { text: string; result: T },
): Promise<{ result: T; before: string; after: string }> {
  for (let attempt = 0; ; attempt++) {
    const current = await host.readAgentFile(monoId, path);
    const fallback =
      current.text == null && path !== "MEMORY.md"
        ? `# ${path.slice("memory/".length, -".md".length)}\n\n`
        : "";
    const before = current.text ?? fallback;
    const next = edit(before);
    try {
      if (next.text !== (current.text ?? ""))
        await host.writeAgentFile(monoId, path, next.text, current.hash);
      return { result: next.result, before, after: next.text };
    } catch (error) {
      if (!(error instanceof MonoFileConflict) || attempt >= 2)
        throw error;
    }
  }
}

/** The doc's fade for each line of this Mono's MEMORY.md, or nothing when it cannot be read or to be trusted. */
async function memoryUseOf(host: AgentAppHost, monoId: string): Promise<Map<string, MemoryUse> | undefined> {
  if (!host.memoryDoc) return undefined;
  try {
    const doc = parseDoc(await host.memoryDoc());
    const clock = livedClockOf(doc);
    const now = (host.now?.() ?? new Date()).getTime();
    const use = new Map<string, MemoryUse>();
    for (const item of doc.items) {
      if (item.mateId !== monoId || item.action !== "add") continue;
      use.set(memoryUseKey(item.text), { fade: fadeNow(item, clock, now), usedAt: item.lastUsedAt ?? item.updatedAt });
    }
    return use;
  } catch {
    return undefined;
  }
}

/**
 * Keeps MEMORY.md within what loads. The archive is written first, so a line
 * is never out of one file without already being in the other. If the user
 * saved MEMORY.md in between, the trim waits for the next write. Both writes
 * leave a Bot changes row: they are the Mono rewriting its own memory.
 */
async function keepMemoryInBudget(
  host: AgentAppHost,
  monoId: string,
  keep: string,
  date: string,
  by: { bot: string; run: string },
): Promise<string[]> {
  const memory = await host.readAgentFile(monoId, "MEMORY.md");
  // WP-100: the least used lines go first. A doc that cannot be read leaves the order as it was.
  const use = await memoryUseOf(host, monoId);
  const fitted = fitMemoryBudget(memory.text ?? "", keep, date, use);
  if (!fitted.moved.length) return [];
  const archived = await editAgentFile(host, monoId, "memory/archive.md", (archive) => ({
    text: archiveMemoryEntries(archive, fitted.moved, date),
    result: undefined,
  }));
  recordSelfWrite({
    monoId,
    bot: by.bot,
    file: "memory/archive.md",
    line: `${by.bot} moved ${fitted.moved.length} older line${fitted.moved.length === 1 ? "" : "s"} to its memory archive`,
    before: archived.before,
    after: archived.after,
    run: by.run,
  });
  try {
    await host.writeAgentFile(monoId, "MEMORY.md", fitted.text, memory.hash);
  } catch (error) {
    if (!(error instanceof MonoFileConflict)) throw error;
    return [];
  }
  recordSelfWrite({
    monoId,
    bot: by.bot,
    file: "MEMORY.md",
    line: `${by.bot} moved older lines out of its memory to keep it short`,
    before: memory.text ?? "",
    after: fitted.text,
    run: by.run,
  });
  return fitted.moved;
}

function treeNumber(value: unknown, name: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a whole number, 0 or more`);
  return value;
}

/**
 * tree.zoom / tree.date: a long-chat Mono reads its own tree back, from its own chat only. Never a worker it started,
 * a habit run or another Mono's chat, and never a Mono without the setting (it has no tree).
 */
async function handleTree(
  source: Session,
  action: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
): Promise<unknown> {
  const monoId = host.isMono(source.id) && !host.isHabitRun?.(source.id) ? host.monoOf?.(source.id)?.id : undefined;
  if (!monoId) throw new Error("The long chat can only be read from a Mono's own chat");
  if (!host.tree?.on(monoId))
    throw new Error("This Mono doesn't keep one long chat (its settings: Keep one long chat)");
  const id = treeNumber(input.id, "id");
  if (action === "tree.date") return { date: await host.tree.date(monoId, id) };
  return { lines: await host.tree.zoom(monoId, id, treeNumber(input.n, "n", 1), treeNumber(input.at, "at", 0)) };
}

async function handleMemory(
  source: Session,
  action: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
): Promise<unknown> {
  const monoId = host.monoOf?.(source.id)?.id;
  if (!monoId) throw new Error("Memory can only be changed from a Mono's own chat");
  const path = memoryPath(input.topic);
  const date = memoryDate(host.now?.() ?? new Date());
  const until = optionalString(input.until, "until", 10);
  const bot = selfWriter(host, monoId);
  // What the Mono wrote is its own change, so each write leaves a row whose Undo puts the line back (D1).
  const record = (write: { line: string; details?: string[]; before: string; after: string }) =>
    recordSelfWrite({ monoId, bot, file: path, run: source.id, ...write });
  const report = async (result: Record<string, unknown>, keep?: string) => {
    const moved =
      path === "MEMORY.md" && keep
        ? await keepMemoryInBudget(host, monoId, keep, date, { bot, run: source.id })
        : [];
    return {
      file: path,
      ...result,
      ...(moved.length
        ? { movedToArchive: moved.length, moved: moved.slice(0, 5) }
        : {}),
    };
  };
  // WP-111: a private chat cannot write memory. Reading it is unchanged.
  if (
    isPrivateChat(source) &&
    (action === "memory.add" || action === "memory.replace" || action === "memory.remove")
  ) {
    throw new Error("This chat is private, so memory was not changed.");
  }
  // The order scan the curator and imports run: MEMORY.md goes into every conversation.
  if ((action === "memory.add" || action === "memory.replace") && givesOrders(String(input.fact ?? ""))) {
    throw new Error(ORDER_REFUSAL);
  }
  switch (action) {
    case "memory.search": {
      const query =
        input.query === undefined
          ? ""
          : requiredString(input.query, "query", 500);
      const since =
        input.since === undefined
          ? undefined
          : sinceDate(
              requiredString(input.since, "since", 20),
              host.now?.() ?? new Date(),
            );
      const files = await host.agentFiles(monoId);
      const paths: AgentFilePath[] = [
        "MEMORY.md",
        ...files.topics.map((topic) => `memory/${topic}.md` as const),
        "memory/archive.md",
      ];
      const texts = await Promise.all(
        paths.map(async (file) => ({
          file,
          text:
            file === "MEMORY.md"
              ? files.memory
              : ((await host.readAgentFile(monoId, file)).text ?? ""),
        })),
      );
      const hits = searchMemory(texts, query, { since });
      return hits.length
        ? { hits }
        : { hits, note: "Nothing in memory matches. It may never have been saved." };
    }
    case "memory.read": {
      if (path !== "MEMORY.md") {
        const topic = await host.readAgentFile(monoId, path);
        if (topic.text == null) throw new Error("No such memory topic");
        return { file: path, text: topic.text };
      }
      const files = await host.agentFiles(monoId);
      const budget = memoryWithinBudget(files.memory);
      return {
        file: path,
        text: files.memory,
        lines: budget.lines,
        notLoaded: budget.droppedLines,
        topics: files.topics,
      };
    }
    case "memory.add": {
      const fact = requiredString(input.fact, "fact");
      const entry = memoryEntry(fact, date, until, source.harness);
      const write = await editAgentFile(host, monoId, path, (text) => {
        const next = addMemoryEntry(text, entry);
        return { text: next.text, result: next.added };
      });
      if (!write.result) return { file: path, alreadyRemembered: true };
      record({
        line:
          path === "MEMORY.md"
            ? `${bot} remembered: ${briefly(fact)}`
            : `${bot} added to ${memoryAbout(path)}: ${briefly(fact)}`,
        before: write.before,
        after: write.after,
      });
      return report({ added: entry }, entry);
    }
    case "memory.replace": {
      const find = requiredString(input.find, "find", 2000);
      const fact = requiredString(input.fact, "fact");
      const entry = memoryEntry(fact, date, until, source.harness);
      const write = await editAgentFile(host, monoId, path, (text) => ({
        text: supersedeMemoryEntry(text, find, entry, date),
        result: undefined,
      }));
      record({
        line: `${bot} corrected ${memoryAbout(path)}`,
        details: [`It now reads: ${briefly(entry, 160)}`, `It used to read: ${briefly(find, 160)}`],
        before: write.before,
        after: write.after,
      });
      return report({ superseded: find, added: entry }, entry);
    }
    case "memory.remove": {
      const find = requiredString(input.find, "find", 2000);
      const write = await editAgentFile(host, monoId, path, (text) => {
        const next = removeMemoryEntry(text, find);
        return { text: next.text, result: next.removed };
      });
      if (write.result)
        record({
          line: `${bot} removed a line from ${memoryAbout(path)}`,
          details: [`It no longer remembers: ${briefly(find, 160)}`],
          before: write.before,
          after: write.after,
        });
      return { file: path, removed: write.result };
    }
  }
  throw new Error(`Unknown app action: ${action}`);
}

/**
 * A skill's name: the same jail the backend applies to a file in a Mono's folder (src-tauri/src/mono.rs valid_name), said
 * here first so the agent gets a reason it can act on rather than an error from deeper in.
 */
function skillName(value: unknown): string {
  const name = requiredString(value, "name", 80).replace(/\.md$/i, "");
  if (!name || name.startsWith(".") || !/^[A-Za-z0-9 ._-]+$/.test(name))
    throw new Error(
      "name must be a short skill name: letters, numbers, spaces, dots, dashes and underscores, not starting with a dot",
    );
  return name;
}

/**
 * The skills a Mono keeps for itself (skills/<name>.md). A Mono reads and improves its own; a worker improves the ones
 * of the Mono it works as (A7), which is how what a worker learns reaches the next run. Every write is the Mono's own
 * change, so it leaves a Bot changes row whose Undo puts the file back (D1).
 */
async function handleSkills(
  source: Session,
  action: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
): Promise<unknown> {
  // A worker works as the Mono that started it (hubMcp.ts chatMonoOwner); its own chat and habit runs are covered too.
  const monoId =
    host.ownerMonoOf?.(source.id) ??
    (host.isMono(source.id) ? host.monoOf?.(source.id)?.id : undefined);
  if (!monoId)
    throw new Error(
      "A skill belongs to a Mono. This chat isn't one, and no Mono started it.",
    );
  if (action === "skills.list") {
    const files = await host.agentFiles(monoId);
    return { skills: files.skills ?? [] };
  }
  const name = skillName(input.name);
  const path: AgentFilePath = `skills/${name}.md`;
  if (action === "skills.read") {
    const file = await host.readAgentFile(monoId, path);
    return { file: path, text: file.text ?? "", exists: file.text != null, hash: file.hash };
  }
  if (typeof input.text !== "string" || input.text.length > 240_000)
    throw new Error("text must be a string under 240000 characters");
  const expectedHash = requiredString(input.expectedHash, "expectedHash", 128);
  const before = await host.readAgentFile(monoId, path);
  try {
    const hash = await host.writeAgentFile(monoId, path, input.text, expectedHash);
    const bot = selfWriter(host, monoId);
    recordSelfWrite({
      monoId,
      bot,
      file: path,
      line:
        before.text == null
          ? `${bot} wrote a new skill, “${name}”`
          : `${bot} changed the “${name}” skill`,
      before: before.text ?? "",
      after: input.text,
      run: source.id,
    });
    return { file: path, updated: true, hash };
  } catch (error) {
    if (error instanceof MonoFileConflict)
      throw new Error(
        `${path} changed since you read it. Run skills.read and reapply your improvements to the current text before writing again.`,
      );
    throw error;
  }
}

function habitView(habit: Habit) {
  return {
    id: habit.id,
    name: habit.name,
    instructions: habit.instructions,
    schedule: habitScheduleLabel(habit.schedule),
    enabled: habit.enabled,
    nextRun: habit.enabled ? new Date(habit.nextRunAt).toLocaleString() : null,
    ...(habitRunningSince(habit.id) != null ? { running: true } : {}),
    ...(habit.lastRunAt
      ? {
          lastRun: new Date(habit.lastRunAt).toLocaleString(),
          lastOutcome: habit.lastOutcome,
          ...(habit.lastError ? { lastError: habit.lastError } : {}),
        }
      : {}),
  };
}

async function handleHabits(
  source: Session,
  action: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
): Promise<unknown> {
  const habits = host.habits;
  // A habit's own run cannot schedule more runs.
  const monoId = host.isMono(source.id)
    ? host.monoOf?.(source.id)?.id
    : undefined;
  if (!habits || !monoId)
    throw new Error("Habits can only be changed from that Mono's own chat");
  const now = host.now?.() ?? new Date();
  const find = (list: Habit[]) => {
    const id = requiredString(input.id, "id", 128);
    const habit = list.find((entry) => entry.id === id);
    if (!habit) throw new Error("No habit with that id; run habits.list");
    return habit;
  };
  switch (action) {
    case "habits.list":
      return { habits: (await habits.load(monoId)).map(habitView) };
    case "habits.add": {
      const name = requiredString(input.name, "name", 80);
      const instructions = requiredString(input.instructions, "instructions", 4_000);
      const schedule = habitSchedule(input.schedule);
      const habit = await habits.update(monoId, (list) => {
        if (list.length >= HABITS_MAX)
          throw new Error(`A Mono can have at most ${HABITS_MAX} habits`);
        const created = newHabit(
          { name, instructions, schedule },
          now.getTime(),
        );
        return { habits: [...list, created], result: created };
      });
      return { habit: habitView(habit) };
    }
    case "habits.update": {
      const patch = {
        ...(input.name === undefined
          ? {}
          : { name: requiredString(input.name, "name", 80) }),
        ...(input.instructions === undefined
          ? {}
          : {
              instructions: requiredString(
                input.instructions,
                "instructions",
                4_000,
              ),
            }),
        ...(input.schedule === undefined
          ? {}
          : { schedule: habitSchedule(input.schedule) }),
      };
      if (input.enabled !== undefined && typeof input.enabled !== "boolean")
        throw new Error("enabled must be true or false");
      const habit = await habits.update(monoId, (list) => {
        const current = find(list);
        const next: Habit = {
          ...current,
          ...patch,
          ...(input.enabled === undefined
            ? {}
            : { enabled: input.enabled as boolean }),
        };
        // A new schedule, or turning it back on, counts from now.
        if (patch.schedule || (next.enabled && !current.enabled))
          next.nextRunAt = nextHabitRunAt(next.schedule, now.getTime());
        return {
          habits: list.map((entry) => (entry.id === next.id ? next : entry)),
          result: next,
        };
      });
      return { habit: habitView(habit) };
    }
    case "habits.run": {
      const running = habitRunningSince(requiredString(input.id, "id", 128));
      if (running != null)
        throw new Error(
          `That habit is already running (started ${new Date(running).toLocaleTimeString()}); its result will be posted here when it ends`,
        );
      const habit = await habits.update(monoId, (list) => {
        const next = { ...find(list), runRequested: true };
        return {
          habits: list.map((entry) => (entry.id === next.id ? next : entry)),
          result: next,
        };
      });
      checkHabitsNow();
      return {
        habit: habitView(habit),
        note: "It starts now, on its own. Whatever it finds is posted to this chat, or nothing if there is nothing to say.",
      };
    }
    case "habits.remove": {
      const removed = await habits.update(monoId, (list) => {
        const habit = find(list);
        return {
          habits: list.filter((entry) => entry.id !== habit.id),
          result: habit,
        };
      });
      return { removed: removed.name };
    }
  }
  throw new Error(`Unknown app action: ${action}`);
}

function artifactKind(value: unknown): ArtifactKind {
  if (value === undefined) return "document";
  if (ARTIFACT_KINDS.includes(value as ArtifactKind))
    return value as ArtifactKind;
  throw new Error('Unsupported artifact kind; use "document" or "html"');
}

async function handleArtifacts(
  source: Session,
  requestId: string,
  action: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
): Promise<unknown> {
  if (!(host.isMono(source.id) || host.isHabitRun?.(source.id)))
    throw new Error("Only a Mono can create or read artifacts");
  if (!host.artifact) throw new Error("Artifacts are unavailable");
  if (action === "artifacts.list") {
    if (!host.artifacts) throw new Error("Artifacts are unavailable");
    const kind =
      input.kind === undefined ? undefined : artifactKind(input.kind);
    const limit = input.limit ?? 30;
    const offset = input.offset ?? 0;
    if (
      !Number.isInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > 100
    )
      throw new Error("limit must be an integer from 1 to 100");
    if (!Number.isInteger(offset) || (offset as number) < 0)
      throw new Error("offset must be a non-negative integer");
    const artifacts = (await host.artifacts()).filter(
      (artifact) => kind === undefined || artifact.kind === kind,
    );
    return {
      total: artifacts.length,
      offset,
      artifacts: artifacts
        .slice(offset as number, (offset as number) + (limit as number))
        .map(({ id, kind, title, updatedAt }) => ({
          id,
          kind,
          title,
          updatedAt,
        })),
    };
  }
  if (action === "artifacts.read") {
    const artifact = await host.artifact(requiredString(input.id, "id", 256));
    if (!artifact) throw new Error("Artifact was not found");
    return artifact;
  }
  if (!host.saveArtifact || !host.postArtifact)
    throw new Error("Artifacts are unavailable");
  const kind = artifactKind(input.kind);
  const id = optionalString(input.id, "id", 256);
  if (id && !/^[A-Za-z0-9_-]+$/.test(id))
    throw new Error("Invalid artifact ID");
  const title =
    input.title === undefined
      ? undefined
      : requiredString(input.title, "title", 200);
  const body = input.body === undefined ? undefined : noteBody(input.body);
  const summary =
    input.summary === undefined
      ? undefined
      : requiredString(input.summary, "summary", 280);
  let artifact: Artifact;
  if (id) {
    if (title === undefined && body === undefined)
      throw new Error("Supply title or body to update an artifact");
    const current = await host.artifact(id);
    if (!current) throw new Error("Artifact was not found");
    if (current.kind !== kind)
      throw new Error("An artifact's kind cannot be changed");
    artifact = await host.saveArtifact({
      id,
      kind,
      title: title ?? current.title,
      body: body ?? current.body,
    });
  } else {
    if (body === undefined)
      throw new Error("body is required to create an artifact");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId))
      throw new Error("Invalid request ID");
    const createdId = `artifact-${source.id}-${requestId}`;
    const existing = await host.artifact(createdId);
    if (
      existing &&
      (existing.kind !== kind ||
        existing.title !== (title ?? noteTitle(body)) ||
        existing.body !== body)
    )
      throw new Error("Request ID was already used for another artifact");
    artifact =
      existing ??
      (await host.saveArtifact({
        id: createdId,
        kind,
        title: title ?? noteTitle(body),
        body,
        sourceSessionId: source.id,
        ...(looksLikeProject(source.cwd) ? { sourceCwd: source.cwd } : {}),
      }));
  }
  const card: ArtifactCard = {
    id: artifact.id,
    kind: artifact.kind,
    title: artifact.title,
    ...(summary ? { summary } : {}),
  };
  await host.postArtifact(source.id, card);
  return { ...card, saved: true, attached: true };
}

export async function handleAgentApp(
  source: Session,
  requestId: string,
  action: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
): Promise<unknown> {
  // WP-203: a security review's request id and the review owner belong to the app's launcher. A caller can't name either.
  if (requestId.startsWith(REVIEW_REQUEST_PREFIX)) {
    throw new Error("Security review request IDs belong to the app's review launcher; pick another request ID.");
  }
  if (isReviewSession(source.id)) throw new Error("This session is reserved for the app's security review.");
  fields(action, input);
  checkerLane(source, action, host);
  // WP-70: the shared task list. Not the delegation tools below.
  if (isTaskStoreAction(action)) return handleTaskStore(source, action, input, host);
  // WP-159: the programme board. A worker is refused before the store is called.
  if (isProgrammeAction(action)) return handleProgramme(source, action, input, host);
  if (action.startsWith("tasks.")) {
    // A delegated worker starts like sessions.start, so it waits for the first probe the same way (found by the bench:
    // a Mono briefed right after a launch was told "claude is not available").
    if ((action === "tasks.delegate" && input.lead === undefined) || action === "tasks.fanout") await harnessesProbed();
    const result = await handleTasks(source, requestId, action, input, host, { startLaunch, fileStarted });
    if (action === "tasks.delegate" && input.lead === undefined) host.rooms?.delegated?.(source, result);
    // WP-171: each task a fan-out handed out (started or waiting) is work that comes back to the room, as one delegate_task is.
    if (action === "tasks.fanout")
      for (const task of ((result as { tasks?: unknown }).tasks as unknown[] | undefined) ?? [])
        if (typeof (task as { childSessionId?: unknown })?.childSessionId === "string") host.rooms?.delegated?.(source, task);
    return result;
  }
  if (action.startsWith("secrets.")) return handleSecrets(source, action, input, host);
  if (action.startsWith("prs.")) return handlePrs(source, action, input, host);
  if (action.startsWith("timers.")) return handleTimers(source, action, input, host);
  // WP-157: the work log.
  if (action.startsWith("work_log.")) return handleWorkLog(source, action, input, host);
  if (action.startsWith("rooms.") || action === "monos.message") return handleRooms(source, requestId, action, input, host);
  if (action.startsWith("docs.")) {
    return handleDocs(source, requestId, action, input, host, (session, fields) => requireProject(session, fields, host));
  }
  if (action === "monos.create" || action === "monos.retire" || action === "teams.create" || action === "pages.build" || action === "hub.change" || action === "today.change" || action === "creator.draft" || action === "creator.state")
    return handleSelfBuild(source, action, input, host, async (brief, title, folder, intent) => {
      // The worker runs in the preview copy: the caller may name that one folder as its project for this delegation.
      await harnessesProbed();
      const inFolder: AgentAppHost = {
        ...host,
        monoOf: (id) => {
          const mono = host.monoOf?.(id);
          return mono && { ...mono, projects: [...mono.projects, folder], team: undefined };
        },
      };
      // Hivra WP-10: a brief carries Ash's ask and a definition of done, or delegate refuses it.
      return handleTasks(
        source,
        requestId,
        "tasks.delegate",
        { intent, brief, title, goal: SELF_BUILD_GOAL, project: folder },
        inFolder,
        { startLaunch, fileStarted },
      );
    });
  if (action.startsWith("artifacts."))
    return handleArtifacts(source, requestId, action, input, host);
  if (action.startsWith("soul."))
    return handleSoul(source, action, input, host);
  if (action.startsWith("souls.")) {
    // Alfred's lane only (hub/model/soulMerge.ts): the app checks who asks, the read-before-write guard and the soul.
    const caller: SoulMergeCaller = {
      monoId: host.isMono(source.id) ? host.monoOf?.(source.id)?.id : undefined,
      isOwnChat: host.isMono(source.id) && !host.isHabitRun?.(source.id),
    };
    const files = {
      read: (monoId: string, path: AgentFilePath) => host.readAgentFile(monoId, path),
      write: (monoId: string, path: AgentFilePath, text: string, hash?: string) =>
        host.writeAgentFile(monoId, path, text, hash ?? ""),
    };
    const mono = requiredString(input.mono, "mono", 128);
    const templates = host.soulTemplates?.();
    if (action === "souls.read") return readForMerge(caller, mono, files, templates);
    if (typeof input.text !== "string" || input.text.length > 240_000)
      throw new Error("text must be a string under 240000 characters");
    const current = await host.readAgentFile(mono, "SOUL.md");
    const nextSoul = hasCaptainCharter(input.text) ? withLockedRole(input.text) : input.text;
    if (hasCaptainCharter(current.text) && !hasCaptainCharter(nextSoul)) {
      throw new Error("The captain charter is fixed. Edit the personality beside it.");
    }
    return mergeSoul(
      caller,
      { mono, text: nextSoul, expectedHash: requiredString(input.expectedHash, "expectedHash", 128) },
      files,
      templates,
      host.now?.() ?? new Date(),
    );
  }
  // WP-215: file the task, then hand it to the project's first mate.
  if (action === "captain.handoff") {
    const mono = host.monoOf?.(source.id);
    if (!host.isMono(source.id) || !isCaptainMono(mono)) {
      throw new Error("Only the Chief of Staff hands work on.");
    }
    const project = requiredString(input.project, "project", 4096);
    const title = requiredString(input.title, "title", 300);
    const brief = requiredString(input.brief, "brief", 8000);
    const lead = handoffLead(project, host);
    const goal = handoffGoal(title, brief);
    const problem = checkBrief({ intent: brief, spec: brief, done: goal });
    if (problem) throw new Error(problem);
    // The probe, the brief and the lead are settled before anything is filed, so a retry cannot file a second task.
    await harnessesProbed();
    return captainHandoff(
      {
        project,
        department: typeof input.department === "string" ? input.department : undefined,
        title,
        brief,
      },
      {
        canRead: (named) =>
          captainCanRead(mono, named, async () => {
            if (!mono?.id || !host.agentFiles) return undefined;
            try {
              return (await host.agentFiles(mono.id)).soul;
            } catch {
              return undefined;
            }
          }),
        ...handoffMemory(host),
        createTask: async (task) => {
          const created = await handleTaskStore(source, "tasks.create", {
            title: task.title,
            description: task.brief,
            project: task.project,
          }, host);
          return { id: filedTaskId(created) };
        },
        delegate: async (task) => {
          const created = await handleTasks(source, `${requestId}-handoff`, "tasks.delegate", {
            title: task.title,
            brief: task.brief,
            intent: task.brief,
            goal,
            lead,
            taskId: task.taskId,
          }, host, { startLaunch, fileStarted });
          return { id: delegationId(created) };
        },
      },
    );
  }
  // WP-215: the chat id is this chat, not a field on the call. Only a Mono or a coding-team chat, on its own project.
  if (action === "decisions.note") {
    const mono = host.isMono(source.id) ? host.monoOf?.(source.id) : undefined;
    const team = mono ? undefined : host.codingTeamOf?.(source.id);
    const folder = mono
      ? requireProject(source, input, host)
      : team
        ? teamFolder(team, input)
        : null;
    if (!folder) throw new Error("Only a Mono or a coding-team chat notes a decision.");
    const project = host.tasks?.hubProjectId?.(folder) ?? (team ? team.project : folder);
    return recordNote({
      project,
      what: requiredString(input.what, "what", 2000),
      reason: requiredString(input.reason, "reason", 500),
      sessionId: source.id,
    });
  }
  if (action === "activity.list") return handleActivity(source, input, host);
  if (action === "memory.recall") return handleMemoryRecall(source, input, host);
  if (action.startsWith("memory."))
    return handleMemory(source, action, input, host);
  if (action.startsWith("skills."))
    return handleSkills(source, action, input, host);
  if (action.startsWith("tree."))
    return handleTree(source, action, input, host);
  if (action.startsWith("habits."))
    return handleHabits(source, action, input, host);
  if (action.startsWith("autopilot."))
    return handleAutopilotApp(source, requestId, action, input, host);
  if (action === "chat.card") {
    if (
      !host.postCard ||
      !(host.isMono(source.id) || host.isHabitRun?.(source.id))
    )
      throw new Error("Only a Mono can put cards in its chat");
    const card = parseCard(input);
    host.postCard(source.id, card);
    return {
      posted: card.type,
      note: host.isMono(source.id)
        ? "It shows in the chat where you are in your reply."
        : "It goes out with your report, after its text; if you stay quiet, it is dropped.",
    };
  }
  if (action === "monos.propose")
    // One way to make a Mono (Board 22 Oct): with Ash in the Mono's chat. Proposals on Settings > Teams are gone.
    throw new Error(forUser(MONO_ONE_WAY));
  switch (action) {
    case "app.version": {
      // Which app this is and the build it runs (src-tauri/src/instance.rs).
      const identity: AppIdentity | null = host.identity
        ? host.identity()
        : appIdentity();
      if (!identity)
        throw new Error("This build doesn't report its identity");
      const ship = host.shipStatus?.();
      return ship === undefined ? identity : { ...identity, ship };
    }
    case "app.ship": {
      // The daily app replaces itself with the build in this checkout, safely (src-tauri/src/ship.rs). This turn is
      // cut by the restart and resumes once, with the receipt.
      shipCaller(source, host);
      const identity = host.identity ? host.identity() : appIdentity();
      if (identity?.kind === "dev")
        throw new Error(
          "Only the daily app takes a ship; this dev copy runs from its worktree (npm run hub:dev).",
        );
      if (!host.ship) throw new Error("This build can't ship");
      const whenBusy = input.whenBusy;
      // "restart" quits the app over chats still running: only Ash's Restart now tap does that.
      if (whenBusy === "restart")
        throw new Error(
          forUser('Only Ash\'s Restart now (at the top of the main pane) restarts the app over running chats. Ship with whenBusy "wait" (the default): it restarts when they are quiet.'),
        );
      if (whenBusy !== undefined && whenBusy !== "wait")
        throw new Error('whenBusy must be "wait"');
      const cwd = requireProject(source, input, host);
      const named = optionalString(input.worktree, "worktree", 4096);
      const own = source.worktreeCwd || source.cwd;
      const checkouts = [
        cwd,
        ...(await host.worktrees(cwd)).worktrees.map((tree) => tree.path),
      ];
      const repo = named ?? (checkouts.some((path) => pathKey(path) === pathKey(own)) ? own : cwd);
      if (!checkouts.some((path) => pathKey(path) === pathKey(repo)))
        throw new Error(
          `Not a checkout of this project. Ship from: ${checkouts.join(", ")}`,
        );
      const result = await host.ship({
        repo,
        requestedBy: source.id,
        ...(whenBusy ? { whenBusy } : {}),
      });
      return {
        ...(typeof result === "object" && result ? result : {}),
        note: "Scheduled. MonoCode Hub restarts for it when it's quiet; that cuts this turn, and it resumes once, with the receipt. Don't quit, kill or copy the app yourself.",
      };
    }
    case "models.list":
      await harnessesProbed();
      return {
        runtimeModes: RUNTIME_MODES.map((id) => ({
          id,
          label: RUNTIME_MODE_LABEL[id],
          description: RUNTIME_MODE_HINT[id],
        })),
        harnesses: HARNESSES.map((harness) => ({
          id: harness,
          available: isHarnessAvailable(harness),
          models: modelsFor(harness).map((model) => ({
            id: model.id,
            name: model.name,
            settings: model.settings ?? [],
          })),
        })),
      };
    case "sessions.list": {
      const cwd = requireProject(source, input, host);
      return { cwd, sessions: await host.sessions(cwd) };
    }
    case "sessions.read": {
      const id = requiredString(input.sessionId, "sessionId", 256);
      const target = id === source.id && host.isMono?.(id)
        ? source : await projectSession(source, id, input, host);
      const options = {
        before: optionalString(input.before, "before", 256),
        limit: input.limit as number | undefined,
        maxChars: input.maxChars as number | undefined,
      };
      return host.readConversation ? host.readConversation(target, options) : sessionConversationPage(target, options);
    }
    case "sessions.send": {
      const id = requiredString(input.sessionId, "sessionId", 256);
      const prompt = agentPrompt(input.prompt);
      const notifyMonoId = completionRecipient(source, input, host);
      if (id === source.id)
        throw new Error(
          "Use the current conversation to continue this session",
        );
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId))
        throw new Error("Invalid request ID");
      await projectSession(source, id, input, host);
      // A busy session takes the brief behind its work, or into it when asked: the sender hears which, never "busy".
      const mode = sendMode(input.mode);
      const result = await host.send(
        id,
        prompt,
        `app-${source.id}-${requestId}`,
        ...(notifyMonoId || mode !== "auto" ? [notifyMonoId] : []),
        ...(mode !== "auto" ? [mode] : []),
      );
      // A chat stopped on its own question to Ash is waiting on him, not busy with work.
      const asked = result.delivery === "queued" ? (await host.session(id).catch(() => null))?.pendingQuestion : undefined;
      return {
        sessionId: id,
        submitted: true,
        ...result,
        ...(notifyMonoId ? { notifyOnComplete: true } : {}),
        ...(asked
          ? { state: waitingOnAshLine(asked), note: `That session is ${waitingOnAshLine(asked)}. This goes in as its own turn once he answers and it is idle. sessions.queue lists or cancels it.` }
          : result.delivery === "queued"
          ? { note: "Queued behind that session's current work; it goes in as its own turn when the session is idle. sessions.queue lists or cancels it." }
          : result.delivery === "steered"
            ? { note: "Steered into that session's running turn." }
            : {}),
      };
    }
    case "sessions.queue": {
      if (!host.queued || !host.unqueue)
        throw new Error("This build can't list queued briefs");
      const cancel = optionalString(input.cancel, "cancel", 300);
      if (cancel !== undefined) {
        // The caller's own request ids only: sessions.send gave it `app-<caller>-<id>`, and either form is accepted.
        const own = cancel.startsWith(`app-${source.id}-`) ? cancel : `app-${source.id}-${cancel}`;
        if (!/^[A-Za-z0-9_-]{1,300}$/.test(own)) throw new Error("Invalid request ID");
        const removed = await host.unqueue(source.id, own);
        if (!removed)
          throw new Error(
            "No queued brief of yours with that request id. It may have gone in already: sessions.queue lists what still waits.",
          );
        return { cancelled: own };
      }
      const sessionId = optionalString(input.sessionId, "sessionId", 256);
      if (sessionId !== undefined) await projectSession(source, sessionId, input, host);
      const briefs = await host.queued(source.id, sessionId);
      return {
        briefs,
        ...(briefs.length ? {} : { note: "Nothing of yours is waiting in a queue." }),
      };
    }
    case "sessions.draft": {
      const id = requiredString(input.sessionId, "sessionId", 256);
      const prompt = agentPrompt(input.prompt);
      if (id === source.id)
        throw new Error("Use the composer to save a draft in this session");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId))
        throw new Error("Invalid request ID");
      await projectSession(source, id, input, host);
      const result = await host.draft(
        id,
        prompt,
        `app-${source.id}-${requestId}`,
      );
      return { sessionId: id, saved: true, ...result };
    }
    case "sessions.stop":
    case "sessions.archive":
    case "sessions.delete": {
      const id = requiredString(input.sessionId, "sessionId", 256);
      if (id === source.id)
        throw new Error("Cannot stop, archive or delete the calling session");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId))
        throw new Error("Invalid request ID");
      const target = await projectSession(source, id, input, host);
      if (
        target.orchestrationLeadId ||
        host.isMono(id) ||
        host.isHabitRun?.(id)
      )
        throw new Error("Only regular project sessions can be managed here");
      if (action === "sessions.stop") {
        if (input.cascade !== undefined && typeof input.cascade !== "boolean")
          throw new Error("cascade must be a boolean");
        if (input.cascade === true) {
          if (!host.stopTree)
            throw new Error("This build can't stop a session's tree; stop each session instead");
          const { stopFailed, cancelled, unloaded } = await host.stopTree(id);
          return {
            sessionId: id,
            stopped: !stopFailed.includes(id),
            cascade: true,
            cancelled: cancelled.length,
            stopFailed,
            // The workers beneath couldn't be read: the Stop reached the session, maybe not them.
            ...(unloaded?.length
              ? {
                  unloaded,
                  note: unloaded
                    .map((chat) => `Couldn't load the workers under ${chat}; they may still be running.`)
                    .join(" "),
                }
              : {}),
          };
        }
        await host.stop(id);
        return { sessionId: id, stopped: true };
      }
      const mode = action === "sessions.archive" ? "archive" : "delete";
      await host.remove(id, mode);
      return {
        sessionId: id,
        [mode === "archive" ? "archived" : "deleted"]: true,
      };
    }
    case "sessions.start": {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId))
        throw new Error(
          "request ID must use letters, digits, underscores or hyphens",
        );
      await harnessesProbed();
      const launch = startLaunch(source, input, host);
      const notifyMonoId = completionRecipient(source, input, host, true);
      if (input.worktreeCwd !== undefined) {
        const chosen = (await host.worktrees(launch.cwd)).worktrees.find(
          (tree) =>
            !tree.missing &&
            pathKey(tree.path) === pathKey(launch.worktreeCwd!),
        );
        if (!chosen)
          throw new Error(
            "Worktree is unavailable in this project; run worktrees.list",
          );
        launch.worktreeCwd =
          pathKey(chosen.path) === pathKey(launch.cwd)
            ? undefined
            : chosen.path;
      }
      const placement = input.placement ?? "tab";
      if (placement !== "tab" && placement !== "right" && placement !== "down")
        throw new Error("placement must be tab, right or down");
      if (input.besideSessionId !== undefined && placement === "tab")
        throw new Error("besideSessionId requires placement right or down");
      const besideSessionId =
        placement === "tab"
          ? undefined
          : (optionalString(input.besideSessionId, "besideSessionId", 256) ??
            source.id);
      const id = `app-${source.id}-${requestId}`;
      // WP-141 MEDIUM 5: a session start is gated like a worker, before its process starts.
      await gateSessionStart(host, source, launch.harness, launch.cwd, id);
      if (besideSessionId)
        await host.start(
          launch,
          id,
          { direction: placement as SplitDir, besideSessionId },
          ...(notifyMonoId ? [notifyMonoId] : []),
        );
      else if (notifyMonoId) await host.start(launch, id, undefined, notifyMonoId);
      else await host.start(launch, id);
      fileStarted(source, launch, id, host);
      const effort =
        launch.model && launch.modelSettings
          ? modelEffortLabel(resolveModel(launch.harness, launch.model), launch.modelSettings)
          : undefined;
      return {
        id,
        cwd: launch.cwd,
        harness: launch.harness,
        model: launch.model,
        ...(effort ? { effort } : {}),
        submitted: !launch.draft,
        draft: !!launch.draft,
        ...(notifyMonoId ? { notifyOnComplete: true } : {}),
      };
    }
    case "worktrees.list":
      return host.worktrees(requireProject(source, input, host));
    case "worktrees.create": {
      const cwd = requireProject(source, input, host);
      const branch = requiredString(input.branch, "branch", 400);
      const existing = input.existing ?? false;
      if (typeof existing !== "boolean")
        throw new Error("existing must be a boolean");
      const base = optionalString(input.base, "base", 400);
      if (existing && base)
        throw new Error("base cannot be set for an existing branch");
      const runSetup = input.runSetup ?? true;
      if (typeof runSetup !== "boolean")
        throw new Error("runSetup must be a boolean");
      const tree = await host.createWorktree(
        cwd,
        branch,
        base ?? "HEAD",
        existing,
        ...(runSetup ? [] : [{ runSetup: false }]),
      );
      const run = tree.setup?.run;
      return run && run.status === "running"
        ? {
            ...tree,
            setupNote: `${tree.setup?.name ?? "Setup"} is running in the new worktree (run ${run.id}). actions.list shows when it ends; start work there after it finishes.`,
          }
        : tree;
    }
    case "stacks.list": {
      const cwd = requireProject(source, input, host);
      if (!host.stacks) throw new Error("Stacks aren't available in this app");
      // Read only: the same status the stack card shows, names and fake services included.
      return host.stacks(cwd);
    }
    case "actions.list": {
      const cwd = requireProject(source, input, host);
      if (!host.projectActions)
        throw new Error("Project actions aren't available in this app");
      return actionsListing(await host.projectActions(cwd));
    }
    case "actions.run": {
      const cwd = requireProject(source, input, host);
      if (!host.runProjectAction)
        throw new Error("Project actions aren't available in this app");
      const actionId = requiredString(input.action, "action", 64);
      const waitSeconds = input.waitSeconds ?? 0;
      if (
        !Number.isInteger(waitSeconds) ||
        (waitSeconds as number) < 0 ||
        (waitSeconds as number) > 25
      )
        throw new Error("waitSeconds must be an integer from 0 to 25");
      // An action that asks before it runs (`confirm`, like Ship) runs only from Ash's own tap, never for an agent.
      if (!host.projectActions)
        throw new Error("Project actions aren't available in this app");
      const listed = (await host.projectActions(cwd)).actions.find(
        (action) => action.id === actionId,
      );
      if (listed?.confirm)
        throw new Error(forUser`${listed.name} asks Ash first; ask him in your chat`);
      // A session working in its own worktree runs actions there by default.
      let checkout =
        !host.monoOf?.(source.id) &&
        source.worktreeCwd &&
        !source.worktreeRemoved &&
        pathKey(source.cwd) === pathKey(cwd)
          ? source.worktreeCwd
          : cwd;
      if (input.worktreeCwd !== undefined) {
        const wanted = requiredString(input.worktreeCwd, "worktreeCwd", 4096);
        const chosen = (await host.worktrees(cwd)).worktrees.find(
          (tree) => !tree.missing && pathKey(tree.path) === pathKey(wanted),
        );
        if (!chosen)
          throw new Error(
            "Worktree is unavailable in this project; run worktrees.list",
          );
        checkout = chosen.path;
      }
      let run = await host.runProjectAction(checkout, actionId);
      if (
        (waitSeconds as number) > 0 &&
        run.status === "running" &&
        host.waitProjectAction
      )
        run = await host.waitProjectAction(run.id, (waitSeconds as number) * 1000);
      return actionRunSummary(run);
    }
    case "folders.list": {
      const cwd = requireProject(source, input, host);
      return {
        cwd,
        folders: loadSessionFolders(cwd).map(({ id, name, sessionIds }) => ({
          id,
          name,
          sessionIds,
        })),
      };
    }
    case "folders.move": {
      const cwd = requireProject(source, input, host);
      const sessionId = requiredString(input.sessionId, "sessionId", 256);
      const folderId = optionalString(input.folderId, "folderId", 256);
      const newFolderName = optionalString(
        input.newFolderName,
        "newFolderName",
        100,
      );
      if (!!folderId === !!newFolderName)
        throw new Error("Supply exactly one of folderId or newFolderName");
      if (
        !(await host.sessions(cwd)).some((session) => session.id === sessionId)
      )
        throw new Error("Session was not found in this project");
      const folders = loadSessionFolders(cwd);
      if (folderId && !folders.some((folder) => folder.id === folderId))
        throw new Error("Folder was not found in this project");
      const next = placeSessionInFolder(
        folders,
        sessionId,
        folderId
          ? { kind: "existing", folderId }
          : { kind: "new", name: newFolderName! },
      );
      saveSessionFolders(cwd, next);
      const folder = next.find((entry) => entry.sessionIds.includes(sessionId));
      return { sessionId, folderId: folder?.id, folderName: folder?.name };
    }
    case "notes.list": {
      const limit = input.limit ?? 30;
      const offset = input.offset ?? 0;
      if (
        !Number.isInteger(limit) ||
        (limit as number) < 1 ||
        (limit as number) > 100
      )
        throw new Error("limit must be an integer from 1 to 100");
      if (!Number.isInteger(offset) || (offset as number) < 0)
        throw new Error("offset must be a non-negative integer");
      const notes = await host.notes();
      return {
        total: notes.length,
        offset,
        notes: notes
          .slice(offset as number, (offset as number) + (limit as number))
          .map((note) => ({
            id: note.id,
            title: note.title,
            preview: notePreview(note.body),
            tags: note.tags,
            sourceCwd: note.sourceCwd,
          })),
      };
    }
    case "notes.read": {
      const id = requiredString(input.id, "id", 256);
      const note = await host.note(id);
      if (!note) throw new Error("Note was not found");
      return note;
    }
    case "notes.write": {
      const id = optionalString(input.id, "id", 256);
      if (id && !/^[A-Za-z0-9_-]+$/.test(id))
        throw new Error("Invalid note ID");
      const title =
        input.title === undefined
          ? undefined
          : requiredString(input.title, "title", 200);
      const body = input.body === undefined ? undefined : noteBody(input.body);
      const tags = input.tags === undefined ? undefined : noteTags(input.tags);
      if (id) {
        if (title === undefined && body === undefined && tags === undefined)
          throw new Error("Supply title, body or tags to update a note");
        const current = await host.note(id);
        if (!current) throw new Error("Note was not found");
        return host.saveNote({
          id,
          title: title ?? current.title,
          body: body ?? current.body,
          tags: tags ?? current.tags,
        });
      }
      if (body === undefined)
        throw new Error("body is required to create a note");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId))
        throw new Error("Invalid request ID");
      const createdId = `app-${source.id}-${requestId}`;
      const existing = await host.note(createdId);
      if (existing) {
        if (
          existing.title !== (title ?? noteTitle(body)) ||
          existing.body !== body ||
          JSON.stringify(existing.tags) !== JSON.stringify(tags ?? [])
        )
          throw new Error("Request ID was already used for another note");
        return existing;
      }
      return host.saveNote({
        id: createdId,
        title: title ?? noteTitle(body),
        body,
        tags: tags ?? [],
        sourceSessionId: source.id,
        ...(looksLikeProject(source.cwd) ? { sourceCwd: source.cwd } : {}),
      });
    }
  }
}
