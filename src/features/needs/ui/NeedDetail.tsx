import { useMemo, useState, type ReactNode } from "react";
import { hubData, useHubDataVersion } from "../../hub/model/hubData";
import { openMonoChat } from "../../hub/model/hubNav";
import { sendToChat } from "../../hub/model/waitingChats";
import { NEEDS_YOU_RED } from "../../hub/ui/StatusMark";
import { needActions } from "../../home/model/needActions";
import { openFromHome } from "../../home/model/opener";
import { findMono } from "../../monos/model/mono";
import { askedAgo, markAsked, NEED_KIND_LABEL, needChatId, needPlace, openNeed, shownNeed } from "../model/needContext";
import { useNeedsYou } from "../model/needsLive";
import type { NeedsItem } from "../model/needsYou";
import { inboxNeedsOrder } from "./InboxNeeds";
import { NeedChoices } from "./NeedChoices";
import { answeredLine, noteAnswered, useLastAnswered, type AnsweredNeed } from "../model/answeredNeeds";
import { Check } from "../../../shared/ui/icons";
import { MOD } from "../../../platform/tauri/platform";
import { openBesideChief } from "../../asks/model/besideChat";

const BUTTON = "inline-flex h-7 items-center rounded-md px-2.5 text-[12px] leading-none transition-transform duration-[120ms] ease-[var(--motion-ease-out)] active:scale-[0.97] motion-reduce:transition-none";
const FILLED = `${BUTTON} bg-accent font-medium text-black`;
const BORDERED = `${BUTTON} border border-content/20 text-content hover:bg-content/8`;
const PRIMARY = `${BUTTON} bg-content font-medium text-background-base hover:bg-content/80`;
const QUIET = "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] text-content/70 hover:bg-content/8 hover:text-content";

/** The open row of the Needs you list, as the Inbox shows it. None when nothing is picked (or it was answered). */
export function useShownNeed(picked: string | null, firstWhenNone: boolean): NeedsItem | undefined {
  const needs = useNeedsYou();
  return useMemo(() => shownNeed(inboxNeedsOrder(needs), picked, firstWhenNone), [needs, picked, firstWhenNone]);
}

/**
 * Dropwave (Ash, 11 Nov: "if I click on any of the stuff, it doesn't actually bring me to anything"): the card a
 * Needs you row opens. What was asked, who asked and when, every answer offered (Ash, 13 Nov: "it only gives you one
 * option"), the way to the chat or page it came from, and a box for his own words.
 *
 * Laid out like the Inbox's own pull request card (Ash, 13 Nov: MonoCode's GitHub screens look "way better"): the who
 * and when on one quiet line, the ask as the title, a hairline, then the answers and the reply box. `compact` is the
 * same card opened under its row (the Chief of Staff's Needs you list, a catch-up), where the row already says what
 * was asked and by whom.
 */
export function NeedDetail({ item, now = Date.now(), compact = false }: { item: NeedsItem; now?: number; compact?: boolean }) {
  useHubDataVersion();
  const project = item.projectId ? hubData().listProjects().find((p) => p.id === item.projectId)?.name : undefined;
  const choices = item.answer && item.choices?.length ? item.choices : [];
  // With every answer listed, the one tap is one of them; only the way out stays a button.
  const actions = choices.length ? [] : needActions(item).filter((action) => action.label !== "Open" && action.label !== "Open chat");
  const place = needPlace(item);
  const chatId = needChatId(item, findMono);
  const open = place
    ? { label: place.label, run: () => openNeed(item) }
    : chatId
      ? {
          label: "Open chat",
          run: () => {
            // The same chat the reply box sends to. When the decision names it as the chat that asked, the time it was
            // asked can find the message; in the first mate's other chat only the ask's own words can.
            markAsked(chatId, item, item.askedBy?.trim() === chatId);
            // From the Chief of Staff's one chat the asking chat opens beside it, so he never leaves (besideChat.ts).
            if (openBesideChief(chatId)) return;
            openFromHome({ kind: "chat", id: chatId, projectId: item.projectId ?? "" });
          },
        }
      : item.monoId
        ? { label: "Open chat", run: () => openMonoChat(item.monoId!, item.projectId ? { project: item.projectId } : undefined) }
        : undefined;
  const openButton = open ? (
    <button type="button" data-need-open="" onClick={open.run} className={compact ? QUIET : BORDERED}>
      {open.label}
    </button>
  ) : null;
  const canReply = !!item.answer || !!chatId;
  return (
    <article
      data-need-detail={item.key}
      aria-label="What needs you"
      className={compact ? "flex flex-col" : "flex h-full min-h-0 flex-col overflow-y-auto"}
    >
      {compact ? null : (
        <header data-need-header className="flex flex-col gap-2.5 border-b border-stroke px-6 pb-5 pt-5 xl:px-8">
          <div className="flex min-w-0 items-center gap-2 text-[12px] leading-4 text-content/50">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: NEEDS_YOU_RED }} />
            <span data-need-kind className="shrink-0 text-content/70">
              {NEED_KIND_LABEL[item.kind]}
            </span>
            <span aria-hidden>·</span>
            <span data-need-from className="min-w-0 truncate">
              {[project, item.who, askedAgo(item.at, now)].filter(Boolean).join(" · ")}
            </span>
          </div>
          <h2 data-need-sentence className="whitespace-pre-wrap break-words text-[20px] font-semibold leading-tight text-content">
            {item.sentence}
          </h2>
          {item.detail ? (
            <p data-need-line className="text-[13px] leading-5 text-content/70">
              {item.detail}
            </p>
          ) : null}
          {actions.length || open ? (
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
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
              {openButton}
            </div>
          ) : null}
        </header>
      )}
      <div className={`flex flex-col ${compact ? "gap-3 px-3 pb-3 pt-1" : "gap-5 px-6 py-5 xl:px-8"}`}>
        {choices.length ? (
          <section aria-label="Pick an answer" className="flex flex-col gap-2">
            {compact ? null : <h3 className="text-[12px] font-medium leading-4 text-content/70">Pick an answer</h3>}
            <NeedChoices key={item.key} item={item} />
          </section>
        ) : null}
        {compact && actions.length ? (
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
          </div>
        ) : null}
        {canReply ? (
          <NeedReply
            key={item.key}
            item={item}
            chatId={chatId}
            choices={choices.length > 0}
            primary={!actions.length}
            trailing={compact ? openButton : null}
          />
        ) : compact ? (
          openButton
        ) : null}
      </div>
    </article>
  );
}

/**
 * His own words (Ash, 13 Nov: "How can you actually send your own reply there"): they answer the question itself when
 * the row can (a decision or a chat's open question), else they go to the chat the ask came from as his next message.
 * Shaped like the Inbox's comment box.
 */
function NeedReply({
  item,
  chatId,
  choices,
  primary,
  trailing,
}: {
  item: NeedsItem;
  chatId: string | undefined;
  choices: boolean;
  primary: boolean;
  trailing: ReactNode;
}) {
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "answered" | "failed">("idle");
  const [reason, setReason] = useState<string | null>(null);
  const send = async () => {
    const words = text.trim();
    if (!words || state === "sending") return;
    setState("sending");
    setReason(null);
    if (item.answer) {
      const refused = await item.answer(words);
      if (refused) {
        setReason(refused);
        setState("failed");
        return;
      }
      setText("");
      setState("answered");
      noteAnswered({ key: item.key, words, who: item.who, sentence: item.sentence });
      return;
    }
    const ok = chatId ? await sendToChat(chatId, words) : false;
    if (ok) setText("");
    setState(ok ? "sent" : "failed");
  };
  return (
    <form
      data-need-reply=""
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="rounded-md border border-content/10 bg-content/5 transition-colors duration-[120ms] focus-within:border-content/25">
        <textarea
          value={text}
          rows={2}
          aria-label={`Reply to ${item.who}`}
          placeholder={choices ? `Or answer in your own words (${MOD}↩)` : `Reply to ${item.who} (${MOD}↩)`}
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
          className="max-h-40 w-full resize-none bg-transparent px-3 py-2 text-[13px] leading-5 text-content outline-none placeholder:text-content/40"
        />
        <div className="flex items-center gap-2 px-2 pb-2">
          {trailing}
          <button
            type="submit"
            disabled={!text.trim() || state === "sending"}
            className={`ml-auto ${primary ? PRIMARY : BORDERED} disabled:cursor-default disabled:opacity-40`}
          >
            Send
          </button>
        </div>
      </div>
      {state === "sent" ? (
        <span role="status" data-need-reply-state="sent" className="text-[12px] text-content/60">
          Sent to the chat.
        </span>
      ) : state === "answered" ? (
        <span role="status" data-need-reply-state="answered" className="text-[12px] text-content/60">
          Sent. {item.who} has it.
        </span>
      ) : state === "failed" ? (
        <span role="alert" data-need-reply-state="failed" className="text-[12px] text-red-400">
          {reason ?? "That did not send. Open the chat and say it there."}
        </span>
      ) : null}
    </form>
  );
}

/** The line that takes an answered card's place for a moment, so the answer is seen to land. */
export function AnsweredLine({ entry, className = "" }: { entry: AnsweredNeed; className?: string }) {
  return (
    <p
      role="status"
      data-need-answered={entry.key}
      className={`flex items-center gap-2 text-[13px] leading-5 text-content/70 need-answered-in ${className}`}
    >
      <Check className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
      <span className="min-w-0">{answeredLine(entry)}</span>
    </p>
  );
}

/**
 * The pane beside the Inbox's list when a Needs you row is open. `picked` is the row a person chose; with `asksOnly`
 * the first row opens by itself and the pane never falls back to a work item. Nothing open: `children` (the work item).
 */
export function NeedPane({ picked, asksOnly, children }: { picked: string | null; asksOnly: boolean; children: ReactNode }) {
  const item = useShownNeed(picked, asksOnly);
  const answered = useLastAnswered(picked ?? undefined);
  if (item) return <NeedDetail item={item} />;
  if (picked && answered) return <AnsweredLine entry={answered} className="px-6 py-6" />;
  if (picked || asksOnly) {
    return (
      <p data-need-done role="status" className="px-6 py-6 text-[13px] text-content/60">
        {picked ? "Done. That one no longer needs you." : "Nothing is asking for an answer."}
      </p>
    );
  }
  return <>{children}</>;
}
