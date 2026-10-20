import { MONO_STATUS_LABEL, type MonoState } from "../model/mono";

type Props = {
  state: MonoState;
  /** Project color, for the working dot. */
  color: string;
  className?: string;
};

/**
 * The Monos status line: a dot (accent when it needs you, red or amber when its
 * last turn failed, the project color pulsing while it works, grey at rest),
 * the state, and what it is on (for a failure, the plain reason).
 */
export function MonoStatus({ state, color, className = "" }: Props) {
  const { status, activity } = state;
  const dot =
    status === "needs-you"
      ? "var(--color-accent)"
      : status === "failed"
        ? state.tone === "red"
          ? "rgb(248 113 113)"
          : "rgb(251 191 36)"
        : status === "working"
          ? color
          : undefined;
  return (
    <span
      data-mono-status={status}
      title={activity}
      className={`flex min-w-0 items-center gap-1.5 ${className}`}
    >
      <span
        aria-hidden
        className={`size-2 shrink-0 rounded-full ${dot ? "" : "bg-content/30"} ${
          status === "working" ? "animate-pulse" : ""
        }`}
        style={dot ? { background: dot } : undefined}
      />
      <span className="shrink-0">{MONO_STATUS_LABEL[status]}</span>
      {activity ? (
        <>
          <span aria-hidden className="shrink-0 opacity-60">
            ·
          </span>
          <span className="min-w-0 truncate">{activity}</span>
        </>
      ) : null}
    </span>
  );
}
