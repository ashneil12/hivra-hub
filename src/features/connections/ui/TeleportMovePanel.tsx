// The start-and-approve panel for a chat move (WP-177). Start shows the plan (the saved messages, the title, the queued
// messages, how many values were redacted). Only a click the person makes on "Approve and move" moves anything. A
// refusal says why, and offers the recap as a new chat when the other machine cannot resume.

import { useEffect, useState } from "react";
import type { Session } from "../../sessions/model/session";
import { approveAndMove, planFromSession } from "../model/teleportMove";
import { startRecapChat } from "../model/teleportRecap";
import type { MoveEndpoint, MovePlan, MoveRefusal, MoveResult } from "../model/teleport";
import { TeleportNotice } from "./TeleportNotice";
import { localMoveEndpoint } from "../model/teleportLocal";
import { sshMoveEndpoint } from "../model/teleportSsh";
import { remoteRequest } from "../model/connections";
import { sessionStoreChatPort } from "../data/teleportStorePort";
import { teleportStateOf } from "../model/teleportState";
import { getSession, upsertSession } from "../../sessions/data/sessionStore";
import { listPairedHosts } from "../model/teleportMove";

export interface PairedHost {
  id: string;
  name: string;
}

export interface TeleportMovePanelProps {
  session: Session;
  hosts: PairedHost[];
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
  | { kind: "plan"; hostId: string; plan: MovePlan }
  | { kind: "refused"; refusal: MoveRefusal; hostId: string }
  | { kind: "done"; hostId: string; result: MoveResult }
  | { kind: "failed"; message: string };

export function TeleportMovePanel(props: TeleportMovePanelProps) {
  const { session, hosts, endpointsFor, saveAndOpen, onRow, loadRow = getSession } = props;
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [hostId, setHostId] = useState<string>(hosts[0]?.id ?? "");
  const hostName = hosts.find((h) => h.id === hostId)?.name ?? hostId;

  const start = async () => {
    try {
      const planned = await planFromSession(session, "this-mac", hostId);
      setPhase(planned.ok ? { kind: "plan", hostId, plan: planned.plan } : { kind: "refused", refusal: planned.refusal, hostId });
    } catch (error) {
      setPhase({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const approve = async (event: React.MouseEvent) => {
    if (phase.kind !== "plan") return;
    const { local, remote } = endpointsFor(phase.hostId);
    try {
      const { result } = await approveAndMove({
        session,
        plan: phase.plan,
        gesture: event.nativeEvent,
        from: local,
        to: remote,
        moveId: `move-${Date.now()}`,
        at: new Date().toISOString(),
      });
      if (result.status === "moved") {
        // A failed reload does not undo the move: the move already happened and is saved step by step.
        const row = await loadRow(session.id).catch(() => null);
        if (row) onRow?.(row);
        setPhase({ kind: "done", hostId: phase.hostId, result });
      }
      else if (result.status === "refused") setPhase({ kind: "refused", refusal: result.refusal, hostId: phase.hostId });
      else setPhase({ kind: "failed", message: result.status === "failed" ? result.message : "The move did not finish. The chat stayed where it was." });
    } catch (error) {
      setPhase({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  };

  if (hosts.length === 0) return null;

  return (
    <section aria-label="Move this chat" data-testid="teleport-panel" style={{ margin: "8px 12px", fontSize: 13 }}>
      {phase.kind === "idle" && (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {hosts.length > 1 && (
            <select aria-label="Machine" value={hostId} onChange={(e) => setHostId(e.target.value)}>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          )}
          <button type="button" data-testid="teleport-start" onClick={start}>
            Move to {hostName}
          </button>
        </div>
      )}

      {phase.kind === "plan" && (
        <div data-testid="teleport-plan" role="region" aria-label="Move plan">
          <p style={{ margin: "0 0 4px" }}>
            Moves to {hostName}: the saved messages and the title{phase.plan.queued.length ? `, with ${phase.plan.queued.length} queued message(s)` : ""}. It continues in a
            fresh session there, started from the saved messages. This Mac keeps only a marker.
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
            <button type="button" data-testid="teleport-approve" onClick={approve}>
              Approve and move
            </button>
            <button type="button" onClick={() => setPhase({ kind: "idle" })}>
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

      {phase.kind === "done" && <p role="status" data-testid="teleport-done">Moved to {hostName}, {new Date().toLocaleString()}. The chat stays on {hostName} now.</p>}

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
 * live session), and the SSH host reached through the same remote request every other host call uses.
 */
export function AppTeleportPanel(props: { session: Session; onRow?: (row: Session) => void; onOpen?: (session: Session) => void }) {
  const { session, onRow, onOpen } = props;
  const [hosts, setHosts] = useState<PairedHost[]>([]);
  useEffect(() => {
    let alive = true;
    listPairedHosts()
      .then((list) => alive && setHosts(list))
      .catch(() => alive && setHosts([]));
    return () => {
      alive = false;
    };
  }, []);
  if (session.blocks.length === 0 || teleportStateOf(session).moved) return null;
  return (
    <TeleportMovePanel
      session={session}
      hosts={hosts}
      endpointsFor={(hostId) => {
        const hostName = hosts.find((h) => h.id === hostId)?.name ?? hostId;
        return {
          local: localMoveEndpoint({
            machineId: "this-mac",
            port: sessionStoreChatPort({ isBusy: () => session.busy === true }),
            labelFor: () => hostName,
          }),
          remote: sshMoveEndpoint(hostId, (method, params) => remoteRequest(hostId, method, params)),
        };
      }}
      onRow={onRow}
      saveAndOpen={async (next) => {
        await upsertSession(next);
        onOpen?.(next);
      }}
    />
  );
}
