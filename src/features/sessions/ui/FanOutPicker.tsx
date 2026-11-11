// WP-135: pick several models, then confirm before any paid chat starts.
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
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
  const [place, setPlace] = useState<{ left: number; bottom: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<FanOutTargetRef[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const atCap = selected.length >= FAN_OUT_MAX;

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setPlace({
      left: Math.max(8, rect.right - 288),
      bottom: Math.max(8, window.innerHeight - rect.top + 8),
    });
  }, [open, selected.length, confirming, rows.length]);

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
        className="flex h-6.5 shrink-0 items-center rounded-md border border-current/20 px-2 text-[11px] font-medium hover:border-current/35 hover:bg-content/15 disabled:opacity-40"
      >
        Compare
      </button>
      {open && place
        ? createPortal(
        <div
          data-fan-out-panel=""
          className="w-72 rounded-md border border-white/15 p-2 text-left text-[12px] text-white shadow-lg"
          style={{
            position: "fixed",
            left: place.left,
            bottom: place.bottom,
            zIndex: 40,
            background: "#2a2a2e",
          }}
        >
          <p data-fan-out-cap="" className="mb-2 text-content/80">
            {FAN_OUT_CAP_LINE} Pick at least 2.
          </p>
          <ul className="max-h-48 space-y-1 overflow-auto">
            {rows.map((choice) => {
              const on = selected.some(
                (item) => item.provider === choice.provider && item.model === choice.model,
              );
              return (
                <li key={`${choice.provider}:${choice.model}`}>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={disabled || busy || (atCap && !on)}
                      onChange={() => toggle(choice)}
                    />
                    <span>{choice.label}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          {notice ? <p className="mt-2 text-content/80">{notice}</p> : null}
          {confirming ? (
            <div data-fan-out-paid="" className="mt-2 space-y-2">
              <p>{FAN_OUT_PAID_LINE}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void start()}
                  className="rounded-md bg-content/15 px-2 py-1 disabled:opacity-40"
                >
                  Start chats
                </button>
                <button type="button" onClick={() => setConfirming(false)} className="px-2 py-1">
                  Back
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="mt-2 rounded-md bg-content/15 px-2 py-1 disabled:opacity-40"
              disabled={disabled || busy || selected.length < 2 || !prompt.trim()}
              onClick={review}
            >
              Review
            </button>
          )}
        </div>,
          document.body,
        )
        : null}
    </div>
  );
}
