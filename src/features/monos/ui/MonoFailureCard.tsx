// A Mono whose last turn failed, where Ash looks (Today, Being built): "Tally lead can't answer: Out of credits", amber
// or red like a stuck worker (StuckWorkerCard), with Try again, Open and Dismiss; what the provider said stays behind
// "Details". The Monos rail shows the same state in one line (MonoRailSection).
import { failureChip } from "../../hub/model/statusChip";
import { ChipMark } from "../../hub/ui/StatusMark";
import { useState } from "react";
import { CircleAlert } from "../../../shared/ui/icons";
import {
  dismissMonoFailure,
  failedMonoName,
  openMonoFailure,
  retryMonoFailure,
  type MonoFailure,
} from "../model/monoFailures";

const BTN = "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-60";
const PRIMARY = "shrink-0 rounded-md bg-content px-2.5 py-1 text-xs font-medium text-background-base hover:opacity-90 disabled:opacity-60";
const QUIET = "shrink-0 rounded-md px-2 py-1 text-xs text-content/55 hover:bg-content/6 hover:text-content";

function ago(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  return min < 1440 ? `${Math.floor(min / 60)}h` : `${Math.floor(min / 1440)}d`;
}

/** The failure's mark: grey (r27b; the red Needs you chip says when only Ash can fix it). */
export function FailureMark({ className = "size-3.5" }: { tone?: MonoFailure["tone"]; className?: string }) {
  return <CircleAlert aria-hidden strokeWidth={1.75} className={`${className} shrink-0 text-content/60`} />;
}

export function MonoFailureCard({ failure, where, now }: { failure: MonoFailure; where?: string; now: number }) {
  const [details, setDetails] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const name = failedMonoName(failure);
  const retry = () => {
    setProblem(null);
    if (retryMonoFailure(failure.monoId)) setSent(true);
    else setProblem(`${name} can't take it right now. Open the chat to see where it stands.`);
  };
  return (
    <div
      className="flex flex-col gap-1 rounded-md px-2 py-2 hover:bg-content/5"
      data-mono-failure={failure.monoId}
      data-mono-failure-tone={failure.tone}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-content/60">
        <FailureMark />
        <span className="min-w-0 truncate" data-mono-failure-where>
          {[where, name].filter(Boolean).join(" · ")}
        </span>
        {/* Only Ash can fix it (credits, sign-in): the red Needs you; it should come right by itself: Can't answer. */}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <ChipMark chip={failureChip(failure.tone)} />
          {failure.at ? <span className="tabular-nums">{ago(now - failure.at)}</span> : null}
        </span>
      </div>
      <div className="whitespace-normal break-words text-[13px] leading-5 text-content" data-mono-failure-line>
        {name} can't answer: {failure.reason}
        {failure.retryable ? "" : <span className="text-content/60"> · fix this before trying again</span>}
      </div>
      {details && failure.detail ? (
        <pre
          className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-content/5 px-2.5 py-1.5 font-mono text-[11px] leading-4 text-content/70"
          data-mono-failure-detail
        >
          {failure.detail}
        </pre>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <button type="button" className={PRIMARY} disabled={sent} data-mono-failure-retry onClick={retry}>
          {sent ? "Trying again…" : "Try again"}
        </button>
        <button type="button" className={BTN} data-mono-failure-open onClick={() => openMonoFailure(failure.monoId)}>
          Open {name}&apos;s chat
        </button>
        {failure.detail ? (
          <button
            type="button"
            className={QUIET}
            aria-expanded={details}
            data-mono-failure-details
            onClick={() => setDetails((open) => !open)}
          >
            {details ? "Hide details" : "Details"}
          </button>
        ) : null}
        <button type="button" className={QUIET} data-mono-failure-dismiss onClick={() => dismissMonoFailure(failure.monoId)}>
          Dismiss
        </button>
      </div>
      {problem ? (
        <div className="text-[13px] text-content/60" data-mono-failure-problem>
          {problem}
        </div>
      ) : null}
    </div>
  );
}

/** A list of failed Monos (Today's Stuck section, a project's Being built). */
export function MonoFailureList({
  failures,
  where,
  now,
}: {
  failures: readonly MonoFailure[];
  where?: (failure: MonoFailure) => string | undefined;
  now: number;
}) {
  if (!failures.length) return null;
  return (
    <div className="flex flex-col" data-mono-failures>
      {failures.map((failure) => (
        <MonoFailureCard key={`${failure.monoId}:${failure.blockId}`} failure={failure} where={where?.(failure)} now={now} />
      ))}
    </div>
  );
}
