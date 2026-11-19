// WP-131: the composer's dictation control. It asks in plain words, then the
// operating system asks. Nothing here sends the draft.
import { Mic } from "../../../shared/ui/icons";
import {
  DICTATION_EXPLAIN,
  DICTATION_LISTENING,
  DICTATION_WAITING,
} from "../model/dictation";

export function DictationAskButton({ onAsk }: { onAsk: () => void }) {
  return (
    <button
      type="button"
      title="Dictate"
      aria-label="Dictate"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onAsk}
      className="grid size-6.5 shrink-0 place-items-center rounded-md bg-selection text-content/50 hover:bg-selection-hover hover:text-content"
    >
      <Mic className="size-3.5" strokeWidth={1.5} />
    </button>
  );
}

export function DictationMenuRow({ onAsk }: { onAsk: () => void }) {
  return (
    <button
      type="button"
      aria-label="Dictate"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onAsk}
      className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left text-content hover:bg-content/10"
    >
      <Mic className="mt-0.5 size-4 shrink-0 text-content/60" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px]">Dictate</span>
        <span className="block truncate whitespace-nowrap text-[11px] leading-4 text-content/45">
          Write what you say into the draft
        </span>
      </span>
    </button>
  );
}

export function DictationExplainDialog({
  onContinue,
  onNotNow,
}: {
  onContinue: () => void;
  onNotNow: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-labelledby="dictation-title"
      data-dictation-explain
      className="mx-3 mt-2 rounded-lg border border-content/15 px-3 py-2"
    >
      <p id="dictation-title" className="text-[13px] text-content">
        Dictation
      </p>
      <p className="mt-1 text-[12px] leading-5 text-content/70">{DICTATION_EXPLAIN}</p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onContinue}
          className="rounded-md bg-content px-2 py-1 text-[12px] text-background"
        >
          Continue
        </button>
        <button
          type="button"
          onClick={onNotNow}
          className="rounded-md px-2 py-1 text-[12px] text-content/70 hover:bg-content/10"
        >
          Not now
        </button>
      </div>
    </div>
  );
}

export function DictationListening({ onStop }: { onStop: () => void }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <span data-dictation-status className="text-[11px] italic text-content/60">
        {DICTATION_LISTENING}
      </span>
      <button
        type="button"
        aria-label="Stop dictation"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onStop}
        className="rounded-md border border-current/20 px-2 py-0.5 text-[11px] text-content"
      >
        Stop dictation
      </button>
    </span>
  );
}

export function DictationWaiting({ onCancel }: { onCancel: () => void }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <span data-dictation-waiting className="text-[11px] text-content/55">
        {DICTATION_WAITING}
      </span>
      <button
        type="button"
        aria-label="Cancel dictation"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onCancel}
        className="rounded-md border border-current/20 px-2 py-0.5 text-[11px] text-content"
      >
        Cancel
      </button>
    </span>
  );
}

/** The provisional words, marked until the person stops talking. */
export function DictationProvisional({ text }: { text: string }) {
  return (
    <span data-dictation-partial className="dictation-partial">
      {text}
    </span>
  );
}
