// Native notifications for stuck workers (H4; Ash 20 Oct): a worker that failed or stalled is one banner, once per time
// it gets stuck, and a click opens its chat. A worker's question is its Lead's to answer first, so it raises no banner
// of its own (the Lead asks Ash in its own chat when only he can decide); only a question its Lead has left a few
// minutes is Ash's, and then it is one banner too. Likewise a Lead's worker that stalled or crashed is its Lead's: the
// app retries it, the hourly check hands it to its Lead, and its Lead tells Ash in its own chat if it can't unstick it
// or only Ash can help (Alfred's gate, 21 Oct: "your workers ask you, not Ash"). Its red line stays in Ash's view; it
// just isn't pushed. A refusal only Ash can fix (billing, sign-in, a usage limit) is still one banner. Nothing from
// before this run of the app is announced again.
import { hasJumpedIn } from "../../monos/model/delegationStore";
import { isOpenDelegation, type Delegation } from "../../monos/model/delegations";
import { delegationOf } from "../../monos/model/delegationView";
import { isOrchestratorChat } from "../../monos/model/orchestrators";
import { isCrash, type StuckWorker } from "../../monos/model/workerStuck";

/**
 * A question this chat asks goes to the chat that delegated it (a Lead, or a coding-team chat), not to Ash: its open
 * row is an orchestrator's.
 */
export function questionGoesToLead(sessionId: string, rows: readonly Delegation[]): boolean {
  const row = delegationOf(sessionId, rows);
  return !!row && isOpenDelegation(row) && isOrchestratorChat(row.ownerSession) && !hasJumpedIn(sessionId);
}

/** A stalled or crashed worker its Lead (an orchestrator chat) handles, unless Ash has jumped into its chat. */
export function leadHandles(stuck: Pick<StuckWorker, "kind" | "row">): boolean {
  if (stuck.kind === "asking") return false;
  if (!isOrchestratorChat(stuck.row.ownerSession) || hasJumpedIn(stuck.row.childSession)) return false;
  return stuck.kind === "stalled" || isCrash(stuck.row);
}

/** How far back a stuck episode may have begun and still be news when the app starts. */
const START_SLACK_MS = 5_000;

/** Which stuck workers are news: escalated, begun during this run, and not announced yet. */
export class StuckNotifier {
  private told = new Set<string>();

  constructor(private startedAt: number = Date.now()) {}

  due(stuck: readonly StuckWorker[]): StuckWorker[] {
    const fresh = stuck.filter(
      (s) => s.escalated && !leadHandles(s) && s.since >= this.startedAt - START_SLACK_MS && !this.told.has(s.key),
    );
    fresh.forEach((s) => this.told.add(s.key));
    return fresh;
  }
}

/** The banner: "EXO lead · Fix the save bug", then what is wrong. */
export function stuckNoticeText(stuck: StuckWorker, leadName: string): { title: string; subtitle: string; body: string } {
  const title = stuck.row.title?.trim() || "Delegated work";
  const body =
    stuck.kind === "asking"
      ? `${leadName} hasn't answered its question: ${stuck.line}`
      : stuck.kind === "failed"
        ? stuck.line
        : `Stuck: ${stuck.line}`;
  return { title: "MonoCode", subtitle: `${leadName} · ${title}`, body: body.length > 240 ? `${body.slice(0, 239)}…` : body };
}
