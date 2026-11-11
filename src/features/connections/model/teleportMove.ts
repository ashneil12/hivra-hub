// The app's move path (WP-177): plan from the app's own session, approve with a person's click, move, and save through the
// same store the sidebar uses. Startup recovery finishes or undoes any move that stopped part way, from what was saved, in
// both directions: a freeze this Mac holds, a copy this Mac stores, and a refused move whose source may still be frozen.

import type { Session } from "../../sessions/model/session";
import { approvePlan, moveChat, planMove, recoverMove, type MoveEndpoint, type MovePlan, type MoveResult } from "./teleport";
import { sessionToChat, type LocalChatPort } from "./teleportLocal";
import { savedAborted, savedFreezeAsks, savedFreezes, savedIncoming, savedReleaseOwed } from "./teleportState";
import { flushPendingSessionSave } from "../../sessions/model/sessionPersistFlush";

/**
 * A freeze or a copy this young may still be a move another window is running. Recovery leaves it for a later pass (M1).
 */
export const YOUNG_MOVE_MS = 2 * 60 * 1000;

export type RecoveryStatus = MoveResult["status"] | "failed" | "skipped";
export interface RecoveryLine {
  chatId: string;
  moveId: string;
  status: RecoveryStatus;
}

/**
 * The plan for a chat. The stored row is what the move hashes, so the plan is taken from that same read (after this
 * window's pending save is flushed). `busy` still comes from the window: the row does not know a turn is in flight.
 */
function leadOrCrew(session: Session): boolean {
  if (session.orchestrationLeadId) return true;
  return session.blocks.some((block) => !!block.orchestrationLeadId || !!block.orchestration);
}

export async function planFromSession(session: Session, from: string, to: string) {
  await flushPendingSessionSave(session.id);
  const { readSessionForMove } = await import("../../sessions/data/sessionStore");
  const stored = await readSessionForMove(session.id);
  const base = stored ? ({ ...stored, busy: session.busy === true } as Session) : session;
  // A Lead or a crew chat is not one conversation. Moving it would split the run across machines.
  if (leadOrCrew(base) || leadOrCrew(session)) {
    return {
      ok: false as const,
      refusal: {
        reason: "cannot-resume" as const,
        message: "A Lead chat or a crew chat cannot move. Start a new chat from a recap instead.",
        recapOffered: true,
      },
    };
  }
  return planMove(sessionToChat(base), from, to);
}

/** Approve with a person's click, then move. A gesture that is not a real trusted click moves nothing and throws. */
export async function approveAndMove(input: {
  session: Session;
  plan: MovePlan;
  gesture: unknown;
  from: MoveEndpoint;
  to: MoveEndpoint;
  moveId: string;
  at: string;
}): Promise<{ result: MoveResult }> {
  const approval = approvePlan(input.plan, input.gesture);
  const result = await moveChat({ chatId: input.session.id, from: input.from, to: input.to, approval, moveId: input.moveId, at: input.at });
  return { result };
}

/** A recovery line is worth another pass later: the move could not be finished or checked yet. */
export function needsAnotherPass(lines: RecoveryLine[]): boolean {
  return lines.some((line) => line.status === "failed" || line.status === "unknown" || line.status === "skipped");
}

/**
 * Startup recovery: every saved freeze, stored copy and refused move is finished or undone with the machine it was for.
 * Each chat is handled on its own, so one unreachable host leaves the other chats recovered (M4). Returns one line per move.
 */
export async function recoverSavedMoves(input: {
  chatIds: string[];
  port: LocalChatPort;
  local: MoveEndpoint;
  remoteFor: (peer: string) => MoveEndpoint;
  /** This window's owner: its own freezes are a move in progress, so they are left alone. */
  owner?: string;
  now?: number;
}): Promise<RecoveryLine[]> {
  const lines: RecoveryLine[] = [];
  const now = input.now ?? Date.now();
  const young = (at: number) => now - at < YOUNG_MOVE_MS;
  for (const chatId of input.chatIds) {
    const session = await input.port.get(chatId);
    if (!session) continue;
    for (const freeze of savedFreezes(session)) {
      // A young freeze may still be a move in progress, including one this window started. An older one is recovered
      // even when this window froze it: a result that was never shown otherwise stays frozen until restart.
      if (young(freeze.at)) {
        lines.push({ chatId, moveId: freeze.moveId, status: "skipped" });
        continue;
      }
      try {
        const result = await recoverMove({ chatId, moveId: freeze.moveId, from: input.local, to: input.remoteFor(freeze.peer) });
        lines.push({ chatId, moveId: freeze.moveId, status: result.status });
      } catch {
        lines.push({ chatId, moveId: freeze.moveId, status: "failed" });
      }
    }
    for (const copy of savedIncoming(session)) {
      if (young(copy.at)) {
        lines.push({ chatId, moveId: copy.moveId, status: "skipped" });
        continue;
      }
      try {
        const result = await recoverMove({ chatId, moveId: copy.moveId, from: input.remoteFor(copy.peer), to: input.local });
        lines.push({ chatId, moveId: copy.moveId, status: result.status });
      } catch {
        lines.push({ chatId, moveId: copy.moveId, status: "failed" });
      }
    }
    // A refused move whose source could not be thawed then: the thaw is retried on every pass (it is idempotent).
    // A move back whose release did not finish: the chat is here, and the other machine may still hold a copy.
    for (const owed of savedReleaseOwed(session)) {
      if (!owed.peer) continue;
      if (young(owed.at)) {
        lines.push({ chatId, moveId: owed.moveId, status: "skipped" });
        continue;
      }
      try {
        const result = await recoverMove({ chatId, moveId: owed.moveId, from: input.remoteFor(owed.peer), to: input.local });
        lines.push({ chatId, moveId: owed.moveId, status: result.status });
      } catch {
        lines.push({ chatId, moveId: owed.moveId, status: "failed" });
      }
    }
    // A freeze whose reply never came back. The other machine may still be frozen for this move id.
    const asks = savedFreezeAsks(session);
    for (const ask of asks) {
      if (young(ask.at) || !ask.peer) {
        lines.push({ chatId, moveId: ask.moveId, status: "skipped" });
        continue;
      }
      try {
        // The Mac answers for this move id first. The other machine is thawed only when that answer is "aborted".
        const result = await recoverMove({
          chatId,
          moveId: ask.moveId,
          from: input.remoteFor(ask.peer),
          to: input.local,
        });
        if (result.status === "recovered" || result.status === "moved") {
          await input.local.clearFreezeAsk?.(chatId, ask.moveId);
        }
        lines.push({ chatId, moveId: ask.moveId, status: result.status });
      } catch {
        lines.push({ chatId, moveId: ask.moveId, status: "failed" });
      }
    }
    for (const refused of savedAborted(session)) {
      if (!refused.peer) continue;
      try {
        const result = await recoverMove({ chatId, moveId: refused.moveId, from: input.remoteFor(refused.peer), to: input.local });
        lines.push({ chatId, moveId: refused.moveId, status: result.status });
      } catch {
        lines.push({ chatId, moveId: refused.moveId, status: "failed" });
      }
    }
  }
  return lines;
}

/** The paired hosts the app knows, as the start panel lists them. Empty when the machine list cannot be read. */
export async function listPairedHosts(): Promise<Array<{ id: string; name: string; environmentId: string }>> {
  const { invoke } = await import("@tauri-apps/api/core");
  const machines = await invoke<Array<{ id: string; name: string; environmentId: string }>>("remote_machines");
  return Array.isArray(machines) ? machines.map((m) => ({ id: m.id, name: m.name, environmentId: m.environmentId })) : [];
}

/**
 * Every chat in the saved store that still carries a move's freeze, copy or refusal, whether or not any tab shows it.
 * The store's listings give the ids; each row is then read, because a summary does not carry the move's notices.
 */
export async function findMovedChatIds(projectCwds: string[]): Promise<string[]> {
  const store = await import("../../sessions/data/sessionStore");
  const summaries = [
    ...(await store.listFolderlessSessions()),
    ...(await store.listLinkedSessions()),
    ...(await Promise.all([...new Set(projectCwds)].map((cwd) => store.listSessionsByProject(cwd)))).flat(),
  ];
  const ids = [...new Set(summaries.map((summary) => summary.id))];
  const found: string[] = [];
  for (const id of ids) {
    const row = await store.readSession(id);
    if (row?.blocks.some((b) => b.notice === "teleport-frozen" || b.notice === "teleport-incoming" || b.notice === "teleport-aborted" || b.notice === "teleport-release-owed" || b.notice === "teleport-freeze-asked")) {
      found.push(id);
    }
  }
  return found;
}

/**
 * Startup recovery as the app runs it at launch. The deps are the app's real ones by default: this Mac's saved store, and
 * the paired host reached through the same remote request every other host call uses. A peer is the host's environment id
 * (the identity a move is addressed to), so it is mapped back to the machine id the desktop calls. `onRow` gets each row a
 * recovery changed, so the app's list holds the stored state.
 */
export async function launchRecovery(
  projectCwds: string[],
  deps: {
    port?: LocalChatPort;
    local?: MoveEndpoint;
    remoteFor?: (peer: string) => MoveEndpoint;
    onRow?: (row: Session) => void;
    owner?: string;
    now?: number;
  } = {},
): Promise<RecoveryLine[]> {
  const { sessionStoreChatPort } = await import("../data/teleportStorePort");
  const { localMoveEndpoint } = await import("./teleportLocal");
  const { sshMoveEndpoint } = await import("./teleportSsh");
  const { remoteRequest } = await import("./connections");
  const { getSession } = await import("../../sessions/data/sessionStore");
  const port = deps.port ?? sessionStoreChatPort();
  const local = deps.local ?? localMoveEndpoint({ machineId: "this-mac", port });
  const hosts = deps.remoteFor ? [] : await listPairedHosts().catch(() => []);
  const remoteFor =
    deps.remoteFor ??
    ((peer: string) => {
      const host = hosts.find((h) => h.environmentId === peer) ?? hosts.find((h) => h.id === peer);
      const machineId = host?.id ?? peer;
      return sshMoveEndpoint(machineId, (method, params) => remoteRequest(machineId, method, params), host?.environmentId ?? peer);
    });
  const chatIds = await findMovedChatIds(projectCwds);
  const lines = await recoverSavedMoves({ chatIds, port, local, remoteFor, owner: deps.owner, now: deps.now });
  if (deps.onRow) {
    for (const line of new Set(lines.map((l) => l.chatId))) {
      const row = await getSession(line);
      if (row) deps.onRow(row);
    }
  }
  return lines;
}
