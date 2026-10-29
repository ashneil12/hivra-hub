// r82 (Critiquito's r81 blocker): the upstream approval pop-up floated top right over the Inbox summary, with an amber
// "Question", the ask's short header for its text ("Delete keep") and "Claude Code" for its signature. In the hub an
// ask the app already lists (the rail's Needs you, Today's Waiting on you) gets no pop-up at all; any other one reads
// as the hub does: a red Needs you, the real question, and who asks (the Lead, or the job).
import { monoForSession } from "../../monos/model/mono";
import type { PendingApprovalNotice } from "../../notifications/model/approvalToast";
import { sessionDisplayTitle, type Session } from "../../sessions/model/session";
import { askedBy, permissionQuestion, whoAsks } from "./chatQuestions";
import { findWaitingChat } from "./waitingChats";

type Notice = PendingApprovalNotice & { session: Session };

/** The pop-ups the hub still shows: an ask already listed on screen has one already. */
export function hubToastNotices<T extends Notice>(notices: readonly T[], listed: (sessionId: string) => boolean = (id) => !!findWaitingChat(id)): T[] {
  return notices.filter((notice) => !listed(notice.sessionId));
}

/** A pop-up as the hub words it. */
export function hubToastView(notice: Notice, monoName: string | undefined = monoForSession(notice.sessionId)?.name): { badge: string; question: string; by: string } {
  const { session } = notice;
  const title = sessionDisplayTitle(session.title, session.harness);
  const who = whoAsks({ monoName, title });
  const question =
    notice.kind === "question"
      ? (session.pendingQuestion?.questions[0]?.prompt || session.pendingQuestion?.title || notice.label).trim()
      : askedBy(permissionQuestion(notice.block ? [notice.block] : [])?.question ?? `Allow it to take its next step?`, who);
  return { badge: "Needs you", question, by: monoName?.trim() || title };
}
