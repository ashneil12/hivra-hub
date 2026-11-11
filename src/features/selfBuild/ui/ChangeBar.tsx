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
import { openTodayChatPreview, todayPreviewShown, useTodayChatPreview } from "../model/todayChat";

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
  const todayWaiting = useTodayChatPreview();
  const today = todayWaiting && todayWaiting.previewId !== todayPreviewShown() ? todayWaiting : undefined;
  useEffect(() => {
    void resumeLivePreview();
  }, []);
  if (!offers.length && !page && !today) return null;
  return (
    <>
      {/* A Mono's draft of a new Mono is not here: it sits in the chat it was drafted in, as a message (MonoDraftCard). */}
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
              {page.page.by} built a hub: “{page.page.title}”. Nothing is saved
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
        {today ? (
          <div className={`${card} flex w-full max-w-xl items-center gap-3 px-4 py-2.5`} data-change-today={today.previewId}>
            <span className="min-w-0 flex-1 truncate text-[13px] text-content/85">
              {today.preview.by} made a change to Today: “{today.preview.title}”. Nothing changes until you apply it.
            </span>
            <button type="button" className={primaryBtn} data-change-today-see onClick={() => openTodayChatPreview(today.previewId)}>
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
                <div className="text-[12px] text-content/65" data-change-state>
                  from {o.by} ·{" "}
                  {o.busy
                    ? (o.workingText ?? "Working…")
                    : o.previewing
                      ? (o.previewText ?? "Preview: showing in your app now.")
                      : (o.nowText ?? "Now: your app as it is.")}
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
                {o.applyText ?? "Apply"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
