// WP-164: the quiet-hours control. Off until the person turns it on.

import { useEffect, useState } from "react";
import {
  loadQuietHours,
  QUIET_HOURS_KEY,
  saveQuietHours,
  type QuietHours,
} from "../model/quietHours";

/**
 * From and until, local time, plus the switch. Another window's change updates this one. `onChange` is told after
 * each saved change, so a page that reads the setting elsewhere can draw again (the WP-164 browser fixture does).
 */
export function QuietHoursSetting({ onChange }: { onChange?: () => void }) {
  const [quiet, setQuiet] = useState<QuietHours>(() => loadQuietHours());
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== QUIET_HOURS_KEY) return;
      setQuiet(loadQuietHours());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const apply = (next: QuietHours) => {
    const stored = saveQuietHours(next);
    setQuiet(stored);
    onChange?.();
  };

  return (
    <span className="flex items-center gap-2 text-[13px] text-content">
      <button
        type="button"
        role="switch"
        aria-label="Quiet hours"
        aria-checked={quiet.enabled}
        onClick={() => apply({ ...quiet, enabled: !quiet.enabled })}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${quiet.enabled ? "bg-accent" : "bg-content/20"}`}
      >
        <span
          className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${quiet.enabled ? "left-4.5" : "left-0.5"}`}
        />
      </button>
      <label>
        From
        <input
          type="time"
          aria-label="Quiet hours start"
          value={quiet.start}
          onChange={(event) => {
            const start = event.target.value;
            if (!start) return;
            apply({ ...quiet, start });
          }}
          className="ml-1 bg-transparent"
        />
      </label>
      <label>
        Until
        <input
          type="time"
          aria-label="Quiet hours end"
          value={quiet.end}
          onChange={(event) => {
            const end = event.target.value;
            if (!end) return;
            apply({ ...quiet, end });
          }}
          className="ml-1 bg-transparent"
        />
      </label>
    </span>
  );
}
