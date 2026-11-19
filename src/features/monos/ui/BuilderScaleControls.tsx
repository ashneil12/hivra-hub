// WP-161: the shared ceiling and the optional pauses, on the project Workers dialog and Crew defaults.

import { useWorkerPoolVersion, builderScale, setBuilderScale } from "../model/workerPool";
import {
  DEFAULT_FREE_DISK_GB,
  MAX_BUILDERS,
  PAUSES_ALL_PROJECTS,
  scaleLine,
  type BuilderScale,
} from "../model/builderScale";

const INPUT =
  "w-16 rounded-lg border border-content/10 bg-content/5 px-2 py-1 text-right text-[13px] text-content outline-none focus:border-content/30 disabled:opacity-40";

function save(next: BuilderScale): void {
  setBuilderScale(next);
}

/** Pauses, and (on Crew defaults) the max builders a project uses when it has not set its own. */
export function BuilderScaleControls({ showSharedMax = false }: { showSharedMax?: boolean }) {
  useWorkerPoolVersion();
  const scale = builderScale();
  const loadOn = scale.load.kind !== "off";
  const loadValue = scale.load.kind === "above" ? String(scale.load.value) : "";

  const setLoadOn = (on: boolean) => save({ ...scale, load: on ? { kind: "default" } : { kind: "off" } });
  const setLoadValue = (raw: string) => {
    if (raw.trim() === "") {
      save({ ...scale, load: { kind: "default" } });
      return;
    }
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) save({ ...scale, load: { kind: "above", value: n } });
  };
  const setGb = (key: "pauseFreeMemoryGb" | "pauseFreeDiskGb", raw: string, whenOn: number) => {
    if (raw.trim() === "") {
      save({ ...scale, [key]: null });
      return;
    }
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) save({ ...scale, [key]: n });
    else if (raw === "on") save({ ...scale, [key]: whenOn });
  };

  return (
    <div className="flex flex-col gap-2" data-builder-scale={showSharedMax ? "system" : "pauses"}>
      {showSharedMax ? (
        <>
          <label className="flex items-center justify-between gap-2 text-[13px] text-content">
            Max builders
            <input
              type="number"
              min={1}
              max={MAX_BUILDERS}
              value={scale.maxBuilders}
              aria-label="Max builders"
              data-builder-max
              onChange={(event) => {
                const n = Number(event.target.value);
                if (Number.isFinite(n) && n >= 1) save({ ...scale, maxBuilders: n });
              }}
              className={INPUT}
            />
          </label>
          <p className="text-[12px] leading-4 text-content/60">
            Projects that have not set their own use this. The default is 6.
          </p>
        </>
      ) : null}
      <fieldset className="flex flex-col gap-2 border-0 p-0" data-builder-pauses>
        <legend className="text-[13px] text-content">Pause new builders when</legend>
        <p className="text-[12px] leading-4 text-content/60" data-builder-pauses-scope>{PAUSES_ALL_PROJECTS}</p>
        <p className="text-[12px] leading-4 text-content/60">Running builders keep going. Each check can be turned off.</p>
        <label className="flex items-center justify-between gap-2 text-[13px] text-content">
          <span className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={loadOn}
              aria-label="Pause when the load average is high"
              data-builder-pause-on="load"
              onChange={(event) => setLoadOn(event.target.checked)}
            />
            Load average is above
          </span>
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={loadValue}
            disabled={!loadOn}
            placeholder="1.6 x cores"
            aria-label="Load average limit"
            data-builder-pause="load"
            onChange={(event) => setLoadValue(event.target.value)}
            className={INPUT}
          />
        </label>
        <label className="flex items-center justify-between gap-2 text-[13px] text-content">
          <span className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={scale.pauseFreeMemoryGb != null}
              aria-label="Pause when free memory is low"
              data-builder-pause-on="memory"
              onChange={(event) => setGb("pauseFreeMemoryGb", event.target.checked ? "on" : "", 2)}
            />
            Free memory is below
          </span>
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={scale.pauseFreeMemoryGb ?? ""}
            disabled={scale.pauseFreeMemoryGb == null}
            aria-label="Free memory limit in GB"
            data-builder-pause="memory"
            onChange={(event) => setGb("pauseFreeMemoryGb", event.target.value, 2)}
            className={INPUT}
          />
        </label>
        <label className="flex items-center justify-between gap-2 text-[13px] text-content">
          <span className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={scale.pauseFreeDiskGb != null}
              aria-label="Pause when free disk is low"
              data-builder-pause-on="disk"
              onChange={(event) => setGb("pauseFreeDiskGb", event.target.checked ? "on" : "", DEFAULT_FREE_DISK_GB)}
            />
            Free disk is below
          </span>
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={scale.pauseFreeDiskGb ?? ""}
            disabled={scale.pauseFreeDiskGb == null}
            aria-label="Free disk limit in GB"
            data-builder-pause="disk"
            onChange={(event) => setGb("pauseFreeDiskGb", event.target.value, DEFAULT_FREE_DISK_GB)}
            className={INPUT}
          />
        </label>
      </fieldset>
      <p className="text-[12px] leading-4 text-content/60" data-builder-scale-line>
        {scaleLine(scale)}
      </p>
    </div>
  );
}
