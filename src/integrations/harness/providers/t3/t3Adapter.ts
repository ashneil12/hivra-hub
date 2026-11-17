// Dropwave on T3 Code: the same screens, another engine. A chat's turns go to a T3 Code server instead of a CLI this
// app starts itself. One chat is one T3 thread; what the thread does comes back as the harness events every screen
// already draws (t3Events.ts), over T3's own client wire (t3Rpc.ts). Nothing above the adapter changes.
//
// For now only a dev page that names an engine in its address uses it (`t3Engine`); the installed app is unchanged.
import type { HarnessId, RuntimeMode } from "../../../../features/sessions/model/session";
import type { HarnessAdapter } from "../../core/registry";
import type { HarnessEvent, SendTurnInput, SteerTurnInput } from "../../core/types";
import { modelsFor, nativeModelId, setHarnessModels } from "../../../../features/sessions/model/models";
import { t3Message } from "./t3Context";
import { markT3ItemSeen, t3CrewTitle, t3ItemDone, t3ItemEvents, type T3Item, type T3Seen } from "./t3Events";
import { T3_DRIVER, t3Model, t3Options, t3PickerModels, t3Provider, t3ProviderProblem, type T3Provider } from "./t3Models";
import { connectT3, type T3Rpc, type T3Socket } from "./t3Rpc";

export type T3Engine = {
  /** The T3 server, e.g. http://127.0.0.1:13773. */
  origin: string;
  /** A session token for it (`t3 auth session issue`). The desktop shell will hand this over itself. */
  token: string;
  /** Run every chat on this T3 provider and model instead of its own (the dev page's replay provider). */
  provider?: string;
  model?: string;
  /** The T3 project (its folder) for a chat whose folder T3 does not know. */
  project?: string;
};

/** The engine this dev page was asked to use: `?t3=<origin>&t3token=<token>` (+ t3provider, t3model, t3project). */
export function t3Engine(search: string = typeof location === "undefined" ? "" : location.search): T3Engine | null {
  const params = new URLSearchParams(search);
  const token = params.get("t3token");
  if (!params.has("t3") || !token) return null;
  return {
    origin: (params.get("t3") || "http://127.0.0.1:13773").replace(/\/+$/, ""),
    token,
    provider: params.get("t3provider") || undefined,
    model: params.get("t3model") || undefined,
    project: params.get("t3project") || undefined,
  };
}

/** T3's word for each permission mode. */
const T3_RUNTIME_MODE: Record<RuntimeMode, string> = {
  supervised: "approval-required",
  "auto-accept-edits": "auto-accept-edits",
  auto: "auto",
  "full-access": "full-access",
};

const RUN_ENDED = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);

type T3Run = { id: string; status: string };
type T3Selection = { instanceId: string; model: string; options?: Array<{ id: string; value: string | boolean }> };
/** What the thread is set to, as its snapshot says. */
type T3Thread = { runtimeMode?: string; modelSelection?: T3Selection };
type T3Node = { id?: string; status?: string };
type T3Frame =
  | { kind: "snapshot"; projection: { turnItems: T3Item[]; runs: T3Run[]; thread?: T3Thread; nodes?: T3Node[] } }
  | { kind: "event"; event: { type: string; payload: unknown } }
  | { kind: string };

type Live = { threadId: string; runId?: string; abort: AbortController };

/**
 * A crew member the engine started in a conversation of its own, and the chat that shows it here. The chat's first
 * turn follows that conversation; `end` closes the follow once the first mate's side says the member is done.
 */
type CrewChat = {
  threadId: string;
  /** The member's node in the engine: its own conversation says through it when the member ends. */
  nodeId?: string;
  /** The first mate's chat that started it. */
  owner: string;
  followed: boolean;
  done: boolean;
  /** It ended without finishing: stopped with its first mate, interrupted or failed. */
  stopped?: boolean;
  result?: string;
  end?: () => void;
};

/** How a crew member's node reads when it ended without finishing. */
const CREW_STOPPED = new Set(["interrupted", "failed", "cancelled", "rolled_back"]);
const CREW_READ_ONLY = "This crew member is run by its first mate and can't take messages. Message the first mate instead.";

const uuid = () => crypto.randomUUID();

/** Two selections that run the same model the same way, whatever order their options come in. */
function sameSelection(a: T3Selection, b: T3Selection): boolean {
  const options = (selection: T3Selection) =>
    JSON.stringify([...(selection.options ?? [])].sort((x, y) => x.id.localeCompare(y.id)));
  return a.instanceId === b.instanceId && a.model === b.model && options(a) === options(b);
}

/** The chat's name in T3's own list until the app passes its real one: its id, made readable. */
function chatTitle(sessionId: string): string {
  const words = sessionId.trim().replace(/[-_]+/g, " ") || "Chat";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function createT3Adapter(
  id: HarnessId,
  engine: T3Engine,
  rpc: T3Rpc = connectT3(engine.origin, engine.token, {
    fetch: (input, init) => fetch(input, init),
    socket: (url) => new WebSocket(url) as unknown as T3Socket,
  }),
): HarnessAdapter {
  /** Chat -> T3 thread. The app keeps the thread id as the chat's provider session id and hands it back on relaunch. */
  const threads = new Map<string, string>();
  const live = new Map<string, Live>();
  /** This app names a question or approval by a number; T3 by a request id on a thread. */
  const asks = new Map<number, { threadId: string; requestId: string }>();
  const askNumbers = new Map<string, number>();
  let projects: Promise<Array<{ id: string; workspaceRoot: string }>> | undefined;
  /** Crew chats by their chat id, and the chat each child conversation already has. */
  const crew = new Map<string, CrewChat>();
  const crewChatOf = new Map<string, string>();

  /** The number this app's question and approval cards go by, for a request on a thread. */
  const askNumber = (threadId: string, requestId: string): number => {
    const known = askNumbers.get(requestId);
    if (known !== undefined) return known;
    const number = askNumbers.size + 1;
    askNumbers.set(requestId, number);
    asks.set(number, { threadId, requestId });
    return number;
  };

  const dispatch = (command: Record<string, unknown>) =>
    rpc.call("orchestration.dispatchCommand", { commandId: uuid(), ...command });

  async function projectFor(cwd: string): Promise<string> {
    projects ??= rpc
      .get<{ projects: Array<{ id: string; workspaceRoot: string }> }>("/api/orchestration/shell")
      .then((shell) => shell.projects);
    const known = await projects.catch((error: unknown) => {
      projects = undefined;
      throw error;
    });
    const project =
      known.find((candidate) => candidate.workspaceRoot === cwd) ??
      known.find((candidate) => candidate.workspaceRoot === engine.project);
    if (!project) {
      projects = undefined;
      throw new Error(`The engine has no project for ${cwd}.`);
    }
    return project.id;
  }

  /** The engine's providers and their models, or nothing when it will not say. */
  const engineProviders = () =>
    rpc
      .call<{ providers?: T3Provider[] }>("server.getConfig", {})
      .then((config) => (Array.isArray(config?.providers) ? config.providers : undefined))
      .catch(() => undefined);

  /**
   * These screens draw a reply as it is written. Dropwave's engine can deliver it that way (its "live" mode); asked
   * once, and an engine without that mode keeps its own.
   */
  let liveTextAsked: Promise<void> | undefined;
  const liveText = () =>
    (liveTextAsked ??= rpc.call("server.updateSettings", { patch: { responseStreamingMode: "live" } }).then(
      () => undefined,
      () => undefined,
    ));

  /**
   * The engine's provider, model and options for what the chat's picker says. A provider the engine has switched off
   * or never installed is said here, in the chat, instead of as a run that fails.
   */
  async function selectionFor(input: { model: string; modelSettings?: Record<string, string> }): Promise<T3Selection> {
    const providers = await engineProviders();
    const provider = providers ? t3Provider(id, providers, engine.provider) : undefined;
    if (providers) {
      const problem = t3ProviderProblem(engine.provider ?? id, provider);
      if (problem) throw new Error(problem);
    }
    // The chat names its model by this app's key (`claude:opus-5-5`); the engine knows the provider's own id.
    const wanted = engine.model ?? nativeModelId(input.model);
    const model = t3Model(provider, wanted);
    const options = t3Options(model, input.modelSettings);
    return {
      instanceId: provider?.instanceId ?? engine.provider ?? T3_DRIVER[id] ?? id,
      model: model?.slug ?? wanted,
      ...(options.length > 0 ? { options } : {}),
    };
  }

  /** The picker shows what the engine can run for this provider. */
  async function refreshCatalog(): Promise<void> {
    const provider = t3Provider(id, (await engineProviders()) ?? []);
    if (!provider || !provider.enabled) return;
    const models = t3PickerModels(id, provider, modelsFor(id));
    if (models.length > 0) setHarnessModels(id, models);
  }

  /**
   * A crew member with a conversation of its own gets a chat here, once: the app opens it under the first mate. When
   * the member finishes, the chat's follow is told so it can end.
   */
  function crewMember(owner: string, item: T3Item, emit: (event: HarnessEvent) => void): void {
    const childThreadId = item.childThreadId;
    if (item.type !== "subagent" || !childThreadId) return;
    let sessionId = crewChatOf.get(childThreadId);
    if (!sessionId) {
      sessionId = uuid();
      crewChatOf.set(childThreadId, sessionId);
      crew.set(sessionId, { threadId: childThreadId, nodeId: item.subagentId, owner, followed: false, done: false });
      threads.set(sessionId, childThreadId);
      emit({ type: "crew.started", callId: item.id, sessionId, title: t3CrewTitle(item), brief: item.prompt ?? "" });
    }
    const chat = crew.get(sessionId);
    if (chat && !chat.done && t3ItemDone(item)) {
      chat.done = true;
      chat.stopped = item.status !== "completed";
      chat.result = item.result?.trim() || undefined;
      chat.end?.();
    }
  }

  /** A first mate's turn that was stopped or failed takes its crew with it: no member is left reading as working. */
  function stopCrewOf(owner: string): void {
    for (const chat of crew.values()) {
      if (chat.owner !== owner || chat.done) continue;
      chat.done = true;
      chat.stopped = true;
      chat.end?.();
    }
  }

  /**
   * A crew chat's first turn: nothing is sent. It plays what the crew member has done and goes on doing, until the
   * first mate's side says it is done or the member's own conversation does (its node ends; a child conversation has
   * no runs of its own); then what is left is read once more, so nothing said at the very end is lost. A member that
   * wrote no reply of its own shows the report it handed back; one that was stopped says so.
   */
  async function followCrew(input: SendTurnInput, chat: CrewChat): Promise<void> {
    chat.followed = true;
    const abort = new AbortController();
    const state: Live = { threadId: chat.threadId, abort };
    live.set(input.sessionId, state);
    const seen = new Map<string, T3Seen>();
    let said = false;
    const emit = (event: HarnessEvent) => {
      if (event.type === "message.delta") said = true;
      input.onEvent(event);
    };
    const ask = (requestId: string) => askNumber(chat.threadId, requestId);
    const play = (item: T3Item) => t3ItemEvents(item, seen, ask).forEach(emit);
    const snapshot = (frame: T3Frame) =>
      frame.kind === "snapshot" && "projection" in frame ? frame.projection : undefined;
    let ended = false;
    chat.end = () => {
      ended = true;
      abort.abort();
    };
    /** The member's own node finished: its closing message is the next thing its conversation sends. */
    let closing = false;
    /** False once the member's node says it ended without finishing. */
    const node = (value: T3Node): boolean => {
      if (!chat.nodeId || value.id !== chat.nodeId || !value.status) return true;
      if (value.status === "completed") closing = true;
      if (!CREW_STOPPED.has(value.status)) return true;
      chat.done = true;
      chat.stopped = true;
      return false;
    };
    try {
      emit({ type: "session.providerBound", providerSessionId: chat.threadId });
      input.onAccepted?.();
      emit({ type: "session.started" });
      await rpc.stream(
        "orchestration.subscribeThread",
        { threadId: chat.threadId },
        (value) => {
          const frame = value as T3Frame;
          const whole = snapshot(frame);
          if (whole) {
            whole.turnItems.forEach(play);
            const runs = whole.runs;
            const going = (whole.nodes ?? []).every(node);
            return going && !chat.done && !(runs.length > 0 && runs.every((run) => RUN_ENDED.has(run.status)));
          }
          if (frame.kind !== "event" || !("event" in frame)) return true;
          const { type, payload } = frame.event;
          if (type === "node.updated") return node(payload as T3Node);
          if (type === "turn-item.updated") {
            const item = payload as T3Item;
            play(item);
            if (closing && item.type === "assistant_message" && t3ItemDone(item)) {
              chat.done = true;
              return false;
            }
          } else if (type === "run.created" || type === "run.updated") {
            const run = payload as T3Run;
            if (state.runId !== run.id) state.runId = run.id;
            return !RUN_ENDED.has(run.status);
          }
          return true;
        },
        abort.signal,
      );
      if (ended) {
        // The first mate heard the report; the member's last lines may have arrived after the follow was closed.
        await rpc.stream("orchestration.subscribeThread", { threadId: chat.threadId }, (value) => {
          snapshot(value as T3Frame)?.turnItems.forEach(play);
          return false;
        });
      }
    } catch (error) {
      if (!chat.done) emit({ type: "session.error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      chat.end = undefined;
      if (!said && chat.result) {
        emit({ type: "message.delta", text: chat.result });
        emit({ type: "message.completed" });
      } else if (chat.stopped) emit({ type: "turn.stopped", text: "Stopped before it finished." });
      if (live.get(input.sessionId) === state) live.delete(input.sessionId);
    }
  }

  async function sendTurn(input: SendTurnInput): Promise<void> {
    const waiting = crew.get(input.sessionId);
    if (waiting && !waiting.followed) return followCrew(input, waiting);
    if (waiting) {
      // The engine runs this member for its first mate; its conversation takes no messages.
      input.onEvent({ type: "session.error", message: CREW_READ_ONLY, retryable: false });
      return;
    }
    const abort = new AbortController();
    const seen = new Map<string, T3Seen>();
    const oldRuns = new Set<string>();
    const emit = (event: HarnessEvent) => input.onEvent(event);
    const ask = (requestId: string) => askNumber(threadId, requestId);
    const existing = threads.get(input.sessionId);
    const threadId = existing ?? uuid();
    const state: Live = { threadId, abort };
    live.set(input.sessionId, state);
    let sent = false;
    /** The turn's run completed; anything else (a stop, a failure, a dropped connection) takes the crew with it. */
    let finished = false;

    try {
      const selection = await selectionFor(input);
      await liveText();
      const runtimeMode = T3_RUNTIME_MODE[input.runtimeMode] ?? "approval-required";
      if (!existing) {
        await rpc.call("orchestration.launchThread", {
          commandId: uuid(),
          threadId,
          projectId: await projectFor(input.cwd),
          title: chatTitle(input.sessionId),
          modelSelection: selection,
          runtimeMode,
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { ...t3Message(input.text), attachments: [] },
        });
        threads.set(input.sessionId, threadId);
        sent = true;
        emit({ type: "session.providerBound", providerSessionId: threadId });
        input.onAccepted?.();
      }
      emit({ type: "session.started" });

      const item = (value: T3Item) => {
        t3ItemEvents(value, seen, ask).forEach(emit);
        crewMember(input.sessionId, value, emit);
      };
      /** False once the run this turn started has ended. */
      const run = (value: T3Run, created: boolean): boolean => {
        if (oldRuns.has(value.id)) return true;
        if (state.runId !== value.id && (created || state.runId === undefined)) {
          state.runId = value.id;
          emit({ type: "turn.started", providerTurnId: value.id });
        }
        if (value.id === state.runId && value.status === "completed") finished = true;
        return !RUN_ENDED.has(value.status);
      };

      await rpc.stream(
        "orchestration.subscribeThread",
        { threadId },
        async (value) => {
          const frame = value as T3Frame;
          if (frame.kind === "snapshot" && "projection" in frame) {
            if (sent) {
              // A thread this turn just started: all of it is this turn.
              frame.projection.turnItems.forEach(item);
              return frame.projection.runs.every((candidate) => run(candidate, false));
            }
            // An older thread: what is there is already on screen. Then the message goes in.
            for (const old of frame.projection.turnItems) markT3ItemSeen(old, seen);
            for (const old of frame.projection.runs) oldRuns.add(old.id);
            // The picker or the permission mode changed since the thread last ran: the thread follows.
            const set = frame.projection.thread;
            if (set?.runtimeMode && set.runtimeMode !== runtimeMode)
              await dispatch({ type: "thread.runtime-mode.set", threadId, runtimeMode });
            const switched = set?.modelSelection && !sameSelection(set.modelSelection, selection);
            await dispatch({
              type: "message.dispatch",
              threadId,
              messageId: uuid(),
              ...t3Message(input.text),
              attachments: [],
              ...(switched ? { modelSelection: selection } : {}),
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "web",
            });
            sent = true;
            input.onAccepted?.();
            return true;
          }
          if (frame.kind !== "event" || !("event" in frame)) return true;
          const { type, payload } = frame.event;
          if (type === "turn-item.updated") item(payload as T3Item);
          else if (type === "run.created" || type === "run.updated") return run(payload as T3Run, type === "run.created");
          return true;
        },
        abort.signal,
      );
    } catch (error) {
      if (!abort.signal.aborted)
        emit({ type: "session.error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (live.get(input.sessionId) === state) live.delete(input.sessionId);
      if (!finished) stopCrewOf(input.sessionId);
    }
  }

  /** A follow-up while the agent works goes into the running turn. */
  async function steerTurn(input: SteerTurnInput): Promise<void> {
    const state = live.get(input.sessionId);
    if (!state?.runId) throw new Error("Nothing is running in this chat to steer.");
    await dispatch({
      type: "message.dispatch",
      threadId: state.threadId,
      messageId: uuid(),
      ...t3Message(input.text),
      attachments: [],
      dispatchMode: { type: "steer_active", targetRunId: state.runId },
      createdBy: "user",
      creationSource: "web",
    });
  }

  /** Stops the run and lets the turn end by itself when T3 says the run was interrupted. */
  async function cancelTurn(sessionId: string): Promise<void> {
    const state = live.get(sessionId);
    if (!state) return;
    if (state.runId) await dispatch({ type: "run.interrupt", threadId: state.threadId, runId: state.runId });
    else state.abort.abort();
  }

  async function stopSession(sessionId: string): Promise<void> {
    const state = live.get(sessionId);
    if (!state) return;
    await rpc.call("orchestration.forceStopThread", { threadId: state.threadId }).catch(() => undefined);
    state.abort.abort();
    live.delete(sessionId);
  }

  const respond = (requestId: number, answer: Record<string, unknown>, type = "runtime-request.respond") => {
    const asked = asks.get(requestId);
    if (!asked) return false;
    void dispatch({ type, threadId: asked.threadId, requestId: asked.requestId, ...answer }).catch(() => undefined);
    return true;
  };

  return {
    id,
    live: true,
    sendTurn,
    refreshCatalog,
    steerTurn,
    cancelTurn,
    respondApproval: (_sessionId, requestId, decision) =>
      respond(requestId, { decision: decision === "allow" ? "accept" : "decline" }),
    respondQuestion: (_sessionId, requestId, reply) => {
      if (reply.kind === "skipped") return void respond(requestId, {}, "thread.user-input.dismiss");
      // T3 takes each answer as the picked label, or a list when several were picked or one was typed too.
      const answers = Object.fromEntries(
        Object.entries(reply.answers).map(([questionId, picked]) => {
          const typed = reply.custom?.[questionId];
          const all = typed ? [...picked, typed] : picked;
          return [questionId, all.length === 1 ? all[0] : all];
        }),
      );
      for (const [questionId, typed] of Object.entries(reply.custom ?? {})) {
        if (!(questionId in answers) && typed) answers[questionId] = typed;
      }
      respond(requestId, { answers });
    },
    stopSession,
    forgetSession: async (sessionId) => {
      await stopSession(sessionId);
      threads.delete(sessionId);
      crew.delete(sessionId);
    },
    bindSession: (sessionId, providerSessionId) => void threads.set(sessionId, providerSessionId),
  };
}
