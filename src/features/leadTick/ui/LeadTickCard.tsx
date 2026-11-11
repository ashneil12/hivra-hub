// WP-160: the project's lead tick on the Crew tab. Off says one line; on shows the interval, Ship on green, the last
// tick and, when the app was closed, that ticks were missed.

import { useEffect, useState } from "react";
import { MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES, readLeadTickSetting } from "../model/setting";

export const LEAD_TICK_HELP =
  "The Lead looks at the programme on a timer: it starts the next package when a builder is free and checks CI on open pull requests.";
export const SHIP_ON_GREEN_HELP =
  "When a programme pull request is green, the tick asks this project's merge rules to merge it. Without Merge without asking, you are asked first. Packages parked for a security check are never merged. A path list cannot catch a backdoor in unrelated code, so with Merge without asking on, a Lead can still merge a change that is not on the security list without a security review. That switch is off until you turn it on.";
export const SHIP_ON_GREEN_OFF = "Off: green pull requests wait for you.";

function Switch(props: { label: string; on: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={props.label}
      aria-checked={props.on}
      disabled={props.disabled}
      onClick={props.onToggle}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${props.on ? "bg-accent" : "bg-content/20"}`}
    >
      <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${props.on ? "left-4.5" : "left-0.5"}`} />
    </button>
  );
}

export function LeadTickCard(props: {
  enabled: boolean;
  intervalMinutes: number;
  shipOnGreen: boolean;
  /** "Runs only while Hivra is open..." */
  openOnly: string;
  lastLine: string | null;
  lastAt: string | null;
  missed: string | null;
  problem?: string | null;
  saving?: boolean;
  onToggle: () => void;
  onShipOnGreen: () => void;
  onInterval: (minutes: number) => void;
}) {
  const [draft, setDraft] = useState(String(props.intervalMinutes));
  useEffect(() => setDraft(String(props.intervalMinutes)), [props.intervalMinutes]);
  const commit = () => {
    const value = Number(draft);
    if (!Number.isFinite(value)) {
      setDraft(String(props.intervalMinutes));
      return;
    }
    const minutes = readLeadTickSetting({ intervalMinutes: value }).intervalMinutes;
    setDraft(String(minutes));
    if (minutes !== props.intervalMinutes) props.onInterval(minutes);
  };
  return (
    <section aria-label="Lead tick" className="border-b border-stroke px-3 py-2" data-lead-tick="">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[13px] text-content">Lead tick</p>
          <p className="text-[12px] text-content/70">{LEAD_TICK_HELP}</p>
        </div>
        <Switch label="Lead tick" on={props.enabled} onToggle={props.onToggle} disabled={props.saving} />
      </div>
      {props.enabled ? (
        <>
          <label className="mt-2 flex items-center gap-2 text-[13px] text-content">
            Every
            <input
              type="number"
              aria-label="Minutes between ticks"
              min={MIN_INTERVAL_MINUTES}
              max={MAX_INTERVAL_MINUTES}
              step={1}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === "Enter") commit();
              }}
              className="w-16 rounded border border-stroke bg-transparent px-1.5 py-0.5 text-[13px] text-content"
            />
            minutes
          </label>
          <div className="mt-2 flex items-start justify-between gap-3">
            <div>
              <p className="text-[13px] text-content">Ship on green</p>
              <p className="text-[12px] text-content/70" data-ship-on-green-help="">
                {props.shipOnGreen ? SHIP_ON_GREEN_HELP : SHIP_ON_GREEN_OFF}
              </p>
            </div>
            <Switch label="Ship on green" on={props.shipOnGreen} onToggle={props.onShipOnGreen} disabled={props.saving} />
          </div>
          <p className="mt-1 text-[12px] text-content/70" data-lead-tick-open-only="">
            {props.openOnly}
          </p>
          {props.lastLine ? (
            <p className="mt-1 text-[12px] text-content" data-lead-tick-last="">
              {props.lastAt ? `Last tick ${props.lastAt}: ` : ""}
              {props.lastLine}
            </p>
          ) : null}
          {props.missed ? (
            <p className="mt-1 text-[12px] text-content" data-lead-tick-missed="">
              {props.missed}
            </p>
          ) : null}
        </>
      ) : null}
      {props.problem ? (
        <p className="mt-1 text-[12px] text-content" role="alert">
          {props.problem}
        </p>
      ) : null}
    </section>
  );
}
