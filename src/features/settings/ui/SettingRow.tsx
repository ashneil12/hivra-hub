import { useState, type ReactNode } from "react";
import { playCue } from "../model/sounds";

/**
 * The Settings row, switch and two-way choice, for settings that live in their own file (the sandbox, computer use).
 * They copy the look of `Row`, `Toggle` and `Segmented` in SettingsView.tsx, which are local to that file and can't be
 * imported back into a file it imports. A row keeps its description to one line; anything longer goes in `details`,
 * shown only when the person presses More.
 */
export function SettingRow({
  id,
  label,
  description,
  details,
  below,
  children,
}: {
  /** Matches a `SETTINGS_INDEX` id so search can scroll here. */
  id?: string;
  label: ReactNode;
  description?: ReactNode;
  /** The longer explanation, hidden until More. */
  details?: ReactNode;
  /** Anything under the description: a note, an error, a short list. */
  below?: ReactNode;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      id={id ? `setting-${id}` : undefined}
      data-setting-id={id}
      className="settings-row flex items-start gap-6 border-b border-content/5 px-4 py-3.5 transition-colors last:border-b-0"
    >
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-content">{label}</div>
        {description || details ? (
          <p className="mt-1 text-[12px] leading-relaxed text-content/45">
            {description}
            {details ? (
              <>
                {description ? " " : null}
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpen(!open)}
                  className="text-content/60 underline-offset-2 hover:text-content hover:underline"
                >
                  {open ? "Less" : "More"}
                </button>
              </>
            ) : null}
          </p>
        ) : null}
        {details && open ? <div className="mt-1.5 text-[12px] leading-relaxed text-content/60">{details}</div> : null}
        {below}
      </div>
      {children ? (
        <div className="settings-row-control flex min-w-0 max-w-[60%] shrink-0 flex-wrap items-center justify-end gap-2">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function SettingSwitch({
  label,
  on,
  onChange,
  disabled = false,
}: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={on}
      disabled={disabled}
      onClick={() => {
        onChange(!on);
        playCue("switch");
      }}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        on ? "bg-accent" : "bg-content/20"
      }`}
    >
      <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${on ? "left-4.5" : "left-0.5"}`} />
    </button>
  );
}

export function SettingSegmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-grid max-w-full shrink-0 gap-0.5 rounded-md border border-content/10 p-0.5 text-[12px]"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={`min-w-0 whitespace-nowrap rounded-[5px] px-2.5 py-1 ${
            value === option.value ? "bg-selection text-content" : "text-content/50 hover:text-content"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** The quiet bordered button Settings uses beside a row. */
export const settingButtonClass =
  "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-content/10 px-2.5 py-1 text-[12px] text-content/70 transition-transform duration-150 hover:bg-content/10 hover:text-content active:scale-[0.97] disabled:cursor-default disabled:opacity-40";

/** The text field Settings uses inside a row. */
export const settingInputClass =
  "rounded-md bg-surface px-2 py-1 text-[12px] text-content outline-none ring-1 ring-surface-ring placeholder:text-content/60";
