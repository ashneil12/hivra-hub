// Hivra WP-156: standing answers in the Inbox. Guidance, not a new question.

import { useRef, useState } from "react";

export type StandingAnswer = {
  project: string;
  key: string;
  standingId: string;
  question: string;
  answer: string;
  uses: number;
  /** True only after the person ticks reuse. Missing or anything else stays off. */
  standing?: boolean;
};

export type RetireResult = {
  applied: boolean;
  gone?: boolean;
  relied: string[];
};

const REASON_MAX = 300;

/** Em dashes and en dashes never reach a person. A number range keeps a hyphen. */
function shown(value: string, max: number): string {
  const flat = value
    .replace(/(\d)\s*[—–]\s*(?=\d)/g, "$1-")
    .replace(/[ \t]*[—–][ \t]*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 3)}...`;
}

export function usedPhrase(uses: number): string {
  const count = Number.isFinite(uses) && uses > 0 ? Math.floor(uses) : 0;
  return count === 1 ? "Used 1 time" : `Used ${count} times`;
}

function taskIds(ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const text = shown(id, 200);
    if (!text || out.includes(text)) continue;
    out.push(text);
  }
  return out;
}

type Retired = {
  key: string;
  standingId: string;
  question: string;
  answer: string;
  note: string;
  relied: string[];
};

export function StandingAnswers({
  enabled,
  rows,
  stale = false,
  onRetire,
  onReuse,
}: {
  enabled: boolean;
  rows: readonly StandingAnswer[];
  stale?: boolean;
  onRetire?: (row: StandingAnswer, reason: string) => Promise<RetireResult>;
  /** The person's tick. Nothing else sets it, and it starts off. */
  onReuse?: (row: StandingAnswer, standing: boolean) => Promise<boolean>;
}) {
  const [asking, setAsking] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retired, setRetired] = useState<Retired[]>([]);
  const flight = useRef(0);
  const pending = useRef(false);

  if (!enabled && !stale && retired.length === 0) return null;
  const hidden = new Set(retired.map((row) => row.key));
  const active = rows.filter((row) => row.key && !hidden.has(row.key));

  function start(row: StandingAnswer) {
    setAsking(row.key);
    setReason("");
    setError("");
    setErrorKey(row.key);
  }

  async function retire(row: StandingAnswer) {
    const text = reason.trim();
    if (!text) {
      setErrorKey(row.key);
      setError("Say why, in a short line.");
      return;
    }
    if ([...text].length > REASON_MAX) {
      setErrorKey(row.key);
      setError("Keep the reason to 300 characters.");
      return;
    }
    if (pending.current) return;
    pending.current = true;
    const mine = ++flight.current;
    setBusy(true);
    setError("");
    try {
      const result = await onRetire?.(row, text);
      if (mine !== flight.current) return;
      if (!result) {
        setErrorKey(row.key);
        setError("Couldn't retire this. Trying again.");
        return;
      }
      const note = result.gone ? "That answer is gone." : result.applied ? "Retired." : "Already retired.";
      setRetired((current) => [
        ...current.filter((item) => item.key !== row.key),
        {
          key: row.key,
          standingId: row.standingId,
          question: row.question,
          answer: row.answer,
          note,
          relied: taskIds(result.relied),
        },
      ]);
      setAsking(null);
      setReason("");
    } catch {
      if (mine !== flight.current) return;
      setErrorKey(row.key);
      setError("Couldn't retire this. Trying again.");
    } finally {
      if (mine === flight.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

  async function reuse(row: StandingAnswer, standing: boolean) {
    if (pending.current) return;
    pending.current = true;
    const mine = ++flight.current;
    setBusy(true);
    setError("");
    try {
      const done = await onReuse?.(row, standing);
      if (mine !== flight.current) return;
      if (!done) {
        setErrorKey(row.key);
        setError("Couldn't update this. Trying again.");
        return;
      }
      setAsking(null);
    } catch {
      if (mine !== flight.current) return;
      setErrorKey(row.key);
      setError("Couldn't update this. Trying again.");
    } finally {
      if (mine === flight.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <section aria-label="Standing answers" className="flex flex-col gap-2 px-3 py-2">
      <h3 className="text-[13px] text-content">Standing answers</h3>
      <p className="text-[12px] text-content/60">
        A ticked answer is reused for similar questions. It is guidance, not permission.
      </p>
      {stale ? <p className="text-[12px] text-content/60">Couldn't load standing answers. Trying again.</p> : null}
      {active.map((row) => (
        <article
          key={row.key}
          data-standing-id={row.standingId}
          data-standing-key={row.key}
          className="rounded-md border border-stroke px-3 py-2"
        >
          <h4 className="text-[13px] text-content">{shown(row.question, 300) || "A standing answer"}</h4>
          <p className="mt-1 text-[12px] text-content/80">{shown(row.answer, 500)}</p>
          <p data-standing-uses className="mt-1 text-[12px] text-content/60">
            {usedPhrase(row.uses)}
          </p>
          {asking === row.key ? (
            <form
              className="mt-2 flex flex-col gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                if (!busy) void retire(row);
              }}
            >
              <label className="text-[12px] text-content" htmlFor={`retire-${row.key}`}>
                Why are you retiring this?
              </label>
              <input
                id={`retire-${row.key}`}
                aria-label="Why are you retiring this?"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                className="text-[12px] text-content"
              />
              <div className="flex flex-wrap gap-2">
                <button type="submit" className="text-[12px] text-content" disabled={busy}>
                  Retire this answer
                </button>
                <button
                  type="button"
                  className="text-[12px] text-content/60"
                  onClick={() => {
                    flight.current += 1;
                    pending.current = false;
                    setBusy(false);
                    setAsking(null);
                    setError("");
                  }}
                >
                  Cancel
                </button>
              </div>
              {error && errorKey === row.key ? (
                <p role="alert" className="text-[12px] text-content/70">
                  {error}
                </p>
              ) : null}
            </form>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className="text-[12px] text-content" disabled={busy} onClick={() => start(row)}>
                Retire
              </button>
              <label className="flex items-center gap-2 text-[12px] text-content">
                <input
                  type="checkbox"
                  checked={row.standing === true}
                  disabled={busy}
                  onChange={(event) => void reuse(row, event.target.checked)}
                />
                Reuse for similar questions
              </label>
              {error && errorKey === row.key ? (
                <p role="alert" className="text-[12px] text-content/70">
                  {error}
                </p>
              ) : null}
            </div>
          )}
        </article>
      ))}
      {retired.map((row) => (
        <article
          key={row.key}
          data-standing-id={row.standingId}
          data-standing-retired="true"
          className="rounded-md border border-stroke px-3 py-2"
        >
          <h4 className="text-[13px] text-content">{shown(row.question, 300) || "A standing answer"}</h4>
          <p className="mt-1 text-[12px] text-content/80">{shown(row.answer, 500)}</p>
          <p className="mt-1 text-[12px] text-content/60">{row.note}</p>
          <p className="mt-1 text-[12px] text-content">Tasks that relied on this</p>
          {row.relied.length === 0 ? (
            <p className="text-[12px] text-content/60">No task relied on this.</p>
          ) : (
            row.relied.map((id) => (
              <p key={id} data-relied className="text-[12px] text-content/80">
                {id}
              </p>
            ))
          )}
        </article>
      ))}
    </section>
  );
}

export function StandingAnswersSwitch({
  on,
  disabled = false,
  note,
  onChange,
}: {
  on: boolean;
  disabled?: boolean;
  note?: string | null;
  onChange: (on: boolean) => void;
}) {
  return (
    <section className="pt-8">
      <div className="overflow-hidden rounded-xl border border-content/10 bg-content/3">
        <div className="flex items-start justify-between gap-3 px-3 py-2">
          <div className="min-w-0">
            <p className="text-[13px] text-content">Standing answers</p>
            <p className="mt-0.5 text-[12px] text-content/60">
              Reuse an answer when a later question matches. Off until you turn this on.
            </p>
            {note ? <p className="mt-0.5 text-[12px] text-content/60">{note}</p> : null}
          </div>
          <button
            type="button"
            role="switch"
            aria-label="Standing answers"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(!on)}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40 ${on ? "bg-accent" : "bg-content/20"}`}
          >
            <span
              className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${on ? "left-4.5" : "left-0.5"}`}
            />
          </button>
        </div>
      </div>
    </section>
  );
}
