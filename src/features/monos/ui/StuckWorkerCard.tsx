// A stuck worker, answerable where Ash sees it (H4; Ash 20 Oct): its question, failure or stall in one line, then one or
// two clicks to answer it (an option, the worker's pick, or his words), tell it what to do, open its chat, stop it, or
// set a failure aside. The same card sits in the Lead's chat (above the composer), on Today and in Being built; only
// the frame differs (`variant`). Answered cards stay as a tick until Ash leaves, so several clear in a row.
import { useState } from "react";
import { Check, CircleAlert, Clock } from "../../../shared/ui/icons";
import { findMono, monoForSession, monoLook } from "../model/mono";
import {
  answerWithOption,
  answerWithStoredOption,
  dismissFailure,
  liveQuestion,
  openStuck,
  questionOptions,
  questionWithoutOptions,
  sendWords,
  storedOptions,
  stopStuck,
  suggestion,
  takeSuggestion,
  type StuckResult,
} from "../model/stuckActions";
import { leadActionLine, stuckMinutes, type StuckWorker } from "../model/workerStuck";
import { plainStuckLine, stuckWorkerChip } from "../model/stuckChip";
import { ChipMark, NeedsYouLinkLine, redRowProps } from "../../hub/ui/StatusMark";
import { SecondaryButton } from "../../../shared/ui/SecondaryButton";
import { foldStopped, stoppedLine } from "../model/stuckFold";

const BTN = "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-60";
const PRIMARY = "shrink-0 rounded-md bg-content px-2.5 py-1 text-xs font-medium text-background-base hover:opacity-90 disabled:opacity-60";
/** Tailwind's shadow-lg, spelled out so a red card's bar can sit on top of it (an inline box-shadow replaces the class). */
const CARD_SHADOW = "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)";
const QUIET = "shrink-0 rounded-md px-2 py-1 text-xs text-content/45 hover:bg-content/6 hover:text-content/80 disabled:opacity-60";

/** The Mono a worker answers to, by name ("EXO lead"). */
export function leadNameOf(stuck: Pick<StuckWorker, "row">): string {
  const mono = (stuck.row.ownerMono ? findMono(stuck.row.ownerMono) : undefined) ?? monoForSession(stuck.row.ownerSession);
  return mono ? monoLook(mono).name : "its Lead";
}

/** The worker's job, as its Lead named it. */
export function stuckTitle(stuck: Pick<StuckWorker, "row">): string {
  return stuck.row.title?.trim() || "Delegated work";
}

/** How long it has been stuck, short ("2h"): stuckMinutes, the clock Being built's job row reads too. */
function ago(min: number): string {
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  return min < 1440 ? `${Math.floor(min / 60)}h` : `${Math.floor(min / 1440)}d`;
}

/** A stuck worker's mark, the same as its child row in the Monos rail: a grey clock asking, a grey alert (r27b). */
export function StuckMark({ kind, className = "size-3.5" }: { kind: StuckWorker["kind"]; className?: string }) {
  if (kind === "asking") return <Clock className={`${className} shrink-0 text-content/45`} strokeWidth={1.75} aria-hidden />;
  return (
    <CircleAlert
      className={`${className} shrink-0 text-content/60`}
      strokeWidth={1.75}
      aria-hidden
    />
  );
}

/** What the worker is doing about it, after its title: "asking", "not answered yet", "stuck", "failed". */
export function stuckWord(stuck: StuckWorker): string {
  if (stuck.kind === "asking") return stuck.escalated ? "not answered yet" : "asking";
  return stuck.kind === "failed" ? "failed" : "stuck";
}

/** How many cards a Lead's chat shows before "N more stuck": its composer stays in view. */
export const CHAT_CARDS_SHOWN = 3;

type Done = { stuck: StuckWorker; said: string };

/**
 * One card per job in a chat (r65, Critiquito crit-2: a job whose workers failed three times stood as three stacked
 * copies of the same card). The first (newest) worker on a job stands for it; Today and Being built list every row.
 */
export function oneCardPerJob(stuck: readonly StuckWorker[]): StuckWorker[] {
  const seen = new Set<string>();
  return stuck.filter((s) => {
    const job = `${s.row.ownerSession ?? s.row.ownerMono ?? ""}\u0000${stuckTitle(s).toLowerCase()}`;
    if (seen.has(job)) return false;
    seen.add(job);
    return true;
  });
}

/** What happens next to a failed worker its Lead still has (r65): the Lead re-hands it once, then tells Ash. */
export function failedNextStep(lead: string): string {
  return `${lead} hands it to a fresh worker once, and tells you if that fails too.`;
}

export function StuckList({
  stuck,
  now,
  variant,
  where,
  leadName,
  label,
  heading,
  onOpened,
}: {
  stuck: readonly StuckWorker[];
  now: number;
  /** `chat`: a bordered card above a Lead's composer; `row`: a quiet row, as on Today and in Being built. */
  variant: "chat" | "row";
  /** What goes before the title on the top line (Today: "Hivra · EXO lead"). */
  where?: (stuck: StuckWorker) => string | undefined;
  /** Who the worker answers to, when the list knows better than its Mono (Today: "Hivra lead" from its project). */
  leadName?: (stuck: StuckWorker) => string;
  label?: string;
  /** A section heading over the list (Today's "Stuck"); the list and its heading go once nothing is left. */
  heading?: string;
  /** After "Open chat" jumped into a worker's chat (a popover over the rail closes itself). */
  onOpened?: () => void;
}) {
  const [done, setDone] = useState<Record<string, Done>>({});
  const [all, setAll] = useState(false);
  const [stoppedOpen, setStoppedOpen] = useState(false);
  if (variant === "chat") stuck = oneCardPerJob(stuck);
  const held = Object.values(done).filter((d) => !stuck.some((s) => s.key === d.stuck.key));
  if (!stuck.length && !held.length) return null;
  // r70: above a Lead's composer, stopped workers are one line until Ash opens it.
  const folded = variant === "chat" ? foldStopped(stuck, stoppedOpen) : { cards: [...stuck], stopped: 0, stalled: 0 };
  const shownCards = folded.cards;
  const more = variant === "chat" && !all ? Math.max(0, shownCards.length - CHAT_CARDS_SHOWN) : 0;
  const cards = more ? shownCards.slice(0, CHAT_CARDS_SHOWN) : shownCards;
  const finished = (s: StuckWorker, said: string) => setDone((prev) => ({ ...prev, [s.key]: { stuck: s, said } }));
  const list = (
    <div data-stuck-list={variant} aria-label={label} className={variant === "chat" ? "flex flex-col gap-1.5 pb-1.5" : "flex flex-col"}>
      {folded.stopped ? (
        <div data-stuck-stopped-fold={stoppedOpen ? "open" : "closed"} className="flex items-center gap-1 px-2 font-sans text-[12px] text-content/55">
          <span>{stoppedLine(folded.stopped, folded.stalled)}</span>
          <span aria-hidden>·</span>
          <button
            type="button"
            data-stuck-stopped-toggle
            aria-expanded={stoppedOpen}
            onClick={() => setStoppedOpen((v) => !v)}
            className="rounded-md px-1 text-content/70 hover:bg-content/6 hover:text-content"
          >
            {stoppedOpen ? "Hide" : "Show"}
          </button>
        </div>
      ) : null}
      {cards.map((s) =>
        done[s.key] ? (
          <DoneRow key={s.key} done={done[s.key]} variant={variant} />
        ) : (
          <StuckWorkerCard
            key={s.key}
            stuck={s}
            now={now}
            variant={variant}
            where={where?.(s)}
            lead={leadName?.(s)}
            onDone={(said) => finished(s, said)}
            onOpened={onOpened}
          />
        ),
      )}
      {held.map((d) => (
        <DoneRow key={d.stuck.key} done={d} variant={variant} />
      ))}
      {more ? (
        <button
          type="button"
          data-stuck-more
          onClick={() => setAll(true)}
          className="self-start rounded-lg px-2 py-0.5 font-sans text-[12px] text-content/55 hover:bg-content/6 hover:text-content"
        >
          {more} more
        </button>
      ) : null}
    </div>
  );
  if (!heading) return list;
  return (
    <section aria-label={heading} data-hub-stuck>
      <h2 className="mb-1 text-xs text-content/60">{heading}</h2>
      {list}
    </section>
  );
}

export function StuckWorkerCard({
  stuck,
  now,
  variant,
  where,
  lead: leadGiven,
  onDone,
  onOpened,
}: {
  stuck: StuckWorker;
  now: number;
  variant: "chat" | "row";
  where?: string;
  /** The Lead's name, when the caller knows it better than the worker's Mono (else `leadNameOf`). */
  lead?: string;
  onDone?: (said: string) => void;
  onOpened?: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const prompt = liveQuestion(stuck);
  // Each option its own button, the suggested one first and marked, so picking is one tap (Critiquito, 21 Oct): the live
  // question's options when this window holds it, else the ones its row stores.
  const live = questionOptions(prompt);
  const options = live.length ? live : storedOptions(stuck);
  const answer = (id: string) => (live.length ? answerWithOption(stuck, id) : answerWithStoredOption(stuck, id));
  const pick = suggestion(prompt, stuck);
  // What its Lead last did about it, so Ash sees someone acted ("Hivra lead retried it at 2h").
  const lead = leadGiven || leadNameOf(stuck);
  const acted = stuck.kind === "asking" ? undefined : leadActionLine(stuck.row, lead);
  const run = async (call: () => StuckResult | Promise<StuckResult>) => {
    setBusy(true);
    setProblem(null);
    const result = await call();
    setBusy(false);
    if (!result.ok) return setProblem(result.reason);
    setText("");
    onDone?.(result.said);
  };
  const send = () => text.trim() && !busy && void run(() => sendWords(stuck, text));
  const frame =
    variant === "chat"
      ? // r65 (Critiquito crit-2): pinned over the chat, so it is near-opaque with a blur behind it; chat text never
        // shows through.
        "flex flex-col gap-1 rounded-2xl border border-content/10 bg-background-base/95 px-4 py-3 font-sans text-[13px] shadow-lg backdrop-blur-xl"
      : "flex flex-col gap-1 rounded-md px-2 py-2 hover:bg-content/5";
  const placeholder =
    stuck.kind === "asking" ? "Or answer in your words…" : stuck.kind === "stalled" ? "Tell it what to do…" : "Reply in its chat…";
  // r30, the red rule: one chip (Needs you only when Ash must act, else Retrying or With <Lead>), never "stuck" or
  // "failed", and one plain line, never the raw fault or a file path.
  const chip = stuckWorkerChip(stuck, lead);
  const red = chip.tone === "red";
  const plain = plainStuckLine(stuck);
  const line = options.length ? questionWithoutOptions(plain) : plain;
  const open = () => {
    openStuck(stuck);
    onOpened?.();
  };
  return (
    <div
      className={frame}
      data-stuck-worker={stuck.row.childSession}
      data-stuck-kind={stuck.kind}
      data-stuck-escalated={stuck.escalated || undefined}
      // r70b (Critiquito): a card only Ash can unstick reads like a red row (r69): neutral background, the 2px red left
      // bar and the red Needs you word; never a red card. The pinned card keeps its drop shadow under the bar.
      {...redRowProps(red, variant === "chat" ? CARD_SHADOW : undefined)}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-content/60">
        {stuck.kind === "asking" ? <StuckMark kind={stuck.kind} /> : null}
        <span className="min-w-0 truncate" data-stuck-where>
          {[where, stuckTitle(stuck)].filter(Boolean).join(" · ")}
        </span>
        {stuck.kind === "asking" ? <span className="shrink-0">· {stuckWord(stuck)}</span> : <span className="flex shrink-0 items-center gap-1.5" data-stuck-chip={chip.word}>· <ChipMark chip={chip} /></span>}
        <span className="ml-auto shrink-0 tabular-nums" data-stuck-ago>
          {ago(stuckMinutes(stuck, now))}
        </span>
      </div>
      <div className="whitespace-normal break-words text-[13px] leading-5 text-content" data-stuck-line>
        {line}
      </div>
      {/* A red Needs you: the reason, then "Open <Lead>'s chat" on its own line (r27b, r28). */}
      {red ? <NeedsYouLinkLine name={lead} onOpen={open} /> : null}
      {acted ? (
        <div className="whitespace-normal break-words text-[12px] leading-5 text-content/60" data-stuck-lead-action>
          {acted}
        </div>
      ) : stuck.kind === "failed" && !red ? (
        <div className="whitespace-normal break-words text-[12px] leading-5 text-content/60" data-stuck-next>
          {failedNextStep(lead)}
        </div>
      ) : null}
      {stuck.kind === "asking" && pick && !options.length ? (
        <div className="whitespace-normal break-words text-[13px] leading-5 text-content/60" data-stuck-pick>
          Suggests: {pick}
        </div>
      ) : null}
      {/* One row of one-tap actions: its options (or its pick), Open chat, and Dismiss for a failure. */}
      <div className="mt-1 flex flex-wrap items-center gap-2" data-stuck-actions>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={busy}
            className={option.recommended ? PRIMARY : BTN}
            data-stuck-option={option.id}
            data-stuck-suggested={option.recommended || undefined}
            aria-label={option.recommended ? `${option.label} (suggested)` : option.label}
            onClick={() => void run(() => answer(option.id))}
          >
            <span data-stuck-option-label>{option.label}</span>
            {option.recommended ? <span className="ml-1.5 font-normal opacity-60">Suggested</span> : null}
          </button>
        ))}
        {!options.length && pick ? (
          <button type="button" disabled={busy} className={PRIMARY} data-stuck-take-pick onClick={() => void run(() => takeSuggestion(stuck))}>
            Take the pick
          </button>
        ) : null}
        {/* Critiquito, Ash's call (r51): no "Open <Lead>'s chat" on a grey card; a red one has it under its reason. */}
        {stuck.kind === "failed" ? (
          <SecondaryButton data-stuck-dismiss onClick={() => dismissFailure(stuck)}>
            Dismiss
          </SecondaryButton>
        ) : null}
      </div>
      {/* Then Ash's own words, full width: a field that reads as a field, Send, and a quieter Stop set apart. */}
      {stuck.kind === "failed" ? null : (
        <div className="mt-1 flex min-w-0 items-center gap-2" data-stuck-reply-row>
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) send();
            }}
            placeholder={placeholder}
            aria-label={`${stuck.kind === "asking" ? "Answer" : "Tell"} ${stuckTitle(stuck)} in your words`}
            maxLength={4000}
            data-stuck-reply
            className="min-w-0 flex-1 rounded-md border border-content/12 bg-transparent px-2.5 py-1 text-[13px] text-content outline-none placeholder:text-content/45 focus:border-content/30"
          />
          <button type="button" className={BTN} disabled={busy || !text.trim()} data-stuck-send onClick={send}>
            {busy ? "Sending…" : "Send"}
          </button>
          <button type="button" className={`ml-1 ${QUIET}`} disabled={busy} data-stuck-stop onClick={() => void run(() => stopStuck(stuck))}>
            Stop
          </button>
        </div>
      )}
      {problem ? (
        <div className="text-[13px] text-content/60" data-stuck-problem>
          {problem}
        </div>
      ) : null}
    </div>
  );
}

function DoneRow({ done, variant }: { done: Done; variant: "chat" | "row" }) {
  return (
    <div
      className={`flex items-center gap-3 ${variant === "chat" ? "rounded-2xl border border-content/10 px-4 py-2 font-sans" : "rounded-md px-2 py-2"}`}
      data-stuck-done={done.stuck.row.childSession}
    >
      <span className="grid size-5 shrink-0 place-items-center text-content/60" role="img" aria-label="Done">
        <Check className="size-3.5" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1 text-[13px] leading-5 text-content/60">
        <span className="text-content/85">{stuckTitle(done.stuck)}</span>: {done.said}
      </div>
    </div>
  );
}
