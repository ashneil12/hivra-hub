import { useState } from "react";
import { Check } from "../../../shared/ui/icons";
import { askText, needsReason } from "../model/chatQuestions";
import { userLabel } from "../model/userName";
import { NEEDS_YOU } from "../model/statusChip";
import { ChipMark, redRowProps } from "./StatusMark";
import {
  answerApproval,
  answerPermission,
  answerInWords,
  answerRow,
  openRows,
  openWaitingChat,
  takePick,
  useWaitingChatsVersion,
  waitingChats,
  type TakeResult,
  type WaitingChat,
} from "../model/waitingChats";
import type { AskRow } from "../model/chatQuestions";

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
  const waiting = waitingChats(projectId, { leadership: true });
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
            {busyAll ? "Sending…" : takeAllLabel(takeable.length)}
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

/** One waiting chat's card: Today, a project's Inbox, and (r76) Being built all show this same row. */
export function WaitingRow({ chat, showProject, answer }: { chat: WaitingChat; showProject: boolean; answer: (call: () => Promise<TakeResult>) => Promise<TakeResult> }) {
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
  // r99 (Critiquito 3): several decisions in one ask: one row each, its own answer, under the shared heading if any.
  const rows = chat.source === "permission" || chat.provide ? [] : openRows(chat);
  if (rows.length > 1)
    return (
      <div className="flex flex-col gap-1 rounded-md px-2 py-2 hover:bg-content/5" data-hub-waiting-chat={chat.sessionId} {...redRowProps(true)}>
        <div className="flex items-center gap-2 text-[12px] text-content/60">
          <span data-hub-waiting-red><ChipMark chip={NEEDS_YOU} /></span>
          {where ? <span className="min-w-0 truncate" data-hub-waiting-where>{where}</span> : null}
          {where ? <span className="shrink-0" aria-hidden>·</span> : null}
          <span className="shrink-0" data-hub-waiting-reason data-hub-gate={chat.gate?.kind} title={chat.gate?.reason}>{rows.length} decisions</span>
          <span className="flex-1" />
          <button type="button" className={BTN} data-hub-open-chat onClick={() => openWaitingChat(chat.sessionId)}>
            Open
          </button>
        </div>
        {chat.heading ? <div className="text-[13px] font-medium leading-5 text-content" data-hub-waiting-heading>{askText(chat.heading)}</div> : null}
        <ol className="flex list-none flex-col gap-2" data-hub-waiting-rows>
          {rows.map((row) => (
            <DecisionRow key={row.question} chat={chat} row={row} />
          ))}
        </ol>
      </div>
    );
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
          {askText(chat.question)}
          {chat.more ? <span className="text-content/60"> (+{chat.more} more)</span> : null}
        </div>
      )}
      {/* r76 (Critiquito): "which of those two?" shows the two, so the card can be answered as it stands. */}
      {chat.options?.length && !chat.provide ? (
        <ol className="flex list-none flex-col gap-0.5 text-[13px] leading-5 text-content/85" data-hub-waiting-options>
          {chat.options.map((option, i) => (
            <li key={i} className="flex gap-1.5" data-hub-waiting-option>
              <span className="shrink-0 text-content/50" aria-hidden>{i + 1}.</span>
              <span className="min-w-0 break-words">{option}</span>
              {/* r97 (Critiquito g): the Lead's pick is marked on its option. */}
              {chat.pick && option.trim().toLowerCase() === chat.pick.trim().toLowerCase() ? (
                <span className="shrink-0 text-content/50" data-hub-waiting-option-pick>(its pick)</span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {/* No suggestion, no line: the reply box and Open chat already say what to do. */}
      {chat.pick && !chat.provide ? (
        <div className="whitespace-normal break-words text-[13px] leading-5 text-content/60" data-hub-waiting-pick>
          Suggests: {chat.pick}{chat.why ? `. ${chat.why}` : ""}
        </div>
      ) : null}
      <div className="mt-1 flex items-center gap-2">
        {chat.source === "permission" ? (
          // r77: the chat's held tool call, answered in place: the same two plain choices as its own card.
          <span className="flex shrink-0 items-center gap-2" data-hub-permission role="group" aria-label="Allow or deny">
            <button type="button" className={BTN} disabled={busy} data-hub-allow onClick={(e) => void run(async () => answerPermission(chat.sessionId, "allow"), e.currentTarget)}>
              Allow
            </button>
            <button type="button" className={BTN} disabled={busy} data-hub-deny onClick={(e) => void run(async () => answerPermission(chat.sessionId, "deny"), e.currentTarget)}>
              Deny
            </button>
          </span>
        ) : chat.provide ? null : chat.redLine ? (
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
        {chat.source === "permission" ? null : (<>
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
        </>)}
      </div>
      {problem ? <div className="text-[13px] text-content/60" data-hub-waiting-problem>{problem}</div> : null}
    </div>
  );
}

/** r99 (Critiquito 3): one decision of a card with several, answered on its own. */
function DecisionRow({ chat, row }: { chat: WaitingChat; row: AskRow }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = async (words: string, by: "words" | "pick") => {
    setBusy(true);
    setProblem(null);
    // Not the whole card's tick: the other decisions stay open (the store drops this row at once).
    const res = await answerRow(chat.sessionId, row, words, by);
    setBusy(false);
    if (!res.ok) setProblem(res.reason);
  };
  return (
    <li className="flex flex-col gap-0.5 border-l border-content/10 pl-2" data-hub-waiting-row>
      <div className="whitespace-normal break-words text-[13px] leading-5 text-content" data-hub-waiting-question>
        {askText(row.question)}
      </div>
      {row.options?.length ? (
        <ol className="flex list-none flex-col gap-0.5 text-[13px] leading-5 text-content/85" data-hub-waiting-options>
          {row.options.map((option, i) => (
            <li key={i} className="flex gap-1.5" data-hub-waiting-option>
              <span className="shrink-0 text-content/50" aria-hidden>{i + 1}.</span>
              <span className="min-w-0 break-words">{option}</span>
              {row.pick && option.trim().toLowerCase() === row.pick.trim().toLowerCase() ? (
                <span className="shrink-0 text-content/50" data-hub-waiting-option-pick>(its pick)</span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {row.pick ? (
        <div className="whitespace-normal break-words text-[13px] leading-5 text-content/60" data-hub-waiting-pick>
          Suggests: {row.pick}
        </div>
      ) : null}
      <div className="mt-1 flex items-center gap-2">
        {row.redLine ? (
          <span className="flex shrink-0 items-center gap-2" data-hub-approval role="group" aria-label="Approve or deny">
            <button type="button" className={BTN} disabled={busy} data-hub-approve-once onClick={() => void run(`Approved, this once: ${row.pick ?? row.question}`, "words")}>
              Approve once
            </button>
            <button type="button" className={BTN} disabled={busy} data-hub-deny onClick={() => void run(`Denied: don't do this. (${row.question})`, "words")}>
              Deny
            </button>
          </span>
        ) : row.pick ? (
          <button type="button" className={PRIMARY} disabled={busy} data-hub-take-pick onClick={() => void run(row.pick!, "pick")}>
            Take the pick
          </button>
        ) : null}
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && text.trim() && !busy) void run(text, "words");
          }}
          placeholder="Or answer in your words…"
          aria-label={`Answer "${row.question}" in your words`}
          maxLength={4000}
          data-hub-waiting-reply
          className="min-w-0 flex-1 rounded-md bg-content/5 px-2.5 py-1 text-[13px] text-content outline-none placeholder:text-content/50 focus:bg-content/10"
        />
        <button type="button" className={BTN} disabled={busy || !text.trim()} data-hub-waiting-send onClick={() => void run(text, "words")}>
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
      {problem ? <div className="text-[13px] text-content/60" data-hub-waiting-problem>{problem}</div> : null}
    </li>
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

/** r102 (12, Critiquito): "Take both picks" for two, "Take all N picks" from three. */
export function takeAllLabel(count: number): string {
  return count === 2 ? "Take both picks" : `Take all ${count} picks`;
}
