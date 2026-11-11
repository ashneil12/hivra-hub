// Hivra WP-10: the after-turn check that a first mate didn't edit the project (src-tauri/src/firstmate/checkout_guard.rs
// does the git work). A snapshot when a first-mate turn starts, a check when it ends; a change no landing explains is a
// flag, kept here for the first mate UI (WP-15) to show with its revert offer. Nothing is reverted without the person's
// tap (`revert`).
import { invoke } from "@tauri-apps/api/core";
import { isMonoSession } from "../../monos/model/mono";
import type { Session } from "../../sessions/model/session";
import { checkTurnForProtectedPaths, type ProtectedTouchReport } from "../../../integrations/harness/core/protectedPaths";

export type CheckoutSnapshot = {
  dir: string;
  head: string | null;
  dirty: Record<string, string>;
  takenAt: number;
};

/** `fingerprint`: the path as the turn left it; a revert skips a path that has changed since. */
export type ChangedPath = { path: string; revertable: boolean; whyNot: string | null; fingerprint?: string | null };

export type CheckoutFlag = {
  dir: string;
  changed: ChangedPath[];
  headMoved: [string | null, string | null] | null;
  summary: string;
};

export type RevertOutcome = { reverted: string[]; skipped: ChangedPath[] };

export type CheckoutGuardBackend = {
  snapshot(cwd: string): Promise<CheckoutSnapshot>;
  check(before: CheckoutSnapshot): Promise<CheckoutFlag | null>;
  revert(before: CheckoutSnapshot, flag: CheckoutFlag, paths: string[]): Promise<RevertOutcome>;
  /** WP-178 3.3/3.4: fingerprints of .git/hooks, .git/config and the secret places (report only). Optional. */
  protectedSnapshot?(cwd: string): Promise<Record<string, string>>;
};

export const tauriCheckoutGuard: CheckoutGuardBackend = {
  snapshot: (cwd) => invoke("firstmate_checkout_snapshot", { cwd }),
  check: (before) => invoke("firstmate_checkout_check", { before }),
  revert: (before, flag, paths) => invoke("firstmate_checkout_revert", { before, flag, paths }),
  protectedSnapshot: (cwd) => invoke("firstmate_protected_fingerprints", { cwd }),
};

/** A flagged first-mate turn: which chat, what changed, and the snapshot a revert needs. */
export type FlaggedTurn = {
  sessionId: string;
  flag: CheckoutFlag;
  before: CheckoutSnapshot;
  at: number;
};

/** Whether a chat is a first mate (WP-20 and WP-21 set it on the coding team's and the Monos' chats). */
export function isFirstMate(session: Pick<Session, "firstMate" | "id">): boolean {
  // WP-21: a Mono's chat is a first mate even when the flag was not stored with the session.
  return session.firstMate === true || (!!session.id && isMonoSession(session.id));
}

/** The launch input a first mate's turn adds (integrations/harness/core/types.ts `firstMate`). */
export function firstMateLaunch(session: Pick<Session, "firstMate" | "id">): { firstMate?: true } {
  return isFirstMate(session) ? { firstMate: true } : {};
}

function keepTurnFingerprints(fresh: CheckoutFlag, turn: CheckoutFlag): CheckoutFlag {
  return {
    ...fresh,
    changed: fresh.changed.map((path) => {
      const was = turn.changed.find((c) => c.path === path.path);
      return was ? { ...path, fingerprint: was.fingerprint ?? null } : path;
    }),
  };
}

export class FirstMateTurnGuard {
  private readonly open = new Map<string, Promise<CheckoutSnapshot | undefined>>();
  private readonly openProtected = new Map<
    string,
    { dir: string; before: Promise<Record<string, string> | undefined> }
  >();
  private flags: FlaggedTurn[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly backend: CheckoutGuardBackend,
    private readonly now: () => number = Date.now,
  ) {}

  /** A first-mate turn started in `cwd`: remember the checkout as it is. A folder git can't read is skipped. */
  begin(sessionId: string, cwd: string): void {
    if (this.open.has(sessionId)) return;
    this.open.set(
      sessionId,
      this.backend.snapshot(cwd).catch(() => undefined),
    );
    if (this.backend.protectedSnapshot) {
      const protectedSnapshot = this.backend.protectedSnapshot.bind(this.backend);
      this.openProtected.set(sessionId, {
        dir: cwd,
        before: protectedSnapshot(cwd).catch(() => undefined),
      });
    }
  }

  /**
   * The after-turn protected-file report for a turn: what under .git/hooks, .git/config or the secret places changed.
   * Report only: nothing is blocked or reverted. Undefined when nothing changed or the turn was never seen starting.
   */
  async endProtected(sessionId: string): Promise<ProtectedTouchReport | undefined> {
    const pending = this.openProtected.get(sessionId);
    this.openProtected.delete(sessionId);
    if (!pending || !this.backend.protectedSnapshot) return undefined;
    const before = await pending.before;
    if (!before) return undefined;
    const after = await this.backend.protectedSnapshot(pending.dir).catch(() => undefined);
    if (!after) return undefined;
    const report = checkTurnForProtectedPaths(before, after);
    return report.touched.length > 0 ? report : undefined;
  }

  /** The turn ended: the flag, if the checkout changed in a way no landing explains. */
  async end(sessionId: string): Promise<FlaggedTurn | undefined> {
    const pending = this.open.get(sessionId);
    this.open.delete(sessionId);
    const before = pending ? await pending : undefined;
    if (!before) return undefined;
    const flag = await this.backend.check(before).catch(() => null);
    if (!flag) return undefined;
    const turn = { sessionId, flag, before, at: this.now() };
    this.flags = [turn, ...this.flags.filter((t) => t.sessionId !== sessionId)].slice(0, 50);
    this.listeners.forEach((listener) => listener());
    return turn;
  }

  /** The flagged turns, newest first (one per chat: its latest). */
  flagged(): readonly FlaggedTurn[] {
    return this.flags;
  }

  /** On the person's tap: put back the paths they chose, then drop the flag if nothing is left. */
  async revert(sessionId: string, paths: string[]): Promise<RevertOutcome | undefined> {
    const turn = this.flags.find((t) => t.sessionId === sessionId);
    if (!turn) return undefined;
    const outcome = await this.backend.revert(turn.before, turn.flag, paths);
    const fresh = await this.backend.check(turn.before).catch(() => turn.flag);
    // What is still flagged keeps the fingerprint the turn left, so a later revert still skips what changed after it.
    const left = fresh && keepTurnFingerprints(fresh, turn.flag);
    this.flags = left
      ? this.flags.map((t) => (t === turn ? { ...t, flag: left } : t))
      : this.flags.filter((t) => t !== turn);
    this.listeners.forEach((listener) => listener());
    return outcome;
  }

  dismiss(sessionId: string): void {
    this.flags = this.flags.filter((t) => t.sessionId !== sessionId);
    this.listeners.forEach((listener) => listener());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** The app's one guard. */
export const firstMateTurnGuard = new FirstMateTurnGuard(tauriCheckoutGuard);
