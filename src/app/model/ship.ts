// Ship, as this window sees it (src-tauri/src/ship.rs, Phase 1b WP3): an update staged and waiting for a quiet moment,
// this build's trial (auto-resume, habits and automations wait until it commits), and the newest ship's receipt on
// the main pane. Outside the app (vitest, a browser preview with nothing seeded) there is no ship and nothing is held.

import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ShipNote } from "../../features/sessions/model/inFlight";

export type ShipBuild = { sha?: string; branch?: string; builtAt?: string };

/** Ash's own answer to "does the build work?" (I4): pending until he says yes or no, and only he can say it. */
export type ShipAcceptance = { state: "pending" | "yes" | "no"; note?: string };

export type ShipSummary = ShipNote & {
  kind?: string;
  whenBusy?: string;
  drill?: string | null;
  createdAt?: string;
  updatedAt?: string;
  /** The build's signature was accepted for install; this is not Ash's answer (that is `acceptance`). */
  accepted: boolean;
  acceptance: ShipAcceptance;
  refused?: string | null;
  deferred?: { inFlight?: number; at?: string } | null;
  committed: boolean;
  receipt?: Record<string, unknown> | null;
  seen: boolean;
  shipDir?: string;
};

export type ShipStatus = {
  enabled: boolean;
  /** This build is on trial and hasn't committed. */
  holding: boolean;
  trial: { id: string; committed: boolean } | null;
  /** A staged update this app accepted and will quit for. */
  pending: { id: string; force: boolean } | null;
  current: ShipSummary | null;
};

export const NO_SHIP: ShipStatus = {
  enabled: false,
  holding: false,
  trial: null,
  pending: null,
  current: null,
};

export const SHIP_CHANGED = "ship:changed";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const build = (value: unknown): ShipBuild | null =>
  isRecord(value) ? { sha: text(value.sha), branch: text(value.branch), builtAt: text(value.builtAt) } : null;
/** No file, or a file this build doesn't understand, is pending: a ship is never accepted by default. */
const acceptance = (value: unknown): ShipAcceptance =>
  isRecord(value) && (value.state === "yes" || value.state === "no")
    ? { state: value.state, note: text(value.note) }
    : { state: "pending" };

/** One ship's summary, read loosely: another build may write more or fewer fields. */
export function readShipSummary(value: unknown): ShipSummary | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.phase !== "string") return null;
  const requested = isRecord(value.requestedBy) ? value.requestedBy : null;
  return {
    id: value.id,
    phase: value.phase,
    reason: text(value.reason) ?? null,
    from: build(value.from),
    to: build(value.to),
    requestedBy: requested ? { sessionId: text(requested.sessionId) ?? null } : null,
    receiptPath: text(value.receiptPath),
    log: text(value.log),
    kind: text(value.kind),
    whenBusy: text(value.whenBusy),
    drill: text(value.drill) ?? null,
    createdAt: text(value.createdAt),
    updatedAt: text(value.updatedAt),
    accepted: value.accepted === true,
    acceptance: acceptance(value.acceptance),
    refused: text(value.refused) ?? null,
    deferred: isRecord(value.deferred)
      ? { inFlight: typeof value.deferred.inFlight === "number" ? value.deferred.inFlight : undefined, at: text(value.deferred.at) }
      : null,
    committed: value.committed === true,
    receipt: isRecord(value.receipt) ? value.receipt : null,
    seen: value.seen === true,
    shipDir: text(value.shipDir),
  };
}

export function readShipStatus(value: unknown): ShipStatus {
  if (!isRecord(value)) return NO_SHIP;
  const trial = isRecord(value.trial) && typeof value.trial.id === "string"
    ? { id: value.trial.id, committed: value.trial.committed === true }
    : null;
  const pending = isRecord(value.pending) && typeof value.pending.id === "string"
    ? { id: value.pending.id, force: value.pending.force === true }
    : null;
  return {
    enabled: value.enabled === true,
    holding: value.holding === true,
    trial,
    pending,
    current: readShipSummary(value.current),
  };
}

/**
 * What the app handed this window before its scripts ran (`window.__MONOCODE_APP__.ship`): a build on trial holds from
 * its first render, before `ship_status` answers.
 */
function initialStatus(): ShipStatus {
  const app = (globalThis as Record<string, unknown>).__MONOCODE_APP__;
  const ship = isRecord(app) && isRecord(app.ship) ? app.ship : null;
  if (!ship) return NO_SHIP;
  return { ...readShipStatus({ ...ship, enabled: true }), current: null };
}

let latest: ShipStatus = initialStatus();
let started = false;
const listeners = new Set<(status: ShipStatus) => void>();

function publish(status: ShipStatus) {
  latest = status;
  for (const listener of listeners) listener(status);
}

/**
 * The real app, or the browser preview when a spec seeded `monocode:dev-ship`. The preview mocks IPC but leaves
 * `window.isTauri` unset, so it is not the app: asking on every preview page would treat it as one. No seed, no ask.
 */
function canReadShip(): boolean {
  if (isTauri()) return true;
  try {
    const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
    return typeof internals?.invoke === "function" && localStorage.getItem("monocode:dev-ship") != null;
  } catch {
    return false;
  }
}

function start() {
  if (started || !canReadShip()) return;
  started = true;
  void invoke("ship_status")
    .then((raw) => publish(readShipStatus(raw)))
    .catch(() => undefined);
  void listen(SHIP_CHANGED, (event) => publish(readShipStatus(event.payload))).catch(() => undefined);
}

export function shipStatus(): ShipStatus {
  return latest;
}

export function useShipStatus(): ShipStatus {
  const [status, setStatus] = useState(latest);
  useEffect(() => {
    start();
    listeners.add(setStatus);
    setStatus(latest);
    return () => {
      listeners.delete(setStatus);
    };
  }, []);
  return status;
}

/** The window has drawn the workspace: a build on trial checks its database and hub bridge, then commits. */
export async function reportShipReady(): Promise<void> {
  if (!isTauri()) return;
  start();
  const raw = await invoke("ship_ready").catch(() => null);
  if (raw) publish(readShipStatus(raw));
}

/** "Restart now": quit for the waiting update even though chats are running; they resume afterwards. */
export function restartForUpdate(): Promise<void> {
  return invoke<void>("ship_restart_now");
}

export function markShipSeen(id: string): Promise<void> {
  return invoke<void>("ship_seen", { id });
}

/** Ash's answer to "does the update work?" (src-tauri/src/ship.rs): kept with the ship, in the app's records too. */
export function acceptShip(id: string, verdict: "yes" | "no", note?: string): Promise<void> {
  return invoke<void>("ship_accept", { id, verdict, note: note ?? null });
}

/** One ship's summary, for the resume note of a turn its restart cut. */
export async function loadShipNote(id: string): Promise<ShipNote | null> {
  if (!isTauri()) return null;
  return readShipSummary(await invoke("ship_receipt", { id }).catch(() => null));
}

/** `app.ship`: check, stage and schedule the build in `repo` on behalf of `requestedBy`. */
export function startShip(input: {
  repo: string;
  requestedBy: string;
  whenBusy?: "wait" | "restart";
}): Promise<unknown> {
  return invoke("ship_start", {
    repo: input.repo,
    requestedBy: input.requestedBy,
    whenBusy: input.whenBusy ?? null,
  });
}

export type ShipCardView = {
  id: string;
  text: string;
  detail?: string;
  restartNow?: boolean;
  log?: string;
  dismiss?: boolean;
  /** Asks Ash whether the build works: Yes, it works / Something's wrong. It stays until he answers. */
  accept?: boolean;
  /** Shown once: the bar marks it read as soon as it is on screen, and it is gone next time (a committed update). */
  once?: boolean;
};

/** What the bar says about Ship, if anything: the trial, a waiting update, Ash's own answer, or a receipt not yet read. */
export function shipCardView(status: ShipStatus, appVersion?: string): ShipCardView | null {
  if (!status.enabled) return null;
  const current = status.current;
  if (status.holding && status.trial)
    return {
      id: status.trial.id,
      text: "Checking the new build.",
      detail: "Habits, automations and cut chats wait until its window, database and app bridge are up.",
    };
  if (!current) return null;
  if (status.pending?.id === current.id && (current.phase === "staged" || current.phase === "waiting")) {
    const running = current.deferred?.inFlight;
    return {
      id: current.id,
      text: "An update to MonoCode Hub is ready.",
      detail: `MonoCode Hub restarts for it once nothing else is running${running ? ` (${running} running now)` : ""}. Running chats pick up again afterwards.`,
      restartNow: true,
    };
  }
  // Ash's own answer (I4): the update asks whether the build works, and it stays until he says. It shows even if the
  // receipt was already read: nothing calls a ship accepted until he answers yes, and "pending" is the default.
  const answer = current.acceptance;
  // r63 (Critiquito): no commit, branch or ship id in the ask, just the version Ash is now on.
  if (current.phase === "committed" && answer.state === "pending") {
    const version = appVersion && appVersion !== "0.0.0" ? appVersion.trim() : "";
    return {
      id: current.id,
      text: version ? `Hivra updated to ${version}. Is everything working?` : "Hivra was updated. Is everything working?",
      accept: true,
    };
  }
  if (current.seen) return null;
  // Plain words, no branch or commit (Critiquito/Ash, 22 Oct): which build it is lives in the log.
  const reason = current.reason ? ` ${current.reason}` : "";
  switch (current.phase) {
    case "committed":
      if (answer.state === "no")
        return {
          id: current.id,
          text: `Noted: something's wrong with this build.${answer.note ? ` ${answer.note}` : ""}`,
          detail: `The answer is kept with ship ${current.id}.`,
          log: current.log,
          dismiss: true,
        };
      return {
        id: current.id,
        text: "MonoCode Hub was updated.",
        log: current.log,
        once: true,
      };
    case "rolled-back":
      return {
        id: current.id,
        text: `An update was rolled back.${reason}`,
        detail: "Back on the build before it, with the database as it was.",
        log: current.log,
        dismiss: true,
      };
    case "cancelled":
      return {
        id: current.id,
        text: `An update was called off.${reason}`,
        detail: "Nothing changed.",
        log: current.log,
        dismiss: true,
      };
    case "failed":
      return {
        id: current.id,
        text: `An update failed.${reason}`,
        detail: current.shipDir ? `Everything it kept is in ${current.shipDir}.` : undefined,
        log: current.log,
        dismiss: true,
      };
    default:
      return null;
  }
}
