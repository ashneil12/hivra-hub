// WP-23: a council on screen. One column per seat, the round, the stance bar with its two-thirds line, and the minority
// report. The rules live in protocol.ts; this view only asks the person and shows what the code decided.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CouncilPersona } from "../model/personas";
import {
  memberLabel,
  proposePanel,
  seatPanel,
  type CouncilEngine,
  type PanelPreset,
  type Tally,
} from "../model/protocol";
import type { CouncilRecord, CouncilSeatRecord } from "../model/record";
import { blankProposal, carriedPast } from "../model/record";
import { runCouncil, type CouncilModel, type CouncilRun } from "../model/run";
import { CouncilSwitch } from "./CouncilSwitch";

const PRESETS: { id: PanelPreset; label: string }[] = [
  { id: "quick", label: "Quick" },
  { id: "triad", label: "Triad" },
  { id: "full", label: "Full" },
];

const ROUND_LABEL: Record<string, string> = {
  propose: "Propose a panel",
  restate: "Restate the question",
  blind: "Blind answers",
  cross: "Cross-examination",
  stance: "Final positions",
  verdict: "Verdict",
  done: "Done",
  stopped: "Stopped",
};

export function CouncilView({
  roomId,
  record,
  engines,
  personas,
  model,
  onChange,
  onOpenSeat,
  onDelegate,
  onClose,
  asMode = false,
  seatNames,
}: {
  roomId: string;
  record: CouncilRecord;
  engines: readonly CouncilEngine[];
  personas: readonly CouncilPersona[];
  model?: CouncilModel;
  /** False when this write lost the race. The view stops rather than overwriting the other window. */
  onChange: (next: CouncilRecord) => boolean;
  onOpenSeat?: (seat: CouncilSeatRecord) => void;
  onDelegate?: () => void;
  onClose?: () => void;
  /**
   * Dropwave: the council as a mode of the team's chat. No header of its own, a switch under the box turns it off, the
   * panel's size and seats sit behind "Set up", and a question is asked as soon as it is sent.
   */
  asMode?: boolean;
  /** The team's members by name, in seat order: in the mode a seat speaks under its member's name. */
  seatNames?: readonly string[];
}) {
  const [question, setQuestion] = useState(record.question);
  const [preset, setPreset] = useState<PanelPreset>(record.preset);
  const [picked, setPicked] = useState<Record<number, string>>({});
  const [saveProblem, setSaveProblem] = useState<string | undefined>();
  const [tableOpen, setTableOpen] = useState(false);
  const live = useRef(false);
  const gen = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    gen.current += 1;
    abortRef.current?.abort();
  }, []);

  // Another window's save replaces this one. The question on screen follows the row that won.
  useEffect(() => {
    // Once it has decided, the box is for the next question.
    setQuestion(record.phase === "done" ? "" : record.question);
    setPreset(record.preset);
  }, [record.revision, record.question, record.preset, record.phase]);

  const proposal = proposePanel(engines, preset);
  const weights = new Map(personas.flatMap((persona) => (typeof persona.weight === "number" ? [[persona.id, persona.weight] as const] : [])));
  const round = record.phase === "done" ? "done" : record.phase === "stopped" ? "stopped" : (record.round ?? record.phase);
  const interrupted = record.phase === "running" && !live.current;
  const canAsk = proposal.seats.length > 0 && !!question.trim() && !!model;

  function lostSave() {
    live.current = false;
    setSaveProblem("This council was saved in another window. Start again.");
  }

  function confirmPanel() {
    const seats = seatPanel(
      proposal.seats.map((seat, index) => ({ ...seat, ...(picked[index] ? { personaId: picked[index] } : {}) })),
      weights,
      roomId,
    );
    // A new question after a decision starts a fresh council; the decision joins the history above it.
    const from: CouncilRecord =
      record.phase === "done" ? { ...blankProposal(""), ...(carriedPast(record).length ? { past: carriedPast(record) } : {}) } : record;
    const next: CouncilRecord = {
      ...from,
      question: question.trim(),
      preset,
      expectedCalls: proposal.expectedCalls,
      ...(proposal.note ? { note: proposal.note } : {}),
      seats,
      phase: "restate",
    };
    // As a chat mode a sent question is asked, like any message: there is no second "confirm the question" step.
    if (asMode) return void start(next);
    if (!onChange(next)) lostSave();
  }

  async function start(from: CouncilRecord = record) {
    if (!model) return;
    const ac = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ac;
    const generation = ++gen.current;
    live.current = true;
    const base: CouncilRecord = { ...from, question: question.trim(), phase: "running", round: "blind" };
    if (!onChange(base)) {
      lostSave();
      return;
    }
    const personaText = new Map(
      personas.map((persona) => [persona.id, { id: persona.id, name: persona.name, text: persona.body, ...(persona.method ? { method: persona.method } : {}) }]),
    );
    const result = await runCouncil({
      question: base.question,
      seats: base.seats,
      personas: personaText,
      model,
      signal: ac.signal,
      isCurrent: () => gen.current === generation,
      onProgress: (partial) => {
        if (gen.current !== generation) return;
        // A progress note still has the run's starting phase. Keep the room on "running" until the run returns.
        if (!onChange(merge(base, partial, "running"))) {
          gen.current += 1;
          ac.abort();
          lostSave();
        }
      },
    });
    if (gen.current !== generation) return;
    if (!onChange(merge(base, result))) lostSave();
  }

  function again() {
    live.current = false;
    setSaveProblem(undefined);
    // A stopped or interrupted council asks the same question again. What was decided before stays in the thread.
    onChange({ ...blankProposal(record.question), preset: record.preset, ...(past.length ? { past: [...past] } : {}) });
  }

  const past = record.past ?? [];
  // In the mode a seat is a team member: the words the council wrote say the member's name, not "Member C".
  const named = (text: string) =>
    asMode && seatNames?.length
      ? record.seats.reduce((out, seat, index) => (seatNames[index] ? out.split(seat.member).join(seatNames[index]!) : out), text)
      : text;
  // The box at the bottom asks: the first question, or the next one once this council has decided.
  const asking = record.phase === "propose" || record.phase === "done";
  const answered = record.seats.length > 0 && (record.phase === "running" || record.phase === "done") && !interrupted;

  // Like a chat, the newest thing is in view.
  const threadEnd = useRef<HTMLDivElement>(null);
  const shownCount = past.length + record.blind.length + record.cross.length + record.stances.length;
  useEffect(() => {
    threadEnd.current?.scrollIntoView?.({ block: "end" });
  }, [shownCount, record.phase]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col text-[13px] leading-5 text-content"
      data-council-round={round}
      data-council-outcome={record.phase === "done" && record.tally ? (record.tally.consensus ? "consensus" : "no-consensus") : undefined}
    >
      {asMode ? null : (
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-stroke px-6 xl:px-8">
        <h2 className="text-[14px] font-medium">Council</h2>
        <span className="text-content/60">{ROUND_LABEL[round] ?? round}</span>
        {past.length ? <span className="text-content/50" data-council-past-count>{past.length} earlier {past.length === 1 ? "decision" : "decisions"}</span> : null}
        {onClose ? (
          <button type="button" onClick={onClose} className="ml-auto rounded-md px-2 py-1 text-content/60 hover:bg-content/5 hover:text-content" data-council-close>
            Back to the chat
          </button>
        ) : null}
      </div>
      )}

      {/* Dropwave (Ash, 11 Nov: "make it like a chat"): one thread. You ask on the right, the seats and the decision
          answer on the left, and every earlier decision stays above. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={asMode ? "flex w-full flex-col gap-4 px-6 py-6 xl:px-8" : "mx-auto flex w-full max-w-[820px] flex-col gap-4 px-6 py-6"} data-council-thread>
          {!past.length && record.phase === "propose" ? (
            <div className="flex flex-col items-center gap-1 py-10 text-center" data-council-empty>
              <div className="text-[15px] font-medium">{asMode ? "Council mode is on" : "Ask the council"}</div>
              <p className="max-w-[52ch] text-content/60">
                {asMode
                  ? "Ask the team a question. Each of them answers on their own, they challenge each other, then they vote. You get one decision, who disagreed, and a next step. Turn the switch off to chat as usual."
                  : "A few different models answer on their own, challenge each other, then vote. You get one decision, who disagreed, and a next step you can hand to a first mate."}
              </p>
            </div>
          ) : null}

          {past.map((item, index) => (
            <div key={index} className="flex flex-col gap-2" data-council-past>
              <Asked text={item.question} />
              <Bubble who="Council">
                <p className="font-medium">{item.consensus && item.winner ? `Decided: ${item.winner}` : "No consensus"}</p>
                {item.nextStep ? <p><span className="text-content/60">Next step. </span>{item.nextStep}</p> : null}
                {item.minority ? <p className="text-content/60">{item.minority}</p> : null}
              </Bubble>
            </div>
          ))}

          {record.phase !== "propose" && record.question ? <Asked text={record.question} /> : null}

          {saveProblem ? (
            <Bubble who="Council">
              <div role="alert" className="flex flex-col gap-2" data-council-save-error>
                <p>{saveProblem}</p>
                <button type="button" data-council-start-again onClick={again} className={softBtn}>
                  Start again
                </button>
              </div>
            </Bubble>
          ) : null}

          {record.phase === "restate" ? (
            <Bubble who="Council">
              <p className="text-content/70">Confirm the question, or correct it. Nothing is asked until you do.</p>
              <textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                rows={3}
                data-council-restate
                className="rounded-md border border-stroke bg-transparent px-2 py-1 text-content"
              />
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  data-council-restate-confirm
                  disabled={!question.trim() || !model || !record.seats.length}
                  onClick={() => void start()}
                  className={`${softBtn} disabled:opacity-40`}
                >
                  Confirm the question
                </button>
                <span className="text-content/60" data-council-calls>
                  {record.expectedCalls} {record.expectedCalls === 1 ? "call" : "calls"}
                </span>
              </div>
            </Bubble>
          ) : null}

          {interrupted ? (
            <Bubble who="Council">
              <div className="flex flex-col gap-2" data-council-interrupted>
                <p>This council was interrupted. Start it again.</p>
                <button type="button" onClick={again} className={softBtn}>
                  Start again
                </button>
              </div>
            </Bubble>
          ) : null}

          {record.phase === "stopped" ? (
            <Bubble who="Council">
              <p>The council was stopped.</p>
              <button type="button" onClick={again} className={softBtn}>
                Start again
              </button>
            </Bubble>
          ) : null}

          {answered ? (
            <div className="flex flex-col gap-3" data-council-tabs>
              {record.seats.map((seat, index) => (
                <SeatMessage
                  key={seat.id}
                  seat={seat}
                  record={record}
                  name={asMode ? seatNames?.[index] : undefined}
                  plain={asMode}
                  onOpen={onOpenSeat ? () => onOpenSeat(seat) : undefined}
                />
              ))}
            </div>
          ) : null}

          {record.phase === "done" && record.tally && record.verdict ? (
            <Bubble who="Council" strong>
              <p className="text-[14px] font-medium" data-council-winner>
                {record.tally.consensus ? `${asMode ? "The team" : "The council"} agreed on ${record.tally.winner}.` : "No consensus."}
              </p>
              <StanceBar tally={record.tally} />
              <div data-council-minority className="rounded-md bg-content/10 px-3 py-2 whitespace-pre-wrap">
                {named(record.verdict.minority)}
              </div>
              <div data-council-verdict className="flex flex-col gap-1">
                <p><span className="text-content/60">Unresolved. </span>{record.verdict.unresolved}</p>
                <p><span className="text-content/60">Kill criteria. </span>{record.verdict.killCriteria}</p>
                <p><span className="text-content/60">Next step. </span>{record.verdict.nextStep}</p>
              </div>
              {record.chairmanDifferent === false ? <p className="text-content/60">Every seat is the same provider, so the chair is not a different one.</p> : null}
              <p className={asMode ? "hidden" : "text-content/60"} data-council-meta>
                {record.meta.seats} {record.meta.seats === 1 ? "seat" : "seats"} · {record.meta.rounds} {record.meta.rounds === 1 ? "round" : "rounds"} · {record.meta.calls} {record.meta.calls === 1 ? "call" : "calls"}
                {record.meta.tokensComplete && record.meta.tokens !== undefined ? ` · ${record.meta.tokens} tokens` : ""}
              </p>
              <button type="button" data-council-delegate onClick={onDelegate} className={softBtn}>
                Give this to the first mate: {record.verdict.nextStep}
              </button>
            </Bubble>
          ) : null}
          <div ref={threadEnd} />
        </div>
      </div>

      {asMode ? (
        // The mode's footer sits where the team chat's own box and switch sit, so turning the mode on and off moves nothing.
        <div className="w-full shrink-0 px-6 pb-3 xl:px-8">
          {asking ? (
            <div className="flex items-end gap-2 rounded-lg bg-surface py-1.5 pr-1.5 pl-3 ring-1 ring-surface-ring" data-council-ask>
              <textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  if (canAsk) confirmPanel();
                }}
                rows={1}
                placeholder={record.phase === "done" ? "Ask the team another question…" : "Ask the team a question…"}
                aria-label="Question for the council"
                data-council-question
                className="min-h-7 w-full resize-none self-center bg-transparent text-[13px] leading-5 text-content outline-none placeholder:text-content/40"
              />
              <button
                type="button"
                data-council-confirm
                disabled={!canAsk}
                onClick={confirmPanel}
                className="h-7 shrink-0 rounded-md bg-content/12 px-2.5 text-[12px] text-content hover:bg-content/18 disabled:opacity-40"
              >
                Ask the team
              </button>
            </div>
          ) : null}
          {asking && !model ? <p className="px-1 pt-1.5 text-[12px] text-content/70">No model is connected, so the team can't answer as a council yet.</p> : null}
          <div className="flex items-center gap-3 px-1 pt-2">
            <div className="min-w-0 flex-1">{onClose ? <CouncilSwitch on onChange={() => onClose()} /> : null}</div>
            {asking ? (
              <button
                type="button"
                aria-expanded={tableOpen}
                data-council-table-toggle
                onClick={() => setTableOpen((open) => !open)}
                className={`h-6 shrink-0 rounded-md px-2 text-[12px] hover:bg-content/5 hover:text-content ${tableOpen ? "bg-content/8 text-content" : "text-content/60"}`}
              >
                Set up
              </button>
            ) : null}
          </div>
          {asking && tableOpen ? (
            <div className="mt-2 flex flex-col gap-2 rounded-lg border border-content/10 p-3" data-council-setup>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-content/50">How many answer</span>
                {PRESETS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    data-council-preset={item.id}
                    aria-pressed={preset === item.id}
                    onClick={() => setPreset(item.id)}
                    className={`h-7 rounded-full px-3 text-[12px] font-medium ${preset === item.id ? "bg-content text-background-base" : "text-content/55 hover:bg-content/8 hover:text-content"}`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              {proposal.note ? <p className="text-[12px] text-content/70">{proposal.note}</p> : null}
              <ul className="flex flex-col gap-2">
                {proposal.seats.map((seat, index) => (
                  <li key={`${seat.cli}-${seat.family}`} className="flex items-center gap-2" data-council-seat={seat.cli}>
                    <span className="w-28 truncate text-content/80">{seatNames?.[index] ?? memberLabel(index)}</span>
                    <span className="min-w-0 flex-1 truncate text-content/50">{seat.label}</span>
                    <select
                      aria-label={`Persona for ${seat.label}`}
                      value={picked[index] ?? ""}
                      onChange={(e) => setPicked((cur) => ({ ...cur, [index]: e.target.value }))}
                      className="h-7 rounded-md border border-stroke bg-transparent px-1"
                    >
                      <option value="">Answers as itself</option>
                      {personas.map((persona) => (
                        <option key={persona.id} value={persona.id}>
                          {persona.name}
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : asking ? (
        <div className="shrink-0 px-6 pb-4 xl:px-8">
          <div className="mx-auto flex w-full max-w-[820px] flex-col gap-2 rounded-2xl bg-surface p-3 ring-1 ring-surface-ring" data-council-ask>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
                e.preventDefault();
                if (canAsk) confirmPanel();
              }}
              rows={2}
              placeholder={record.phase === "done" ? "Ask the council another question…" : "Ask the council a question…"}
              aria-label="Question for the council"
              data-council-question
              className="w-full resize-none bg-transparent px-1 text-[14px] leading-6 text-content outline-none placeholder:text-content/40"
            />
            <div className="flex flex-wrap items-center gap-2">
              {PRESETS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-council-preset={item.id}
                  aria-pressed={preset === item.id}
                  onClick={() => setPreset(item.id)}
                  className={`h-7 rounded-md px-2 text-[12px] ${preset === item.id ? "bg-content/12 text-content" : "text-content/60 hover:bg-content/5 hover:text-content"}`}
                >
                  {item.label}
                </button>
              ))}
              <button
                type="button"
                aria-expanded={tableOpen}
                data-council-table-toggle
                onClick={() => setTableOpen((open) => !open)}
                className="h-7 rounded-md px-2 text-[12px] text-content/60 hover:bg-content/5 hover:text-content"
              >
                {proposal.seats.length} {proposal.seats.length === 1 ? "seat" : "seats"} at the table
              </button>
              <span className="text-[12px] text-content/50" data-council-calls>
                {proposal.expectedCalls} {proposal.expectedCalls === 1 ? "call" : "calls"}
              </span>
              <button
                type="button"
                data-council-confirm
                disabled={!canAsk}
                onClick={confirmPanel}
                className="ml-auto h-8 rounded-md bg-content/12 px-3 text-content hover:bg-content/18 disabled:opacity-40"
              >
                Ask the council
              </button>
            </div>
            {proposal.note ? <p className="px-1 text-[12px] text-content/70">{proposal.note}</p> : null}
            {!model ? <p className="px-1 text-[12px] text-content/70">No model is connected, so this council can't start.</p> : null}
            {tableOpen ? (
              <ul className="flex flex-col gap-2 border-t border-stroke px-1 pt-2">
                {proposal.seats.map((seat, index) => (
                  <li key={`${seat.cli}-${seat.family}`} className="flex items-center gap-2" data-council-seat={seat.cli}>
                    <span className="w-16 text-content/60">{memberLabel(index)}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {seat.label}
                      <span className="text-content/60"> · {seat.cli} · {seat.family}{seat.model ? ` · ${seat.model}` : ""}</span>
                    </span>
                    <select
                      aria-label={`Persona for ${seat.label}`}
                      value={picked[index] ?? ""}
                      onChange={(e) => setPicked((cur) => ({ ...cur, [index]: e.target.value }))}
                      className="h-7 rounded-md border border-stroke bg-transparent px-1"
                    >
                      <option value="">No persona</option>
                      {personas.map((persona) => (
                        <option key={persona.id} value={persona.id}>
                          {persona.name}
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

const softBtn = "h-8 w-fit rounded-md bg-content/10 px-3 hover:bg-content/15";

/** What you asked, on the right like any message of yours. */
function Asked({ text }: { text: string }) {
  return (
    <div className="flex justify-end" data-council-asked>
      <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-content/10 px-3.5 py-2 text-[14px] leading-6">{text}</div>
    </div>
  );
}

/** An answer on the left: a name on top, the words under it. */
function Bubble({ who, strong, children }: { who: string; strong?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="w-fit rounded-full bg-content/8 px-2.5 py-0.5 text-[12px] font-medium text-content/80">{who}</span>
      <div className={`flex flex-col gap-2 ${strong ? "rounded-xl bg-surface p-4 ring-1 ring-surface-ring" : ""}`}>{children}</div>
    </div>
  );
}

/** One seat's latest words as a message. Its name opens that seat's own chat. */
function SeatMessage({
  seat,
  record,
  name,
  plain = false,
  onOpen,
}: {
  seat: CouncilSeatRecord;
  record: CouncilRecord;
  /** The team member in this seat (council mode): the message is under their name. */
  name?: string;
  /** Leaves out which model and CLI the seat runs on. */
  plain?: boolean;
  onOpen?: () => void;
}) {
  const blind = record.blind.find((answer) => answer.seatId === seat.id);
  const cross = record.cross.find((answer) => answer.seatId === seat.id);
  const stance = record.stances.find((item) => item.seatId === seat.id);
  const text = stance
    ? plain
      ? `${stance.option.charAt(0).toUpperCase()}${stance.option.slice(1)}. ${stance.reason}`
      : `${stance.option} (${stance.confidence}). ${stance.reason}`
    : (cross?.text ?? blind?.text ?? "");
  const waiting = !text && !record.skipped.includes(seat.id) && record.phase === "running";
  return (
    <section className="flex min-w-0 flex-col gap-1" data-council-seat={seat.id}>
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          data-council-tab={seat.sessionId}
          title={onOpen ? `Open ${seat.member}'s own chat` : undefined}
          onClick={onOpen}
          className="w-fit shrink-0 rounded-full bg-content/8 px-2.5 py-0.5 text-[12px] font-medium text-content/80 hover:bg-content/12 hover:text-content"
        >
          {name ?? seat.member}
        </button>
        <span className={plain ? "hidden" : "min-w-0 truncate text-[12px] text-content/50"}>
          {seat.label} · {seat.cli}{seat.model ? ` · ${seat.model}` : ` · ${seat.family}`}
        </span>
        {record.retried.includes(seat.id) ? <span className="shrink-0 text-[12px] text-content/60">Asked again</span> : null}
      </div>
      <p className="whitespace-pre-wrap">{text || (record.skipped.includes(seat.id) ? "No reply" : waiting ? <span className="text-content/50">Thinking…</span> : "")}</p>
    </section>
  );
}

function StanceBar({ tally }: { tally: Tally }) {
  return (
    <div className="relative h-8" data-council-stance-bar>
      <div className="flex h-full overflow-hidden rounded-md bg-content/5">
        {tally.options.map((option) => (
          <div key={option.option} className="flex items-center justify-center overflow-hidden text-[11px]" style={{ width: `${Math.max(option.share * 100, 0)}%` }}>
            {option.option} {option.weight}
          </div>
        ))}
      </div>
      <div data-council-two-thirds className="absolute top-0 h-full border-l border-content" style={{ left: "66.67%" }} title="Two thirds" />
    </div>
  );
}

function merge(base: CouncilRecord, run: CouncilRun, phase?: CouncilRecord["phase"]): CouncilRecord {
  return {
    ...base,
    phase: phase ?? run.phase,
    ...(run.round ? { round: run.round } : {}),
    blind: run.blind,
    cross: run.cross,
    stances: run.stances,
    retried: run.retried,
    skipped: run.skipped,
    ...(run.tally ? { tally: run.tally } : {}),
    ...(run.verdict ? { verdict: run.verdict } : {}),
    ...(run.chairmanId ? { chairmanId: run.chairmanId } : {}),
    ...(run.chairmanDifferent !== undefined ? { chairmanDifferent: run.chairmanDifferent } : {}),
    meta: {
      seats: base.seats.length,
      rounds: run.rounds,
      calls: run.calls,
      tokensComplete: run.tokensComplete,
      ...(run.tokens !== undefined ? { tokens: run.tokens } : {}),
    },
  };
}
