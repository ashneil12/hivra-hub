// WP-144: the switch and the decision on the crew card. Off says nothing.

import { SecondaryButton } from "../../../shared/ui/SecondaryButton";
import { DECISION_OPTIONS } from "../model/gate";
import type { Finding } from "../model/review";

export function FreshEyesCard(props: {
  enabled: boolean;
  autoAccept: boolean;
  line: string | null;
  /** The first lines of the brief Approve would start. */
  brief?: string | null;
  findings: readonly Finding[];
  pending: boolean;
  onToggle: () => void;
  onAutoAccept: () => void;
  onDecide: (answer: (typeof DECISION_OPTIONS)[number]) => void;
}) {
  return (
    <section aria-label="Fresh-eyes review" className="border-b border-stroke px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] text-content">Fresh-eyes review before crew starts</p>
        <button
          type="button"
          role="switch"
          aria-label="Fresh-eyes review before crew starts"
          aria-checked={props.enabled}
          onClick={props.onToggle}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${props.enabled ? "bg-accent" : "bg-content/20"}`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${props.enabled ? "left-4.5" : "left-0.5"}`}
          />
        </button>
      </div>
      {props.enabled ? (
        <div className="mt-2 flex items-start justify-between gap-3">
          <p className="text-[13px] text-content">Accept a clean review without asking</p>
          <button
            type="button"
            role="switch"
            aria-label="Accept a clean review without asking"
            aria-checked={props.autoAccept}
            onClick={props.onAutoAccept}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${props.autoAccept ? "bg-accent" : "bg-content/20"}`}
          >
            <span
              className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${props.autoAccept ? "left-4.5" : "left-0.5"}`}
            />
          </button>
        </div>
      ) : null}
      {props.line ? (
        <p className="mt-1 text-[13px] text-content" data-fresh-eyes-line="">
          {props.line}
        </p>
      ) : null}
      {props.enabled && props.brief ? (
        <p className="mt-1 whitespace-pre-line text-[12px] text-content/70" data-fresh-eyes-brief="">
          {props.brief}
        </p>
      ) : null}
      {props.enabled && props.findings.length > 0 ? (
        <ul className="mt-1">
          {props.findings.map((finding) => (
            <li key={`${finding.persona}:${finding.summary}`} className="text-[12px] text-content/70">
              {finding.summary}
              {finding.break ? ` ${finding.break}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {props.enabled && props.pending ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {DECISION_OPTIONS.map((option) => (
            <SecondaryButton key={option} onClick={() => props.onDecide(option)}>
              {option}
            </SecondaryButton>
          ))}
        </div>
      ) : null}
    </section>
  );
}
