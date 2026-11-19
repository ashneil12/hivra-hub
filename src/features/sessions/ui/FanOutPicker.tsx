// WP-135: pick several models, then confirm before any paid chat starts.
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Popover } from "../../../shared/ui/Popover";
import { Check } from "../../../shared/ui/icons";
import {
  FAN_OUT_CAP_LINE,
  FAN_OUT_MAX,
  FAN_OUT_PAID_LINE,
  planFanOut,
  toggleFanOutTarget,
  type FanOutTargetRef,
} from "../model/fanOut";
import {
  allModels,
  getModelSnapshot,
  getPickerVisibilitySnapshot,
  isPickerProviderVisible,
  subscribeModels,
  subscribePickerVisibility,
} from "../model/models";
import { fanOutModelChoices, type FanOutChoice } from "../model/fanOutChoices";
import type { HarnessId } from "../model/session";

type Props = {
  prompt: string;
  disabled?: boolean;
  choices?: readonly FanOutChoice[];
  allowedHarnesses?: readonly HarnessId[];
  onLaunch: (
    prompt: string,
    targets: readonly FanOutTargetRef[],
  ) => boolean | string | Promise<boolean | string | void> | void;
};

export function FanOutPicker({
  prompt,
  disabled = false,
  choices,
  allowedHarnesses,
  onLaunch,
}: Props) {
  const catalogTick = useSyncExternalStore(subscribeModels, getModelSnapshot, getModelSnapshot);
  const visibilityTick = useSyncExternalStore(
    subscribePickerVisibility,
    getPickerVisibilitySnapshot,
    getPickerVisibilitySnapshot,
  );
  const rows = useMemo(
    () => choices ?? fanOutModelChoices(allModels(), allowedHarnesses, isPickerProviderVisible),
    [choices, allowedHarnesses, catalogTick, visibilityTick],
  );
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<FanOutTargetRef[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const atCap = selected.length >= FAN_OUT_MAX;

  const toggle = (choice: FanOutChoice) => {
    const next = toggleFanOutTarget(selected, choice);
    setSelected(next.selected);
    setConfirming(false);
    setNotice(next.refused === "over-cap" ? FAN_OUT_CAP_LINE : null);
  };

  const review = () => {
    const planned = planFanOut({ prompt, targets: selected });
    if (!planned.ok) {
      setNotice(
        planned.code === "empty-prompt"
          ? "Write a prompt first."
          : planned.code === "too-few"
            ? "Pick at least 2 models."
            : FAN_OUT_CAP_LINE,
      );
      return;
    }
    setNotice(null);
    setConfirming(true);
  };

  const start = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const accepted = await onLaunch(prompt, selected);
      if (typeof accepted === "string") {
        // Nothing started. The reason says why, in the words of the compare itself.
        setNotice(accepted);
        return;
      }
      if (accepted === false) {
        setNotice("That compare did not start.");
        return;
      }
      setOpen(false);
      setConfirming(false);
      setSelected([]);
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setOpen(false);
    setConfirming(false);
  };

  return (
    <div data-fan-out="" className="relative">
      <button
        type="button"
        aria-expanded={open}
        ref={buttonRef}
        aria-label="Compare models"
        disabled={disabled || busy}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          setOpen((value) => !value);
          setConfirming(false);
        }}
        className={`flex h-6.5 shrink-0 items-center rounded-md border px-2 text-[11px] font-medium hover:border-current/35 hover:bg-content/15 disabled:opacity-40 ${
          open ? "border-current/35 bg-content/15" : "border-current/20"
        }`}
      >
        Compare
      </button>
      {open ? (
        // The app's own menu surface (the model menu's), so it closes on a click away or Escape like every other menu.
        <Popover
          anchor={buttonRef}
          side="top"
          align="end"
          width={300}
          onDismiss={busy ? undefined : close}
          role="dialog"
          aria-label="Compare models"
          data-fan-out-panel=""
          className="solid-panel-glass p-1 font-sans text-[13px] text-content"
        >
          <div className="px-2 pb-1.5 pt-1.5">
            <div className="text-[13px] font-medium">Compare models</div>
            <p data-fan-out-cap="" className="mt-0.5 text-[12px] leading-snug text-content/55">
              Send the same message to several models, each in its own chat. {FAN_OUT_CAP_LINE} Pick at least 2.
            </p>
          </div>
          <ul className="max-h-56 overflow-auto">
            {rows.map((choice) => {
              const on = selected.some(
                (item) => item.provider === choice.provider && item.model === choice.model,
              );
              return (
                <li key={`${choice.provider}:${choice.model}`}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    aria-label={choice.label}
                    disabled={disabled || busy || (atCap && !on)}
                    onClick={() => toggle(choice)}
                    className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] disabled:opacity-40 ${
                      on ? "bg-selection text-content" : "text-content hover:bg-content/5"
                    }`}
                  >
                    {/* A tick box on every row, so the list reads as "pick several" before anything is picked. */}
                    <span aria-hidden className={`grid size-4 shrink-0 place-items-center rounded ${on ? "bg-content text-background-base" : "border border-content/25"}`}>
                      {on ? <Check className="size-3" strokeWidth={2.5} /> : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{choice.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {notice ? <p className="px-2 pt-2 text-[12px] leading-snug text-content/70">{notice}</p> : null}
          {confirming ? (
            <div data-fan-out-paid="" className="mt-1 border-t border-content/10 px-2 pb-1.5 pt-2">
              <p className="text-[12px] leading-snug text-content/70">{FAN_OUT_PAID_LINE}</p>
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="h-7 rounded-md px-2.5 text-[12px] text-content/70 hover:bg-content/8 hover:text-content"
                >
                  Back
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void start()}
                  className="h-7 rounded-md bg-content px-2.5 text-[12px] font-medium text-background-base disabled:opacity-40"
                >
                  Start chats
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-1 flex items-center justify-between gap-2 border-t border-content/10 px-2 pb-1.5 pt-2">
              <span className="text-[12px] text-content/50">
                {selected.length === 0 ? "None picked" : `${selected.length} picked`}
              </span>
              <button
                type="button"
                className="h-7 rounded-md bg-content px-2.5 text-[12px] font-medium text-background-base disabled:opacity-40"
                disabled={disabled || busy || selected.length < 2 || !prompt.trim()}
                title={!prompt.trim() ? "Write your message in the box first" : selected.length < 2 ? "Pick at least 2 models" : undefined}
                onClick={review}
              >
                Review
              </button>
            </div>
          )}
        </Popover>
      ) : null}
    </div>
  );
}
