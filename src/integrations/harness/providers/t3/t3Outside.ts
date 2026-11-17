// Turns the engine starts in a chat by itself: another chat's message to it (the Chief of Staff handing a job to a
// first mate with the engine's thread tools), a scheduled task, a wake after background work. The app sends nothing
// for these, so without this a chat would never show them. One watch per engine connection listens to the engine's
// list of conversations; when a chat's conversation gets a run its own turns did not start, the app is told, and the
// chat follows that run (`SendTurnInput.follow`) under a note that says who it came from.
import { t3AppId, t3EngineId } from "./t3Ids";
import type { T3Rpc } from "./t3Rpc";

export type T3OutsideTurn = {
  /** The chat it belongs in. */
  sessionId: string;
  /** The run, as the chat keeps it (`t3AppId`). */
  providerTurnId: string;
  /** The message that began it; empty when the engine began it with none (a wake). */
  text: string;
  /** The chat that sent it, when it is one this app shows. */
  fromSessionId?: string;
  /** A task the person scheduled in the engine began it. */
  scheduled?: boolean;
};

/** False when the chat could not take it now (it is busy with something else): the watch offers it again later. */
type Listener = (turn: T3OutsideTurn) => boolean;
const listeners = new Set<Listener>();

/** The app hears of every turn an engine began by itself. Returns how to stop hearing. */
export function onT3OutsideTurn(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

const tellApp: Listener = (turn) => [...listeners].map((listener) => listener(turn)).some(Boolean);

/**
 * A first mate's answer to a job another chat handed it through the engine, which that chat never heard: it had
 * stopped waiting (the engine ends one wait after about 45 seconds, and an agent gives up after a few) and nothing in
 * the engine wakes it when the job ends later.
 */
export type T3UnheardAnswer = {
  /** The chat that handed the job over. */
  sessionId: string;
  /** The chat that did it. */
  fromSessionId: string;
  /** The job's run in that chat, as the chat keeps it. */
  providerTurnId: string;
  /** Its last words in that run; empty when it wrote none. */
  text: string;
  /** False when the run was stopped or failed. */
  finished: boolean;
};

/** False when the chat that handed the job over is not open: the watch offers the answer again later. */
type AnswerListener = (answer: T3UnheardAnswer) => boolean;
const answerListeners = new Set<AnswerListener>();

/** The app hears of every answer the chat that asked did not. Returns how to stop hearing. */
export function onT3UnheardAnswer(listener: AnswerListener): () => void {
  answerListeners.add(listener);
  return () => void answerListeners.delete(listener);
}

const tellAnswer: AnswerListener = (answer) => [...answerListeners].map((listener) => listener(answer)).some(Boolean);

const REQUEST = "engine-turn-";

/** The request id of the app's turn that follows an engine's own run. A queued message keeps it, so the follow is never sent as a message. */
export function engineTurnRequestId(providerTurnId: string): string {
  return `${REQUEST}${providerTurnId}`;
}

/** The run a request id of that kind follows; none for any other request. */
export function engineTurnOf(appRequestId: string | undefined): string | undefined {
  return appRequestId?.startsWith(REQUEST) ? appRequestId.slice(REQUEST.length) || undefined : undefined;
}

type ShellThread = { id?: string; activeRunId?: string | null; latestRunId?: string | null };
type ShellFrame =
  | { kind: "snapshot"; snapshot?: { threads?: ShellThread[] } }
  | { kind: "thread.updated"; thread?: ShellThread }
  | { kind: string };
/** The message that began a run, as the conversation's record keeps it (a turn item of it exists only once the run starts). */
type Message = { role?: string; runId?: string | null; text?: string; createdAt?: string; senderThreadId?: string; scheduledTaskId?: string };
/** A tool call as the conversation keeps it. The engine's own tools for another conversation name it in `input`. */
type ToolItem = { type?: string; toolName?: string; input?: { threadId?: unknown } | null; completedAt?: string | null };
type Projection = { messages?: Message[]; runs?: Array<{ id: string; status?: string; completedAt?: string | null }>; turnItems?: ToolItem[] };
type ThreadFrame = { kind: string; projection?: Projection };

const RUN_ENDED = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);
/** The engine's tools an agent hears another conversation's answer with. */
const HEARS = /t3_thread_(?:wait|read)$/;

export type T3Watch = {
  /** A chat and its conversation in the engine. */
  know(sessionId: string, threadId: string): void;
  forget(sessionId: string): void;
  /** The chat's own turn is under way: what runs now is its own. */
  began(sessionId: string): void;
  /** That turn ended. A run that began behind it and it did not take is looked at now. */
  ended(sessionId: string): void;
  /** A run a chat's own turn started or follows. */
  own(runId: string): void;
  /** The chat a conversation of the engine belongs to, when it is one this app shows. */
  chatOf(threadId: string): string | undefined;
};

/**
 * Watches one engine. `tell` is who hears (the app, by default). A run still going is told whatever began it. One that
 * already ended (it ran while the app was closed) is told only when the app cannot have sent it: another conversation
 * or a scheduled task did, or it has no message at all. The app drops any run the chat already shows.
 */
export function createT3Watch(rpc: T3Rpc, tell: Listener = tellApp, tellUnheard: AnswerListener = tellAnswer): T3Watch {
  const chats = new Map<string, string>();
  const threadOf = new Map<string, string>();
  const own = new Set<string>();
  const told = new Set<string>();
  const busy = new Set<string>();
  /** Runs the app could not take, by where their conversation stood then: offered again once that changes. */
  const refused = new Map<string, string>();
  /** The engine's last word per conversation: the run going now, and the newest one. */
  const state = new Map<string, { active?: string; latest?: string }>();
  /** Jobs one chat handed another through the engine, by the run that does the job, until their answer is heard. */
  const handed = new Map<string, { threadId: string; sender: string }>();
  const settling = new Set<string>();
  let listening = false;

  const listen = () => {
    if (listening) return;
    listening = true;
    void rpc
      .stream("orchestration.subscribeShell", {}, (value) => {
        const frame = value as ShellFrame;
        const threads =
          frame.kind === "snapshot" && "snapshot" in frame
            ? (frame.snapshot?.threads ?? [])
            : frame.kind === "thread.updated" && "thread" in frame && frame.thread
              ? [frame.thread]
              : [];
        for (const thread of threads) {
          if (!thread.id) continue;
          state.set(thread.id, { active: thread.activeRunId ?? undefined, latest: thread.latestRunId ?? undefined });
          look(thread.id);
          settle(thread.id);
        }
        return true;
      })
      .catch(() => undefined)
      // The connection dropped or the engine went away: the next chat that is known starts the watch again.
      .finally(() => (listening = false));
  };

  const read = async (threadId: string): Promise<Projection | undefined> => {
    let projection: Projection | undefined;
    await rpc.stream("orchestration.subscribeThread", { threadId }, (value) => {
      const frame = value as ThreadFrame;
      if (frame.kind !== "snapshot" || !frame.projection) return true;
      projection = frame.projection;
      return false;
    });
    return projection;
  };

  /**
   * A handed job whose run has ended while the chat that handed it over is doing nothing: did that chat hear the
   * answer? It did when one of its waits on (or reads of) the job's conversation ended at or after the job did; a wait
   * that gave up ended before. An answer nobody heard is told to the app once.
   */
  const settle = (changed: string) => {
    for (const [runId, job] of handed) {
      if ((job.threadId !== changed && job.sender !== changed) || settling.has(runId)) continue;
      if (state.get(job.threadId)?.active === runId || state.get(job.sender)?.active) continue;
      settling.add(runId);
      void (async () => {
        const sessionId = chats.get(job.sender);
        const fromSessionId = chats.get(job.threadId);
        if (!sessionId || !fromSessionId) return void handed.delete(runId);
        const theirs = await read(job.threadId);
        const run = theirs?.runs?.find((candidate) => candidate.id === runId);
        if (!run) return void handed.delete(runId);
        if (!RUN_ENDED.has(run.status ?? "")) return;
        const endedAt = Date.parse(run.completedAt ?? "");
        const heard = ((await read(job.sender))?.turnItems ?? []).some(
          (item) =>
            item.type === "dynamic_tool" &&
            HEARS.test(item.toolName ?? "") &&
            item.input?.threadId === job.threadId &&
            (!item.completedAt || Date.parse(item.completedAt) >= endedAt),
        );
        if (heard) return void handed.delete(runId);
        const said = (theirs?.messages ?? [])
          .filter((message) => message.role === "assistant" && message.runId === runId)
          .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
          .pop();
        const taken = tellUnheard({
          sessionId,
          fromSessionId,
          providerTurnId: t3AppId(runId),
          text: said?.text ?? "",
          finished: run.status === "completed",
        });
        if (taken) handed.delete(runId);
      })()
        .catch(() => undefined)
        .finally(() => settling.delete(runId));
    }
  };

  /** Never awaited by the list's own stream: reading a conversation must not hold the list back. */
  const look = (threadId: string, again = false) => {
    const sessionId = chats.get(threadId);
    const now = state.get(threadId);
    const runId = now?.active ?? now?.latest;
    if (!sessionId || !runId || busy.has(sessionId) || own.has(runId) || told.has(runId)) return;
    const stands = `${now?.active ?? ""}|${now?.latest ?? ""}`;
    if (!again && refused.get(runId) === stands) return;
    told.add(runId);
    const going = now?.active === runId;
    let first: Message | undefined;
    let known = false;
    void rpc
      .stream("orchestration.subscribeThread", { threadId }, (value) => {
        const frame = value as ThreadFrame;
        if (frame.kind !== "snapshot" || !frame.projection) return true;
        known = (frame.projection.runs ?? []).some((run) => run.id === runId);
        first = (frame.projection.messages ?? []).find((message) => message.role === "user" && message.runId === runId);
        return false;
      })
      .then(() => {
        // The chat's own turn took the run meanwhile, or the conversation no longer has it.
        if (!known || own.has(runId) || chats.get(threadId) !== sessionId) return;
        const sender = first?.senderThreadId;
        const scheduled = !!first?.scheduledTaskId;
        if (!going && first && !sender && !scheduled) return;
        const fromSessionId = sender ? chats.get(sender) : undefined;
        // A job a chat here handed over: its answer is watched until that chat has heard it.
        if (sender && fromSessionId) {
          handed.set(runId, { threadId, sender });
          settle(threadId);
        }
        const taken = tell({
          sessionId,
          providerTurnId: t3AppId(runId),
          text: first?.text ?? "",
          ...(fromSessionId ? { fromSessionId } : {}),
          ...(scheduled ? { scheduled: true } : {}),
        });
        if (taken) return void refused.delete(runId);
        told.delete(runId);
        refused.set(runId, stands);
      })
      .catch(() => void told.delete(runId));
  };

  return {
    know(sessionId, providerThreadId) {
      const threadId = t3EngineId(providerThreadId);
      const before = threadOf.get(sessionId);
      if (before && before !== threadId) chats.delete(before);
      chats.set(threadId, sessionId);
      threadOf.set(sessionId, threadId);
      listen();
      look(threadId);
    },
    forget(sessionId) {
      const threadId = threadOf.get(sessionId);
      if (threadId) chats.delete(threadId);
      threadOf.delete(sessionId);
      busy.delete(sessionId);
    },
    began: (sessionId) => void busy.add(sessionId),
    ended(sessionId) {
      busy.delete(sessionId);
      const threadId = threadOf.get(sessionId);
      if (threadId) look(threadId, true);
    },
    own: (runId) => void own.add(runId),
    chatOf: (threadId) => chats.get(threadId),
  };
}
