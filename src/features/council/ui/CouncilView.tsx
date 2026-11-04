// WP-23: a council on screen. One column per seat, the round, the stance bar with its two-thirds line, and the minority
// report. The rules live in protocol.ts; this view only asks the person and shows what the code decided.
import { useEffect, useRef, useState } from "react";
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
import { blankProposal } from "../model/record";
import { runCouncil, type CouncilModel, type CouncilRun } from "../model/run";

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
}) {
  const [question, setQuestion] = useState(record.question);
  const [preset, setPreset] = useState<PanelPreset>(record.preset);
  const [picked, setPicked] = useState<Record<number, string>>({});
  const [active, setActive] = useState(0);
  const [saveProblem, setSaveProblem] = useState<string | undefined>();
  const live = useRef(false);
  const gen = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    gen.current += 1;
    abortRef.current?.abort();
  }, []);

  // Another window's save replaces this one. The question on screen follows the row that won.
  useEffect(() => {
    setQuestion(record.question);
    setPreset(record.preset);
  }, [record.revision, record.question, record.preset]);

  const proposal = proposePanel(engines, preset);
  const weights = new Map(personas.flatMap((persona) => (typeof persona.weight === "number" ? [[persona.id, persona.weight] as const] : [])));
  const round = record.phase === "done" ? "done" : record.phase === "stopped" ? "stopped" : (record.round ?? record.phase);
  const interrupted = record.phase === "running" && !live.current;

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
    if (
      !onChange({
        ...record,
        question: question.trim(),
        preset,
        expectedCalls: proposal.expectedCalls,
        ...(proposal.note ? { note: proposal.note } : {}),
        seats,
        phase: "restate",
      })
    ) {
      lostSave();
    }
  }

  async function start() {
    if (!model) return;
    const ac = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ac;
    const generation = ++gen.current;
    live.current = true;
    const base: CouncilRecord = { ...record, question: question.trim(), phase: "running", round: "blind" };
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
    onChange({ ...blankProposal(record.question), preset: record.preset });
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-6 text-[13px] leading-5 text-content"
      data-council-round={round}
      data-council-outcome={record.phase === "done" && record.tally ? (record.tally.consensus ? "consensus" : "no-consensus") : undefined}
    >
      <div className="flex items-center gap-3">
        <h2 className="text-[15px] font-medium">Council</h2>
        <span className="text-content/60">{ROUND_LABEL[round] ?? round}</span>
        {onClose ? (
          <button type="button" onClick={onClose} className="ml-auto text-content/60 hover:text-content" data-council-close>
            Back to the chat
          </button>
        ) : null}
      </div>

      {saveProblem ? (
        <div role="alert" className="flex flex-col gap-2" data-council-save-error>
          <p>{saveProblem}</p>
          <button type="button" data-council-start-again onClick={again} className="h-8 w-fit rounded-md bg-content/10 px-3">
            Start again
          </button>
        </div>
      ) : null}

      {record.phase === "propose" ? (
        <div className="flex max-w-[72ch] flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-content/60">The question</span>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={3}
              data-council-question
              className="rounded-md border border-stroke bg-transparent px-2 py-1 text-content"
            />
          </label>
          <div className="flex gap-2">
            {PRESETS.map((item) => (
              <button
                key={item.id}
                type="button"
                data-council-preset={item.id}
                aria-pressed={preset === item.id}
                onClick={() => setPreset(item.id)}
                className={`h-7 rounded-md border px-2 ${preset === item.id ? "border-content bg-content/10" : "border-stroke"}`}
              >
                {item.label}
              </button>
            ))}
            <span className="self-center text-content/60" data-council-calls>
              {proposal.expectedCalls} {proposal.expectedCalls === 1 ? "call" : "calls"}
            </span>
          </div>
          {proposal.note ? <p className="text-content/70">{proposal.note}</p> : null}
          {!model ? <p className="text-content/70">No model is connected, so this council can't start.</p> : null}
          <ul className="flex flex-col gap-2">
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
          <button
            type="button"
            data-council-confirm
            disabled={!proposal.seats.length || !question.trim() || !model}
            onClick={confirmPanel}
            className="h-8 w-fit rounded-md bg-content/10 px-3 disabled:opacity-40"
          >
            Start the council
          </button>
        </div>
      ) : null}

      {record.phase === "restate" ? (
        <div className="flex max-w-[72ch] flex-col gap-3">
          <p className="text-content/70">Confirm the question, or correct it. Nothing is asked until you do.</p>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={3}
            data-council-restate
            className="rounded-md border border-stroke bg-transparent px-2 py-1 text-content"
          />
          <p className="text-content/60" data-council-calls>
            {record.expectedCalls} {record.expectedCalls === 1 ? "call" : "calls"}
          </p>
          <button
            type="button"
            data-council-restate-confirm
            disabled={!question.trim() || !model || !record.seats.length}
            onClick={() => void start()}
            className="h-8 w-fit rounded-md bg-content/10 px-3 disabled:opacity-40"
          >
            Confirm the question
          </button>
        </div>
      ) : null}

      {interrupted ? (
        <div className="flex flex-col gap-2" data-council-interrupted>
          <p>This council was interrupted. Start it again.</p>
          <button type="button" onClick={again} className="h-8 w-fit rounded-md bg-content/10 px-3">
            Start again
          </button>
        </div>
      ) : null}

      {record.phase === "stopped" ? (
        <div className="flex flex-col gap-2">
          <p>The council was stopped.</p>
          <button type="button" onClick={again} className="h-8 w-fit rounded-md bg-content/10 px-3">
            Start again
          </button>
        </div>
      ) : null}

      {record.seats.length && (record.phase === "running" || record.phase === "done") && !interrupted ? (
        <>
          <div role="tablist" className="flex gap-1" data-council-tabs>
            {record.seats.map((seat, index) => (
              <button
                key={seat.sessionId}
                type="button"
                role="tab"
                aria-selected={active === index}
                data-council-tab={seat.sessionId}
                onClick={() => {
                  setActive(index);
                  onOpenSeat?.(seat);
                }}
                className={`h-7 rounded-md px-2 ${active === index ? "bg-content/10" : "text-content/70"}`}
              >
                {seat.member}
              </button>
            ))}
          </div>
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${record.seats.length}, minmax(0, 1fr))` }}>
            {record.seats.map((seat) => (
              <SeatColumn key={seat.id} seat={seat} record={record} />
            ))}
          </div>
        </>
      ) : null}

      {record.phase === "done" && record.tally && record.verdict ? (
        <div className="flex max-w-[80ch] flex-col gap-3">
          <p className="font-medium" data-council-winner>
            {record.tally.consensus ? `The council agreed on ${record.tally.winner}.` : "No consensus."}
          </p>
          <StanceBar tally={record.tally} />
          <div data-council-minority className="rounded-md bg-content/10 px-3 py-2 whitespace-pre-wrap">
            {record.verdict.minority}
          </div>
          <div data-council-verdict className="flex flex-col gap-1">
            <p><span className="text-content/60">Unresolved. </span>{record.verdict.unresolved}</p>
            <p><span className="text-content/60">Kill criteria. </span>{record.verdict.killCriteria}</p>
            <p><span className="text-content/60">Next step. </span>{record.verdict.nextStep}</p>
          </div>
          {record.chairmanDifferent === false ? <p className="text-content/60">Every seat is the same provider, so the chair is not a different one.</p> : null}
          <p className="text-content/60" data-council-meta>
            {record.meta.seats} {record.meta.seats === 1 ? "seat" : "seats"} · {record.meta.rounds} {record.meta.rounds === 1 ? "round" : "rounds"} · {record.meta.calls} {record.meta.calls === 1 ? "call" : "calls"}
            {record.meta.tokensComplete && record.meta.tokens !== undefined ? ` · ${record.meta.tokens} tokens` : ""}
          </p>
          <button type="button" data-council-delegate onClick={onDelegate} className="h-8 w-fit rounded-md bg-content/10 px-3">
            Give this to the first mate: {record.verdict.nextStep}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SeatColumn({ seat, record }: { seat: CouncilSeatRecord; record: CouncilRecord }) {
  const blind = record.blind.find((answer) => answer.seatId === seat.id);
  const cross = record.cross.find((answer) => answer.seatId === seat.id);
  const stance = record.stances.find((item) => item.seatId === seat.id);
  const text = stance ? `${stance.option} (${stance.confidence}). ${stance.reason}` : (cross?.text ?? blind?.text ?? "");
  return (
    <section className="flex min-w-0 flex-col gap-1 rounded-md border border-stroke p-2" data-council-seat={seat.id}>
      <h3 className="truncate font-medium">{seat.member}</h3>
      <p className="truncate text-[12px] text-content/60">
        {seat.label} · {seat.cli}{seat.model ? ` · ${seat.model}` : ` · ${seat.family}`}
      </p>
      {record.retried.includes(seat.id) ? <p className="text-[12px] text-content/60">Asked again</p> : null}
      <p className="whitespace-pre-wrap">{text || (record.skipped.includes(seat.id) ? "No reply" : "")}</p>
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
