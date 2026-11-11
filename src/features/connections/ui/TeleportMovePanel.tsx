// The move panel for a chat (WP-177). Moving out starts from this Mac's chat; moving back starts from the copy the host
// holds. Start shows the plan (the saved messages, the title, the queued messages, how many values were redacted). Only a
// click the person makes on "Approve and move" moves anything. A refusal says why, and offers the recap as a new chat when
// the other machine cannot resume. A result the desktop cannot confirm stays locked here, with a retry that checks again.

import { useEffect, useRef, useState } from "react";
import type { Session } from "../../sessions/model/session";
import { approveAndMove, listPairedHosts, planFromSession } from "../model/teleportMove";
import { startRecapChat } from "../model/teleportRecap";
import { completeMove, planMove, type MoveEndpoint, type MovePlan, type MoveRefusal, type MoveResult } from "../model/teleport";
import { TeleportNotice } from "./TeleportNotice";
import { moveResultMessage } from "./teleportCopy";
import { localMoveEndpoint } from "../model/teleportLocal";
import { sshMoveEndpoint } from "../model/teleportSsh";
import { remoteRequest } from "../model/connections";
import { sessionStoreChatPort } from "../data/teleportStorePort";
import { movedPeer, teleportStateOf } from "../model/teleportState";
import { getSession, upsertSession } from "../../sessions/data/sessionStore";

export interface PairedHost {
  /** The machine id the desktop uses to reach the host. */
  id: string;
  name: string;
  /** The host's environment id: the identity a move is addressed to. */
  environmentId?: string;
}

export interface TeleportMovePanelProps {
  session: Session;
  hosts: PairedHost[];
  /** "out" moves this Mac's chat to a host; "back" moves the host's copy back to this Mac. */
  direction?: "out" | "back";
  /** The two ends of a move for one host: this Mac's chat store and the host. */
  endpointsFor: (hostId: string) => { local: MoveEndpoint; remote: MoveEndpoint };
  /** Saves a new chat (the recap) and opens it. */
  saveAndOpen: (next: Session) => Promise<void>;
  /** Receives the stored row after a move, so the app's session list holds the moved state. */
  onRow?: (row: Session) => void;
  /** Reads the stored row again after a move. Defaults to the saved store. */
  loadRow?: (chatId: string) => Promise<Session | null>;
}

type Phase =
  | { kind: "idle" }
  | { kind: "plan"; hostId: string; plan: MovePlan; from: MoveEndpoint; to: MoveEndpoint }
  | { kind: "refused"; refusal: MoveRefusal; hostId: string }
  | { kind: "done"; hostId: string; result: MoveResult }
  | { kind: "unknown"; hostId: string; moveId: string; from: MoveEndpoint; to: MoveEndpoint; message: string }
  | { kind: "failed"; message: string };

export function TeleportMovePanel(props: TeleportMovePanelProps) {
  const { session, hosts, endpointsFor, saveAndOpen, onRow, loadRow = getSession, direction = "out" } = props;
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [hostId, setHostId] = useState<string>(hosts[0]?.id ?? "");
  const hostName = hosts.find((h) => h.id === hostId)?.name ?? hostId;
  const back = direction === "back";
  // A ref, not state: a second click in the same tick must not start a second move.
  const approvingRef = useRef(false);
  const [approving, setApproving] = useState(false);

  const refreshRow = async () => {
    // The stored row is the truth after any result, so the app's copy takes it even when the move did not finish.
    const row = await loadRow(session.id).catch(() => null);
    if (row) onRow?.(row);
  };

  const start = async () => {
    try {
      const { local, remote } = endpointsFor(hostId);
      if (back) {
        // The copy lives on the host: its plan is the host's own record, and a move back goes host to this Mac.
        const record = await remote.read(session.id);
        if (!record?.live) {
          setPhase({ kind: "failed", message: `${hostName} does not hold this chat, so there is nothing to move back.` });
          return;
        }
        const planned = await planMove(record.live, remote.id, local.id);
        setPhase(planned.ok ? { kind: "plan", hostId, plan: planned.plan, from: remote, to: local } : { kind: "refused", refusal: planned.refusal, hostId });
        return;
      }
      // The plan names the endpoints' identities, the same ones the approved move will check.
      const planned = await planFromSession(session, local.id, remote.id);
      setPhase(planned.ok ? { kind: "plan", hostId, plan: planned.plan, from: local, to: remote } : { kind: "refused", refusal: planned.refusal, hostId });
    } catch (error) {
      setPhase({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const approve = async (event: React.MouseEvent) => {
    if (phase.kind !== "plan" || approvingRef.current) return;
    approvingRef.current = true;
    setApproving(true);
    const moveId = `move-${Date.now()}`;
    try {
      const { result } = await approveAndMove({
        session,
        plan: phase.plan,
        gesture: event.nativeEvent,
        from: phase.from,
        to: phase.to,
        moveId,
        at: new Date().toISOString(),
      });
      await refreshRow();
      if (result.status === "moved") setPhase({ kind: "done", hostId: phase.hostId, result });
      else if (result.status === "refused") setPhase({ kind: "refused", refusal: result.refusal, hostId: phase.hostId });
      else if (result.status === "unknown") {
        setPhase({ kind: "unknown", hostId: phase.hostId, moveId, from: phase.from, to: phase.to, message: moveResultMessage(result) });
      } else setPhase({ kind: "failed", message: moveResultMessage(result) });
    } catch (error) {
      setPhase({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      approvingRef.current = false;
      setApproving(false);
    }
  };

  // The retry checks the move again with the same endpoints and move id: it finishes the move, or it says it cannot yet.
  const retry = async () => {
    if (phase.kind !== "unknown" || approvingRef.current) return;
    approvingRef.current = true;
    setApproving(true);
    try {
      const result = await completeMove({ chatId: session.id, from: phase.from, to: phase.to, moveId: phase.moveId });
      await refreshRow();
      if (result.status === "moved") setPhase({ kind: "done", hostId: phase.hostId, result });
      else if (result.status === "unknown") setPhase({ ...phase, message: moveResultMessage(result) });
      else setPhase({ kind: "failed", message: moveResultMessage(result) });
    } catch (error) {
      setPhase({ ...phase, message: error instanceof Error ? error.message : String(error) });
    } finally {
      approvingRef.current = false;
      setApproving(false);
    }
  };

  if (hosts.length === 0) {
    return back ? (
      <p role="status" data-testid="teleport-back-no-host" style={{ margin: "8px 12px", fontSize: 13 }}>
        The host this chat went to is not added on this Mac, so it cannot be moved back from here.
      </p>
    ) : null;
  }

  const verb = back ? "Moves back to this Mac" : `Moves to ${hostName}`;

  return (
    <section aria-label={back ? "Move this chat back" : "Move this chat"} data-testid="teleport-panel" style={{ margin: "8px 12px", fontSize: 13 }}>
      {phase.kind === "idle" && (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {!back && hosts.length > 1 && (
            <select aria-label="Machine" value={hostId} onChange={(e) => setHostId(e.target.value)}>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          )}
          <button type="button" data-testid={back ? "teleport-back-start" : "teleport-start"} onClick={start}>
            {back ? "Move back to this Mac" : `Move to ${hostName}`}
          </button>
        </div>
      )}

      {phase.kind === "plan" && (
        <div data-testid="teleport-plan" role="region" aria-label="Move plan">
          <p style={{ margin: "0 0 4px" }}>
            {verb}: the saved messages and the title{phase.plan.queued.length ? `, with ${phase.plan.queued.length} queued message(s)` : ""}.{" "}
            {back
              ? "It continues in a fresh session here, started from the saved messages. The host keeps no live copy after this."
              : "It continues in a fresh session there, started from the saved messages. This Mac keeps only a marker."}
          </p>
          {phase.plan.queued.length > 0 && (
            <ul data-testid="teleport-plan-queued" style={{ margin: "0 0 4px", paddingLeft: 18 }}>
              {phase.plan.queued.map((text, i) => (
                <li key={i}>{text}</li>
              ))}
            </ul>
          )}
          <p style={{ margin: "0 0 6px" }} data-testid="teleport-plan-redactions">
            Values redacted before the move: {phase.plan.redactions}
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" data-testid="teleport-approve" onClick={approve} disabled={approving}>
              Approve and move
            </button>
            <button type="button" onClick={() => setPhase({ kind: "idle" })} disabled={approving}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase.kind === "refused" && (
        <TeleportNotice
          kind="refused"
          refusal={phase.refusal}
          onRecap={async () => {
            const next = await startRecapChat(session, {
              save: saveAndOpen,
              open: () => undefined,
            });
            setPhase({ kind: "idle" });
            void next;
          }}
        />
      )}

      {phase.kind === "done" && (
        <p role="status" data-testid="teleport-done">
          {back ? `Moved back to this Mac, ${new Date().toLocaleString()}.` : `Moved to ${hostName}, ${new Date().toLocaleString()}. The chat stays on ${hostName} now.`}
        </p>
      )}

      {phase.kind === "unknown" && (
        <div role="alert" data-testid="teleport-unknown">
          <p style={{ margin: "0 0 6px" }}>{phase.message}</p>
          <p style={{ margin: "0 0 6px" }}>This chat stays locked here until the move is checked.</p>
          <button type="button" data-testid="teleport-retry" onClick={retry} disabled={approving}>
            Retry to check
          </button>
        </div>
      )}

      {phase.kind === "failed" && (
        <p role="alert" data-testid="teleport-failed">
          {phase.message}
        </p>
      )}
    </section>
  );
}

/**
 * The panel as the app mounts it: the paired hosts from the machine list, this Mac's saved chat store (busy from the app's
 * live state, read at each move step), and the SSH host reached through the same remote request every other host call
 * uses. A moved chat shows the move back to this Mac, from the host it went to.
 */
export function AppTeleportPanel(props: { session: Session; onRow?: (row: Session) => void; onOpen?: (session: Session) => void }) {
  const { session, onRow, onOpen } = props;
  const [hosts, setHosts] = useState<PairedHost[]>([]);
  // The live busy state at the moment of each step, not the snapshot the render had (LOW).
  const busyRef = useRef(false);
  busyRef.current = session.busy === true;
  useEffect(() => {
    let alive = true;
    listPairedHosts()
      .then((list) => alive && setHosts(list))
      .catch(() => alive && setHosts([]));
    return () => {
      alive = false;
    };
  }, []);
  if (session.blocks.length === 0) return null;
  const endpointsFor = (hostId: string) => {
    const host = hosts.find((h) => h.id === hostId);
    return {
      local: localMoveEndpoint({
        machineId: "this-mac",
        port: sessionStoreChatPort({ isBusy: () => busyRef.current }),
        labelFor: () => host?.name ?? hostId,
      }),
      remote: sshMoveEndpoint(hostId, (method, params) => remoteRequest(hostId, method, params), host?.environmentId ?? hostId),
    };
  };
  const saveAndOpen = async (next: Session) => {
    await upsertSession(next);
    onOpen?.(next);
  };
  const state = teleportStateOf(session);
  if (state.moved) {
    // The copy went to the host the chat's moved marker names; that host is the one a move back starts from.
    const peer = movedPeer(session);
    const host = hosts.find((h) => h.environmentId === peer) ?? hosts.find((h) => h.id === peer);
    return (
      <TeleportMovePanel
        key="back"
        session={session}
        hosts={host ? [host] : []}
        direction="back"
        endpointsFor={endpointsFor}
        saveAndOpen={saveAndOpen}
        onRow={onRow}
      />
    );
  }
  return <TeleportMovePanel session={session} hosts={hosts} endpointsFor={endpointsFor} saveAndOpen={saveAndOpen} onRow={onRow} />;
}
