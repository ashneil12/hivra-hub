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
type Message = { role?: string; runId?: string | null; text?: string; senderThreadId?: string; scheduledTaskId?: string };
type ThreadFrame = { kind: string; projection?: { messages?: Message[]; runs?: Array<{ id: string }> } };

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
export function createT3Watch(rpc: T3Rpc, tell: Listener = tellApp): T3Watch {
  const chats = new Map<string, string>();
  const threadOf = new Map<string, string>();
  const own = new Set<string>();
  const told = new Set<string>();
  const busy = new Set<string>();
  /** Runs the app could not take, by where their conversation stood then: offered again once that changes. */
  const refused = new Map<string, string>();
  /** The engine's last word per conversation: the run going now, and the newest one. */
  const state = new Map<string, { active?: string; latest?: string }>();
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
        }
        return true;
      })
      .catch(() => undefined)
      // The connection dropped or the engine went away: the next chat that is known starts the watch again.
      .finally(() => (listening = false));
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
