// Hivra WP-143: which chats belong to a crew. A Mono, a project's coding team (both first mates) and the workers
// they brief. These get the cheap Explore agent on Anthropic (integrations/harness/providers/claude/explorePin.ts);
// an ordinary chat in someone's own project does not.
import type { Delegation } from "../../monos/model/delegations";
import { isFirstMate } from "../../firstmate/model/checkoutGuard";
import type { Session } from "../../sessions/model/session";

/**
 * Whether this chat is a first mate or one of its workers. A worker is a chat the app started for a lead
 * (`orchestrationLeadId`) or one a Mono delegated to (a delegation row names it as its child).
 */
export function isCrewSession(
  session: Pick<Session, "id" | "firstMate" | "orchestrationLeadId">,
  delegations: readonly Pick<Delegation, "childSession">[],
): boolean {
  if (isFirstMate(session)) return true;
  if (session.orchestrationLeadId) return true;
  return !!session.id && delegations.some((row) => row.childSession === session.id);
}

/** The launch input a crew chat's turn adds (integrations/harness/core/types.ts `crew`). */
export function crewLaunch(
  session: Pick<Session, "id" | "firstMate" | "orchestrationLeadId">,
  delegations: readonly Pick<Delegation, "childSession">[],
): { crew?: true } {
  return isCrewSession(session, delegations) ? { crew: true } : {};
}
