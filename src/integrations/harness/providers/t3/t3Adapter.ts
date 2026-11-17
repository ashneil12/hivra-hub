// Dropwave on T3 Code: the same screens, another engine. A chat's turns go to a T3 Code server instead of a CLI this
// app starts itself. One chat is one T3 thread; what the thread does comes back as the harness events every screen
// already draws (t3Events.ts), over T3's own client wire (t3Rpc.ts). Nothing above the adapter changes.
//
// For now only a dev page that names an engine in its address uses it (`t3Engine`); the installed app is unchanged.
import type { HarnessId, RuntimeMode } from "../../../../features/sessions/model/session";
import type { HarnessAdapter } from "../../core/registry";
import type { HarnessEvent, SendTurnInput, SteerTurnInput } from "../../core/types";
import { modelsFor, setHarnessModels } from "../../../../features/sessions/model/models";
import { markT3ItemSeen, t3ItemEvents, type T3Item, type T3Seen } from "./t3Events";
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
type T3Frame =
  | { kind: "snapshot"; projection: { turnItems: T3Item[]; runs: T3Run[]; thread?: T3Thread } }
  | { kind: "event"; event: { type: string; payload: unknown } }
  | { kind: string };

type Live = { threadId: string; runId?: string; abort: AbortController };

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
    const wanted = engine.model ?? input.model;
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

  async function sendTurn(input: SendTurnInput): Promise<void> {
    const abort = new AbortController();
    const seen = new Map<string, T3Seen>();
    const oldRuns = new Set<string>();
    const emit = (event: HarnessEvent) => input.onEvent(event);
    const ask = (requestId: string) => {
      const known = askNumbers.get(requestId);
      if (known !== undefined) return known;
      const number = askNumbers.size + 1;
      askNumbers.set(requestId, number);
      asks.set(number, { threadId, requestId });
      return number;
    };
    const existing = threads.get(input.sessionId);
    const threadId = existing ?? uuid();
    const state: Live = { threadId, abort };
    live.set(input.sessionId, state);
    let sent = false;

    try {
      const selection = await selectionFor(input);
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
          initialMessage: { text: input.text, attachments: [] },
        });
        threads.set(input.sessionId, threadId);
        sent = true;
        emit({ type: "session.providerBound", providerSessionId: threadId });
        input.onAccepted?.();
      }
      emit({ type: "session.started" });

      const item = (value: T3Item) => t3ItemEvents(value, seen, ask).forEach(emit);
      /** False once the run this turn started has ended. */
      const run = (value: T3Run, created: boolean): boolean => {
        if (oldRuns.has(value.id)) return true;
        if (state.runId !== value.id && (created || state.runId === undefined)) {
          state.runId = value.id;
          emit({ type: "turn.started", providerTurnId: value.id });
        }
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
              text: input.text,
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
      text: input.text,
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
    },
    bindSession: (sessionId, providerSessionId) => void threads.set(sessionId, providerSessionId),
  };
}
