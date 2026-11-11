import { checkMoreAgentApproval, MORE_AGENT_COPY } from "../../../features/providers/model/moreAgents";
import { AcpClient, type AcpHandlers } from "../core/acp";
import { killChild, spawnMoreAgentChild, unwatchChild, watchChild } from "../core/child";
import { TURN_IDLE_TIMEOUT_MS } from "../core/jsonRpc";
import { routeHarnessSession, type SessionRouteAdapter } from "../core/registry";
import type { ApprovalDecision, HarnessEvent, SendTurnInput, SteerTurnInput } from "../core/types";
import {
  ACP_PROTOCOL_VERSION,
  GENERIC_CLIENT_CAPABILITIES,
  eventsFromUpdate,
  namesModels,
  permissionAsk,
  permissionOutcome,
  promptBlocks,
  readInitialize,
  sessionIdFrom,
} from "./acpProtocol";

/**
 * WP-134: one generic ACP version 1 session for a More agents entry. The subset is queue, approvals, previews and
 * stop: no steer, no modes, no models picked for it, no attachments. The agent does its own file and shell work and
 * asks with `session/request_permission`; every ask is shown as the standard card (no per-agent shortcut). A chat is
 * routed here by its session id (core/registry.ts), so it never needs a HarnessId.
 */

const INIT_TIMEOUT_MS = 20_000;
const SESSION_TIMEOUT_MS = 45_000;

type Approval = { resolve: (decision: ApprovalDecision | "cancelled") => void };

type Live = {
  acp: AcpClient;
  agentId: string;
  acpSessionId: string;
  cwd: string;
  cancelled: boolean;
  muted: boolean;
  previewed: Set<string>;
  approvals: Map<number, Approval>;
  onEvent: (event: HarnessEvent) => void;
};

type Resume = { acpSessionId: string; cwd: string };

const agentBySession = new Map<string, string>();
const liveBySession = new Map<string, Live>();
const resumeBySession = new Map<string, Resume>();
/** The one start in progress per chat. A second message that arrives meanwhile waits for it, never spawns its own. */
const starting = new Map<string, Promise<Live>>();
/** Chats stopped while their start was still running: the start ends its process as soon as it has one. */
const stopping = new Set<string>();

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Plain words for a start that failed, so the chat never shows a raw transport error for these cases. */
function startError(error: unknown): Error {
  const detail = errorText(error);
  if (/timed out/i.test(detail)) return new Error(`${MORE_AGENT_COPY.notAnswering} Try again.`);
  if (/exited|not running/i.test(detail)) return new Error(`${MORE_AGENT_COPY.notAnswering} It stopped as it started.`);
  return error instanceof Error ? error : new Error(detail);
}

async function stop(sessionId: string): Promise<void> {
  if (starting.has(sessionId)) stopping.add(sessionId);
  const live = liveBySession.get(sessionId);
  liveBySession.delete(sessionId);
  if (live) {
    live.muted = true;
    settleApprovals(live, "cancelled");
    live.acp.close();
  }
  unwatchChild(sessionId);
  await killChild(sessionId).catch(() => undefined);
}

function settleApprovals(live: Live, decision: ApprovalDecision | "cancelled"): void {
  for (const approval of live.approvals.values()) approval.resolve(decision);
  live.approvals.clear();
}

async function start(input: SendTurnInput, agentId: string): Promise<Live> {
  const pending = starting.get(input.sessionId);
  if (pending) {
    const live = await pending;
    live.onEvent = input.onEvent;
    return live;
  }
  const existing = liveBySession.get(input.sessionId);
  if (existing && existing.cwd === input.cwd && existing.agentId === agentId) {
    // A running agent answers the next turn only while the app still approves it as it is now.
    try {
      await checkMoreAgentApproval(agentId);
    } catch (error) {
      await stop(input.sessionId);
      throw error instanceof Error ? error : new Error(errorText(error));
    }
    existing.onEvent = input.onEvent;
    return existing;
  }
  if (existing) await stop(input.sessionId);
  const attempt = startLive(input, agentId);
  starting.set(input.sessionId, attempt);
  try {
    return await attempt;
  } finally {
    if (starting.get(input.sessionId) === attempt) starting.delete(input.sessionId);
    stopping.delete(input.sessionId);
  }
}

async function startLive(input: SendTurnInput, agentId: string): Promise<Live> {
  const handlers: AcpHandlers = {};
  const acp = new AcpClient(input.sessionId, handlers);
  const ref: { current: Live | null } = { current: null };
  const emit = (event: HarnessEvent) => (ref.current?.onEvent ?? input.onEvent)(event);
  let replaying = false;

  handlers.onNotification = (method, params) => {
    const live = ref.current;
    if (method !== "session/update" || replaying || !live || live.muted) return;
    for (const event of eventsFromUpdate(params, live.previewed)) live.onEvent(event);
  };
  handlers.onRequest = (id, method, params) => {
    const live = ref.current;
    if (method === "session/request_permission" && live) {
      void askPermission(live, id, params);
      return;
    }
    void acp.respondError(id, { code: -32601, message: `Method not found: ${method}` }).catch(() => undefined);
    // Today's ACP providers answer an unknown ask with -32601 and no line in the chat. A More agents chat says so.
    if (live && !live.muted) emit({ type: "notice", text: MORE_AGENT_COPY.unknownAsk, level: "warning" });
  };

  watchChild(
    input.sessionId,
    (line) => acp.pushLine(line),
    (code) => {
      acp.close(new Error("The agent exited"));
      if (liveBySession.get(input.sessionId) === ref.current) liveBySession.delete(input.sessionId);
      emit({ type: "session.ended", code });
    },
    (line) => console.debug("[monocode] more agent stderr", line),
  );

  try {
    await spawnMoreAgentChild(input.sessionId, agentId, input.cwd);
  } catch (error) {
    unwatchChild(input.sessionId);
    throw error;
  }
  if (stopping.has(input.sessionId)) {
    acp.close(new Error("Stopped"));
    unwatchChild(input.sessionId);
    await killChild(input.sessionId).catch(() => undefined);
    throw new Error("Stopped before it started.");
  }

  try {
    let init: unknown;
    try {
      init = await acp.request(
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: GENERIC_CLIENT_CAPABILITIES,
          clientInfo: { name: "hivra", version: "0.1.0" },
        },
        INIT_TIMEOUT_MS,
      );
    } catch (error) {
      throw startError(error);
    }
    const outcome = readInitialize(init);
    if (!outcome.ok) throw new Error(outcome.message);

    const resume = resumeBySession.get(input.sessionId);
    let acpSessionId: string | undefined;
    let setup: unknown;
    if (resume && resume.cwd === input.cwd) {
      // Continuing needs the agent's own `session/load`. When it cannot, the chat says so and a new message starts a
      // fresh agent session; Hivra does not quietly start one in its place.
      resumeBySession.delete(input.sessionId);
      if (!outcome.loadSession) throw new Error(MORE_AGENT_COPY.cannotContinue);
      replaying = true;
      try {
        await acp.request(
          "session/load",
          { sessionId: resume.acpSessionId, cwd: input.cwd, mcpServers: [] },
          SESSION_TIMEOUT_MS,
        );
        acpSessionId = resume.acpSessionId;
      } catch {
        throw new Error(MORE_AGENT_COPY.cannotContinue);
      } finally {
        replaying = false;
      }
    } else {
      resumeBySession.delete(input.sessionId);
      setup = await acp.request("session/new", { cwd: input.cwd, mcpServers: [] }, SESSION_TIMEOUT_MS);
      acpSessionId = sessionIdFrom(setup);
      if (!acpSessionId) throw new Error("This agent did not start a session.");
    }

    const live: Live = {
      acp,
      agentId,
      acpSessionId,
      cwd: input.cwd,
      cancelled: false,
      muted: false,
      previewed: new Set(),
      approvals: new Map(),
      onEvent: input.onEvent,
    };
    ref.current = live;
    liveBySession.set(input.sessionId, live);
    resumeBySession.set(input.sessionId, { acpSessionId, cwd: input.cwd });
    live.onEvent({ type: "session.providerBound", providerSessionId: acpSessionId });
    live.onEvent({ type: "session.started" });
    if (setup !== undefined && !namesModels(setup)) {
      live.onEvent({ type: "notice", text: MORE_AGENT_COPY.noModels, key: "more-agent-models" });
    }
    return live;
  } catch (error) {
    acp.close(error instanceof Error ? error : new Error(errorText(error)));
    unwatchChild(input.sessionId);
    await killChild(input.sessionId).catch(() => undefined);
    throw error;
  }
}

async function askPermission(live: Live, id: number, params: unknown): Promise<void> {
  const ask = permissionAsk(params);
  live.onEvent({
    type: "approval.requested",
    requestId: id,
    title: ask.title,
    ...(ask.kind ? { kind: ask.kind } : {}),
    ...(ask.callId ? { callId: ask.callId } : {}),
    ...(ask.preview ? { preview: ask.preview } : {}),
  });
  const decision = await new Promise<ApprovalDecision | "cancelled">((resolve) => {
    live.approvals.set(id, { resolve });
  });
  live.approvals.delete(id);
  live.onEvent({ type: "approval.resolved", requestId: id, decision: decision === "allow" ? "allow" : "deny" });
  const outcome = decision === "cancelled" ? { outcome: "cancelled" as const } : permissionOutcome(ask, decision);
  await live.acp.respond(id, { outcome }).catch(() => undefined);
}

async function sendTurn(input: SendTurnInput): Promise<void> {
  const agentId = agentBySession.get(input.sessionId);
  if (!agentId) throw new Error(MORE_AGENT_COPY.gone);
  const live = await start(input, agentId);
  live.cancelled = false;
  live.muted = false;
  live.onEvent = input.onEvent;
  const blocks = promptBlocks(input.text);
  if (blocks.length === 0) return;
  input.onAccepted?.();
  try {
    await live.acp.request(
      "session/prompt",
      { sessionId: live.acpSessionId, prompt: blocks },
      TURN_IDLE_TIMEOUT_MS,
      { idle: true },
    );
  } catch (error) {
    if (live.cancelled) return;
    throw error;
  }
  if (live.cancelled) return;
  live.onEvent({ type: "message.completed" });
  live.onEvent({ type: "reasoning.completed" });
}

/**
 * ACP does not promise a reply to `session/cancel`. Hivra sends it, marks the turn stopped here and says so; it never
 * says the agent confirmed. A pending ask is answered "cancelled", as the spec asks of a client.
 */
async function cancelTurn(sessionId: string): Promise<void> {
  const live = liveBySession.get(sessionId);
  if (!live) return;
  live.cancelled = true;
  settleApprovals(live, "cancelled");
  await live.acp.notify("session/cancel", { sessionId: live.acpSessionId }).catch(() => undefined);
  live.onEvent({ type: "notice", text: MORE_AGENT_COPY.stopSent, key: "more-agent-stop" });
  live.muted = true;
  live.acp.rejectPending(new Error("cancelled"));
}

export const moreAgentAdapter: SessionRouteAdapter = {
  id: "more-agents",
  live: true,
  canSteer: false,
  sendTurn,
  steerTurn: async (_input: SteerTurnInput) => {
    throw new Error(MORE_AGENT_COPY.waits);
  },
  cancelTurn,
  respondApproval: (sessionId, requestId, decision) => {
    liveBySession.get(sessionId)?.approvals.get(requestId)?.resolve(decision);
  },
  stopSession: stop,
  forgetSession: async (sessionId) => {
    resumeBySession.delete(sessionId);
    await stop(sessionId);
  },
  dropSession: (sessionId) => {
    resumeBySession.delete(sessionId);
    agentBySession.delete(sessionId);
    routeHarnessSession(sessionId, null);
  },
  bindSession: (threadId, providerSessionId, cwd) => {
    const id = providerSessionId.trim();
    if (!threadId || !id || !cwd.trim()) return;
    resumeBySession.set(threadId, { acpSessionId: id, cwd });
  },
};

/** Stops every live run of one entry, for when it is withdrawn, removed or edited in the list. */
export function stopMoreAgentRuns(agentId: string): void {
  for (const [sessionId, live] of [...liveBySession]) {
    if (live.agentId === agentId) void stop(sessionId);
  }
}

/** Run this chat on a More agents entry. Its turns, stops and answers go through the generic adapter from now on. */
export function openMoreAgentSession(sessionId: string, agentId: string): void {
  agentBySession.set(sessionId, agentId);
  routeHarnessSession(sessionId, moreAgentAdapter);
}

/** The entry this chat runs on, if any. */
export function moreAgentOfSession(sessionId: string): string | undefined {
  return agentBySession.get(sessionId);
}
