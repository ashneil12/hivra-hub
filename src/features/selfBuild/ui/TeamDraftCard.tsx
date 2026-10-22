// A Mono's draft of a new team (A6), shown in the chat it was drafted in, as a message in the scroll, beside the
// new-Mono cards: never over the chat.
import {
  dismissTeamDraft,
  teamDraftsIn,
  useWaitingTeamDrafts,
  type TeamDraft,
} from "../model/teamMake";
import { monoForSession } from "../../monos/model/mono";
import { hubData } from "../../hub/model/hubData";

// Glass, in the flow: no fixed or absolute placement, no shadow lifting it over the messages.
const card = "sidebar-glass rounded-xl ring-1 ring-surface-ring";
const quietBtn = "rounded-md px-3 py-1.5 text-[13px] transition-colors disabled:opacity-40 text-content/70 hover:bg-surface-raised hover:text-content";

/** The waiting team drafts that belong in this chat: a group chat's conversation, or a Mono's own chat. */
export function TeamDraftsInChat(props: { room: string; conv?: string } | { session: string }) {
  const drafts = useWaitingTeamDrafts();
  const place = "room" in props ? { room: props.room, ...(props.conv ? { conv: props.conv } : {}) } : { session: props.session, monoId: monoForSession(props.session)?.id };
  const mine = teamDraftsIn(drafts, place);
  if (!mine.length) return null;
  return (
    <div className="flex flex-col gap-2 py-1" data-team-drafts>
      {mine.map((d) => <TeamDraftCard key={d.id} draft={d} />)}
    </div>
  );
}

/** A Mono's draft of a new team, before Ash's yes: its name, what it's for, its projects and the Monos that belong. */
export function TeamDraftCard({ draft }: { draft: TeamDraft }) {
  const projects = draft.projects
    .map((id) => hubData().listProjects().find((p) => p.id === id)?.name ?? id)
    .join(", ");
  return (
    <div
      className={`${card} w-full max-w-xl px-4 py-3`}
      data-team-draft-in-chat
      data-team-draft={draft.id}
    >
      <div className="flex items-baseline gap-3">
        <div className="min-w-0 flex-1 truncate text-[14px] font-medium text-content" data-team-draft-name>
          {draft.name} team
        </div>
        <span className="shrink-0 text-[12px] text-content/60">from {draft.by.name}</span>
      </div>
      <p className="mt-2 text-[13px] leading-5 text-content/85">{draft.brief}</p>
      <p className="mt-1 text-[12px] leading-5 text-content/70" data-team-draft-projects>
        <span className="text-content/60">Projects: </span>
        {projects}
      </p>
      <p className="mt-1 text-[12px] leading-5 text-content/70" data-team-draft-members>
        <span className="text-content/60">Monos: </span>
        {draft.members.length ? draft.members.map((m) => m.name).join(", ") : "none yet"}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <span className="flex-1 text-[12px] text-content/60">
          Nothing is made yet. Say yes in the chat to make it.
        </span>
        <button
          type="button"
          className={quietBtn}
          data-team-draft-dismiss
          onClick={() => dismissTeamDraft(draft.id)}
        >
          Not this one
        </button>
      </div>
    </div>
  );
}
