// A Mono's draft of a new Mono (step 13), shown in the chat it was drafted in, as a message in the scroll: never over
// the chat (Critiquito, r29: the floating card covered Ash's message and the reply).
import {
  dismissDraft,
  draftCard,
  draftsIn,
  toAsh,
  useWaitingDrafts,
  type MonoDraft,
} from "../model/monoMake";
import { monoAvatar, monoForSession } from "../../monos/model/mono";
import { MonoRailMascot } from "../../monos/ui/MonoRailMascot";
import { skillDisplayName } from "../../skills/model/skillDisplayName";

// Glass, in the flow: no fixed or absolute placement, no shadow lifting it over the messages.
const card = "sidebar-glass rounded-xl ring-1 ring-surface-ring";
const quietBtn = "rounded-md px-3 py-1.5 text-[13px] transition-colors disabled:opacity-40 text-content/70 hover:bg-surface-raised hover:text-content";

/** The waiting drafts that belong in this chat: a group chat's conversation, or a Mono's own chat. */
export function MonoDraftsInChat(props: { room: string; conv?: string } | { session: string }) {
  const drafts = useWaitingDrafts();
  const place = "room" in props ? { room: props.room, ...(props.conv ? { conv: props.conv } : {}) } : { session: props.session, monoId: monoForSession(props.session)?.id };
  const mine = draftsIn(drafts, place);
  if (!mine.length) return null;
  return (
    <div className="flex flex-col gap-2 py-1" data-mono-drafts>
      {mine.map((d) => <DraftCard key={d.id} draft={d} />)}
    </div>
  );
}

/** A Mono's draft of a new Mono, before Ash's yes (step 13): its creature as the sidebar will draw it, and its soul. */
export function DraftCard({ draft }: { draft: MonoDraft }) {
  const { who, watchFor, skills } = draftCard(draft);
  // Plain names, never ids: "Copywriting", not "ash-copywriting" (r29).
  const owners = [draft.by.monoId, draft.by.name];
  const look = draft.look ?? { mascot: "robot", color: "hsl(210 8% 58%)" };
  return (
    <div
      className={`${card} w-full max-w-xl px-4 py-3`}
      data-mono-draft-in-chat
      data-mono-draft={draft.id}
    >
      <div className="flex items-center gap-3">
        <MonoRailMascot
          name={monoAvatar({ mascot: look.mascot, name: draft.name })}
          color={look.color}
          // A draft isn't running yet: no status dot.
          dot={false}
          className="size-9 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[14px] font-medium text-content"
            data-mono-draft-name
          >
            {draft.name}
          </div>
          {draft.role ? (
            <div
              className="truncate text-[12px] text-content/70"
              data-mono-draft-role
            >
              {toAsh(draft.role)}
            </div>
          ) : null}
        </div>
        <span className="shrink-0 text-[12px] text-content/60">
          from {draft.by.name}
        </span>
      </div>
      {who ? (
        <p className="mt-2 text-[13px] leading-5 text-content/85">{who}</p>
      ) : null}
      {watchFor ? (
        <p className="mt-1 text-[13px] leading-5 text-content/85">
          <span className="text-content/60">Watches for: </span>
          {watchFor}
        </p>
      ) : null}
      {skills.length ? (
        <p className="mt-1 text-[12px] leading-5 text-content/70">
          Skills: <span data-mono-draft-skills>{skills.map((s) => skillDisplayName(s, { owners })).join(", ")}</span>
        </p>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <span className="flex-1 text-[12px] text-content/60">
          Nothing is made yet. Say yes in the chat to make it; this card only turns it down.
        </span>
        <button
          type="button"
          className={quietBtn}
          data-mono-draft-dismiss
          onClick={() => dismissDraft(draft.id)}
        >
          Not this one
        </button>
      </div>
    </div>
  );
}
