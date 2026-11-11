import { useMemo, useState, type ReactNode } from "react";
import { hubData, useHubDataVersion } from "../../hub/model/hubData";
import { openMonoChat } from "../../hub/model/hubNav";
import { sendToChat } from "../../hub/model/waitingChats";
import { NEEDS_YOU_RED } from "../../hub/ui/StatusMark";
import { needActions } from "../../home/model/needActions";
import { openFromHome } from "../../home/model/opener";
import { findMono } from "../../monos/model/mono";
import { askedAgo, NEED_KIND_LABEL, needChatId, needPlace, shownNeed } from "../model/needContext";
import { useNeedsYou } from "../model/needsLive";
import type { NeedsItem } from "../model/needsYou";
import { inboxNeedsOrder } from "./InboxNeeds";

const BUTTON = "inline-flex h-7 items-center rounded-md px-2.5 text-[12px] leading-none";
const FILLED = `${BUTTON} bg-accent font-medium text-black`;
const BORDERED = `${BUTTON} border border-content/20 text-content hover:bg-content/8`;

/** The open row of the Needs you list, as the Inbox shows it. None when nothing is picked (or it was answered). */
export function useShownNeed(picked: string | null, firstWhenNone: boolean): NeedsItem | undefined {
  const needs = useNeedsYou();
  return useMemo(() => shownNeed(inboxNeedsOrder(needs), picked, firstWhenNone), [needs, picked, firstWhenNone]);
}

/**
 * Dropwave (Ash, 11 Nov: "if I click on any of the stuff, it doesn't actually bring me to anything"): the card a
 * Needs you row opens beside the list. What was asked, who asked and when, the row's own answers, the way to the chat
 * or page it came from, and a box that sends a few words to that chat.
 */
export function NeedDetail({ item, now = Date.now() }: { item: NeedsItem; now?: number }) {
  useHubDataVersion();
  const project = item.projectId ? hubData().listProjects().find((p) => p.id === item.projectId)?.name : undefined;
  const actions = needActions(item).filter((action) => action.label !== "Open" && action.label !== "Open chat");
  const place = needPlace(item);
  const chatId = needChatId(item, findMono);
  const open = place
    ? { label: place.label, run: () => openFromHome(place.target) }
    : item.monoId
      ? { label: "Open chat", run: () => openMonoChat(item.monoId!, item.projectId ? { project: item.projectId } : undefined) }
      : undefined;
  return (
    <article data-need-detail={item.key} aria-label="What needs you" className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-6 py-6">
        <header className="flex flex-col gap-1.5">
          <p className="flex items-center gap-1.5 text-[12px] leading-4 text-content/60">
            <span className="size-1.5 rounded-full" style={{ background: NEEDS_YOU_RED }} />
            <span data-need-kind>{NEED_KIND_LABEL[item.kind]}</span>
          </p>
          <h2 data-need-sentence className="whitespace-pre-wrap break-words text-[16px] font-medium leading-6 text-content">
            {item.sentence}
          </h2>
          <p data-need-from className="text-[12px] leading-4 text-content/55">
            {[project, item.who, askedAgo(item.at, now)].filter(Boolean).join(" · ")}
          </p>
        </header>
        {actions.length || open ? (
          <div className="flex flex-wrap items-center gap-2">
            {actions.map((action, index) => (
              <button
                key={action.label}
                type="button"
                data-need-answer=""
                title={action.title ?? action.label}
                onClick={action.onClick}
                className={index === 0 ? FILLED : BORDERED}
              >
                {action.label}
              </button>
            ))}
            {open ? (
              <button type="button" data-need-open="" onClick={open.run} className={BORDERED}>
                {open.label}
              </button>
            ) : null}
          </div>
        ) : null}
        {chatId ? <NeedReply key={item.key} chatId={chatId} who={item.who} /> : null}
      </div>
    </article>
  );
}

/** A few words sent to the chat the ask came from, as the person's next message there. */
function NeedReply({ chatId, who }: { chatId: string; who: string }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const send = async () => {
    const words = text.trim();
    if (!words || state === "sending") return;
    setState("sending");
    const ok = await sendToChat(chatId, words);
    if (ok) setText("");
    setState(ok ? "sent" : "failed");
  };
  return (
    <form
      data-need-reply=""
      className="flex flex-col gap-2 border-t border-stroke pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label className="flex flex-col gap-1.5 text-[12px] leading-4 text-content/60">
        Reply in the chat
        <textarea
          value={text}
          rows={3}
          aria-label={`Reply to ${who}`}
          placeholder={`A few words for ${who}`}
          onChange={(event) => {
            setText(event.currentTarget.value);
            if (state !== "sending") setState("idle");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            }
          }}
          className="w-full resize-none rounded-md border border-content/15 bg-transparent px-2.5 py-2 text-[13px] leading-5 text-content outline-none placeholder:text-content/40 focus:border-content/35"
        />
      </label>
      <div className="flex items-center gap-2">
        <button type="submit" disabled={!text.trim() || state === "sending"} className={`${BORDERED} disabled:opacity-40`}>
          Send
        </button>
        {state === "sent" ? (
          <span role="status" data-need-reply-state="sent" className="text-[12px] text-content/60">
            Sent to the chat.
          </span>
        ) : state === "failed" ? (
          <span role="alert" data-need-reply-state="failed" className="text-[12px] text-red-400">
            That did not send. Open the chat and say it there.
          </span>
        ) : null}
      </div>
    </form>
  );
}

/**
 * The pane beside the Inbox's list when a Needs you row is open. `picked` is the row a person chose; with `asksOnly`
 * the first row opens by itself and the pane never falls back to a work item. Nothing open: `children` (the work item).
 */
export function NeedPane({ picked, asksOnly, children }: { picked: string | null; asksOnly: boolean; children: ReactNode }) {
  const item = useShownNeed(picked, asksOnly);
  if (item) return <NeedDetail item={item} />;
  if (picked || asksOnly) {
    return (
      <p data-need-done role="status" className="px-6 py-6 text-[13px] text-content/60">
        {picked ? "Done. That one no longer needs you." : "Nothing is asking for an answer."}
      </p>
    );
  }
  return <>{children}</>;
}
