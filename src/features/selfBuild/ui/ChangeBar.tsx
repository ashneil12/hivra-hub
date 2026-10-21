import { useEffect } from "react";
import {
  applyOffered,
  discardOffered,
  showPreview,
  useOfferedChanges,
} from "../model/changeFlow";
import { resumeLivePreview } from "../model/hubCode";
import {
  chatPreviewShown,
  openChatPreview,
  useChatPagePreview,
} from "../model/pagesChat";
import {
  dismissDraft,
  draftCard,
  toAsh,
  useWaitingDrafts,
  type MonoDraft,
} from "../model/monoMake";
import { monoAvatar } from "../../monos/model/mono";
import { MonoRailMascot } from "../../monos/ui/MonoRailMascot";

/**
 * What a Mono made for Ash and is waiting on him, at the bottom of the window (ash-day steps 14 and 15): a change
 * with Now | Preview, Apply and Discard, and a page preview with See it. Glass, theme tokens only.
 */
// The sidebar's glass with a strong blur, over a near-solid surface, so the screen under it never shows through.
const card =
  "sidebar-glass pointer-events-auto relative isolate rounded-xl ring-1 ring-surface-ring shadow-lg backdrop-blur-2xl before:absolute before:inset-0 before:-z-10 before:rounded-xl before:bg-surface/90 before:content-['']";
const btn =
  "rounded-md px-3 py-1.5 text-[13px] transition-colors disabled:opacity-40";
const quietBtn = `${btn} text-content/70 hover:bg-surface-raised hover:text-content`;
const primaryBtn = `${btn} bg-content/12 text-content hover:bg-content/18`;
const LIMITS =
  "This can't change Settings, keys, the Monos list or how the app starts.";

export function ChangeBar() {
  const offers = useOfferedChanges();
  const waiting = useChatPagePreview();
  // Already on Pages looking at it: no See it.
  const page =
    waiting && waiting.previewId !== chatPreviewShown() ? waiting : undefined;
  useEffect(() => {
    void resumeLivePreview();
  }, []);
  const drafts = useWaitingDrafts();
  if (!offers.length && !page && !drafts.length) return null;
  return (
    <>
      {drafts.length ? (
        // Up top, so the composer stays free for Ash's yes.
        <div
          className="pointer-events-none fixed inset-x-0 top-12 z-50 flex flex-col items-center gap-2 px-4"
          data-mono-drafts
        >
          {drafts.map((d) => (
            <DraftCard key={d.id} draft={d} />
          ))}
        </div>
      ) : null}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
        data-change-bar
      >
        {page ? (
          <div
            className={`${card} flex w-full max-w-xl items-center gap-3 px-4 py-2.5`}
            data-change-page={page.previewId}
          >
            <span className="min-w-0 flex-1 truncate text-[13px] text-content/85">
              {page.page.by} built a page: “{page.page.title}”. Nothing is saved
              until you keep it.
            </span>
            <button
              type="button"
              className={primaryBtn}
              data-change-see
              onClick={() => openChatPreview(page.previewId)}
            >
              See it
            </button>
          </div>
        ) : null}
        {offers.map((o) => (
          <div
            key={o.id}
            className={`${card} w-full max-w-xl px-4 py-3`}
            data-change-offer={o.id}
            data-previewing={o.previewing ? "1" : "0"}
          >
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-content">
                  {o.title}
                </div>
                <div className="text-[12px] text-content/65">
                  from {o.by} ·{" "}
                  {o.previewing
                    ? "Preview: showing in your hub now."
                    : "Now: your hub as it is."}
                </div>
              </div>
              <div
                role="group"
                aria-label="Now or Preview"
                className="flex rounded-md bg-content/5 p-0.5"
              >
                <button
                  type="button"
                  aria-pressed={!o.previewing}
                  disabled={o.busy}
                  data-change-now
                  className={`${btn} ${!o.previewing ? "bg-surface-raised text-content" : "text-content/70"}`}
                  onClick={() => void showPreview(o.id, false)}
                >
                  Now
                </button>
                <button
                  type="button"
                  aria-pressed={o.previewing}
                  disabled={o.busy}
                  data-change-preview
                  className={`${btn} ${o.previewing ? "bg-surface-raised text-content" : "text-content/70"}`}
                  onClick={() => void showPreview(o.id, true)}
                >
                  Preview
                </button>
              </div>
            </div>
            {o.parts?.length ? (
              <ul className="mt-2 list-disc pl-5 text-[12px] leading-5 text-content/75">
                {o.parts.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            ) : null}
            {o.problem ? (
              <div
                role="alert"
                className="mt-2 text-[12px] leading-5 text-content/85"
                data-change-problem
              >
                {o.problem}
              </div>
            ) : null}
            <div className="mt-2 flex items-center gap-2">
              <span className="min-w-0 flex-1 text-[11px] leading-4 text-content/60">
                {LIMITS} Undo later in Bot changes.
              </span>
              <button
                type="button"
                className={quietBtn}
                disabled={o.busy}
                data-change-discard
                onClick={() => void discardOffered(o.id)}
              >
                Discard
              </button>
              <button
                type="button"
                className={primaryBtn}
                disabled={o.busy}
                data-change-apply
                onClick={() => void applyOffered(o.id)}
              >
                Apply
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** A Mono's draft of a new Mono, before Ash's yes (step 13): its creature as the sidebar will draw it, and its soul. */
function DraftCard({ draft }: { draft: MonoDraft }) {
  const { who, watchFor, skills } = draftCard(draft);
  const look = draft.look ?? { mascot: "robot", color: "hsl(210 8% 58%)" };
  return (
    <div
      className={`${card} w-full max-w-xl px-4 py-3`}
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
          Skills: {skills.join(", ")}
        </p>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <span className="flex-1 text-[12px] text-content/60">
          Nothing is made yet. Say yes in the chat to make it.
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
