import { useState } from "react";
import { Check } from "../../../shared/ui/icons";
import { needsReason } from "../model/chatQuestions";
import { userLabel } from "../model/userName";
import { NEEDS_YOU } from "../model/statusChip";
import { ChipMark, redRowProps } from "./StatusMark";
import {
  answerApproval,
  answerInWords,
  openWaitingChat,
  takePick,
  useWaitingChatsVersion,
  waitingChats,
  type TakeResult,
  type WaitingChat,
} from "../model/waitingChats";

const BTN = "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-60";
const PRIMARY = "shrink-0 rounded-md bg-content px-2.5 py-1 text-xs font-medium text-background-base hover:opacity-90 disabled:opacity-60";

type Sent = { chat: WaitingChat; text: string };

/**
 * "Waiting on you" on Today (and a project's Inbox): one row per chat whose agent asked Ash something, with the project,
 * the chat, its one-line question and the agent's pick. "Take the pick" answers in that chat in one tap, "Open" jumps
 * in, the box answers in his words. Answered rows stay ticked until he leaves the page, so several clear in a row; "Take
 * all N picks" does that for every row with a pick that is not a red line.
 */
export function WaitingOnYou({ projectId }: { projectId: string | undefined }) {
  useWaitingChatsVersion();
  const [sent, setSent] = useState<Record<string, Sent>>({});
  // Rows being answered stay put (the store drops a chat the moment its answer goes) until they turn into a tick.
  const [held, setHeld] = useState<Record<string, WaitingChat>>({});
  const [busyAll, setBusyAll] = useState(false);
  const waiting = waitingChats(projectId);
  const extra = [...Object.values(held), ...Object.values(sent).map((s) => s.chat)];
  const shown = [...waiting, ...extra.filter((c, i) => !waiting.some((w) => w.sessionId === c.sessionId) && extra.findIndex((e) => e.sessionId === c.sessionId) === i)].sort(
    (a, b) => a.askedAt - b.askedAt,
  );
  if (!shown.length) return null;
  const answer = async (chat: WaitingChat, call: () => Promise<TakeResult>): Promise<TakeResult> => {
    setHeld((prev) => ({ ...prev, [chat.sessionId]: chat }));
    const res = await call();
    if (res.ok) setSent((prev) => ({ ...prev, [chat.sessionId]: { chat, text: res.sent } }));
    setHeld((prev) => {
      const { [chat.sessionId]: _done, ...rest } = prev;
      return rest;
    });
    return res;
  };
  const takeable = waiting.filter((c) => c.pick && !c.redLine && !c.provide);
  const takeAll = async () => {
    setBusyAll(true);
    for (const chat of takeable) await answer(chat, () => takePick(chat.sessionId));
    setBusyAll(false);
  };
  return (
    <section aria-label="Waiting on you" data-hub-waiting>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-xs text-content/60">Waiting on you</h2>
        <span className="flex-1" />
        {takeable.length > 1 ? (
          <button type="button" className={BTN} disabled={busyAll} onClick={() => void takeAll()} data-hub-take-all>
            {busyAll ? "Sending…" : `Take all ${takeable.length} picks`}
          </button>
        ) : null}
      </div>
      <div className="flex flex-col">
        {shown.map((chat) =>
          // A tick, unless that chat has since asked something new.
          sent[chat.sessionId] && sent[chat.sessionId].chat.askedAt === chat.askedAt ? (
            <SentRow key={chat.sessionId} sent={sent[chat.sessionId]} />
          ) : (
            <WaitingRow key={chat.sessionId} chat={chat} showProject={!projectId} answer={(call) => answer(chat, call)} />
          ),
        )}
      </div>
    </section>
  );
}

function WaitingRow({ chat, showProject, answer }: { chat: WaitingChat; showProject: boolean; answer: (call: () => Promise<TakeResult>) => Promise<TakeResult> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = async (call: () => Promise<TakeResult>, from?: HTMLElement | null) => {
    // The next waiting row's box takes the cursor, so a run of answers never needs the mouse.
    const next = from ? nextReply(from) : null;
    setBusy(true);
    setProblem(null);
    const res = await answer(call);
    setBusy(false);
    if (!res.ok) return setProblem(res.reason);
    next?.focus();
  };
  // A row with no project shows just its chat's name: no "No project ·" in front.
  const where = [showProject ? chat.projectName : null, chat.chatName].filter(Boolean).join(" · ");
  return (
    <div className="flex flex-col gap-1 rounded-md px-2 py-2 hover:bg-content/5" data-hub-waiting-chat={chat.sessionId} {...redRowProps(true)}>
      <div className="flex items-center gap-2 text-[12px] text-content/60">
        {/* r65 (PM/Critiquito r63): every ask here is one only Ash can act on, so each row carries the red Needs you
            ring; the project badge counts these rows (todayCounts.ts), so badge and red rows agree. */}
        <span data-hub-waiting-red><ChipMark chip={NEEDS_YOU} /></span>
        {where ? <span className="min-w-0 truncate" data-hub-waiting-where>{where}</span> : null}
        {/* Why Ash is needed, one word phrase from a fixed list, the same plain grey for every reason (port map idea 3).
            The gate's own reason (D3) is on hover, so a row that shouldn't be here can be traced. */}
        {where ? <span className="shrink-0" aria-hidden>·</span> : null}
        <span className="shrink-0" data-hub-waiting-reason data-hub-gate={chat.gate?.kind} title={chat.gate?.reason}>{needsReason(chat)}</span>
        {chat.redLine ? <span className="sr-only" data-hub-red-line>Red line</span> : null}
      </div>
      {chat.provide ? (
        // r65 (PM's r63 run): a key only Ash can make is an errand, not an approval: plain words, no Approve/Deny.
        <div className="flex flex-col gap-0.5" data-hub-provide>
          <div className="whitespace-normal break-words text-[13px] font-medium leading-5 text-content" data-hub-waiting-question>
            {userLabel()} needs to provide {chat.provide}
          </div>
          <div className="text-[12px] leading-5 text-content/60" data-hub-provide-note>
            Open the chat to see where it goes. Don't paste keys or passwords here.
          </div>
        </div>
      ) : (
        <div className="whitespace-normal break-words text-[13px] leading-5 text-content" data-hub-waiting-question>
          {chat.question}
          {chat.more ? <span className="text-content/60"> (+{chat.more} more)</span> : null}
        </div>
      )}
      {/* No suggestion, no line: the reply box and Open chat already say what to do. */}
      {chat.pick && !chat.provide ? (
        <div className="whitespace-normal break-words text-[13px] leading-5 text-content/60" data-hub-waiting-pick>
          Suggests: {chat.pick}
        </div>
      ) : null}
      <div className="mt-1 flex items-center gap-2">
        {chat.provide ? null : chat.redLine ? (
          // A red line is an approval: two explicit choices in the same quiet style, neither one the default, and no
          // "this session" or "always" (matched to Alan's Workspace approvalBody, minus its broader grants).
          <span className="flex shrink-0 items-center gap-2" data-hub-approval role="group" aria-label="Approve or deny">
            <button type="button" className={BTN} disabled={busy} data-hub-approve-once onClick={(e) => void run(() => answerApproval(chat.sessionId, "approve-once", chat), e.currentTarget)}>
              Approve once
            </button>
            <button type="button" className={BTN} disabled={busy} data-hub-deny onClick={(e) => void run(() => answerApproval(chat.sessionId, "deny", chat), e.currentTarget)}>
              Deny
            </button>
          </span>
        ) : chat.pick ? (
          <button type="button" className={PRIMARY} disabled={busy} data-hub-take-pick onClick={(e) => void run(() => takePick(chat.sessionId), e.currentTarget)}>
            Take the pick
          </button>
        ) : null}
        <button type="button" className={BTN} data-hub-open-chat onClick={() => openWaitingChat(chat.sessionId)}>
          Open
        </button>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && text.trim() && !busy) void run(() => answerInWords(chat.sessionId, text), e.currentTarget);
          }}
          placeholder={chat.provide ? "Say when it's done, or reply in your words…" : "Or answer in your words…"}
          aria-label={`Answer ${chat.chatName} in your words`}
          maxLength={4000}
          data-hub-waiting-reply
          className="min-w-0 flex-1 rounded-md bg-content/5 px-2.5 py-1 text-[13px] text-content outline-none placeholder:text-content/50 focus:bg-content/10"
        />
        <button type="button" className={BTN} disabled={busy || !text.trim()} data-hub-waiting-send onClick={(e) => void run(() => answerInWords(chat.sessionId, text), e.currentTarget)}>
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
      {problem ? <div className="text-[13px] text-content/60" data-hub-waiting-problem>{problem}</div> : null}
    </div>
  );
}

function SentRow({ sent }: { sent: Sent }) {
  return (
    <div className="flex items-center gap-3 rounded-md px-2 py-2" data-hub-waiting-sent={sent.chat.sessionId}>
      <span className="grid size-6 shrink-0 place-items-center text-content/60" role="img" aria-label="Answered">
        <Check className="size-3.5" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1 text-[13px] leading-5 text-content/60">
        <span className="text-content/85">{sent.chat.chatName}</span>: {sent.text}
      </div>
    </div>
  );
}

function nextReply(from: HTMLElement): HTMLInputElement | null {
  let next = from.closest("[data-hub-waiting-chat]")?.nextElementSibling;
  while (next && !next.querySelector("[data-hub-waiting-reply]")) next = next.nextElementSibling;
  return (next?.querySelector("[data-hub-waiting-reply]") as HTMLInputElement | null) ?? null;
}
