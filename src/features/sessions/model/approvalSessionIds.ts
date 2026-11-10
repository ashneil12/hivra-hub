import type { Delegation } from "../../monos/model/delegations";
import { waitsOnlyOnItsLead } from "../../monos/model/workerStuck";
import { hasPendingApproval, sessionNeedsInput, type Session } from "./session";

export type ApprovalSessionIds = {
  /** Chats that need Ash's input: their own approval or question, and the Lead of a worker that needs it. */
  ids: Set<string>;
  /**
   * The Leads in `ids` that are there because a worker they lead needs input. A Lead can also have a need of its own
   * (an open question); being listed for that is not the same as being listed for the worker's approval.
   */
  elsewhere: Set<string>;
};

/** The session ids the sidebar marks "Needs approval", and which of them are listed for a worker's need. */
export function approvalSessionIdsOf(
  sessions: readonly Session[],
  delegationRows: readonly Pick<Delegation, "childSession" | "createdAt" | "state">[],
): ApprovalSessionIds {
  const ids = new Set<string>();
  const elsewhere = new Set<string>();
  for (const session of sessions) {
    // A worker only waiting on its Lead's answer is not Ash's input (D5): no "Need approval" on it or its Lead.
    if (
      sessionNeedsInput(session) &&
      !waitsOnlyOnItsLead(
        {
          id: session.id,
          pendingQuestion: session.pendingQuestion,
          approvalPending: hasPendingApproval(session.blocks),
        },
        delegationRows,
      )
    ) {
      ids.add(session.id);
      if (session.orchestrationLeadId) {
        ids.add(session.orchestrationLeadId);
        elsewhere.add(session.orchestrationLeadId);
      }
    }
  }
  return { ids, elsewhere };
}
