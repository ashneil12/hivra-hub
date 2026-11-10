// WP-165: the switch in Settings. Off is the state before anything is saved.

import { useEffect, useState } from "react";
import { findMono, listMonos } from "../../monos/model/mono";
import { loadHabits, updateHabits } from "../../monos/model/monoHabits";
import { readsEveryProject } from "../../chief/model/scope";
import { tauriLocalHubDisk } from "../../hub/model/localHub/localTransport";
import { syncScoutHabit } from "../model/habit";
import { parseScoutSettings, SCOUT_DEFAULTS, type ScoutSettings } from "../model/settings";
import { changeScoutDoc, readScoutSettings } from "../model/store";

function folderName(bookmark: string | null): string {
  if (!bookmark) return "No folder";
  const parts = bookmark.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || "Folder";
}

async function saveSettings(next: ScoutSettings): Promise<ScoutSettings | null> {
  const parsed = parseScoutSettings(next);
  try {
    const saved = await changeScoutDoc(tauriLocalHubDisk, (doc) => ({ ...doc, settings: parsed }));
    return saved.settings;
  } catch {
    return null;
  }
}

async function syncHabits(settings: ScoutSettings): Promise<void> {
  const now = Date.now();
  for (const mono of listMonos()) {
    if (!readsEveryProject(findMono(mono.id) ?? mono)) continue;
    await syncScoutHabit(
      mono.id,
      loadHabits,
      async (id, change) => updateHabits(id, change),
      async () => settings,
      now,
    );
  }
}

/** The overnight scout controls. A write that does not land leaves the controls where they were. */
export function OvernightScoutSetting() {
  const [settings, setSettings] = useState<ScoutSettings>(SCOUT_DEFAULTS);
  const [ready, setReady] = useState(false);
  const [time, setTime] = useState(SCOUT_DEFAULTS.time);
  const [max, setMax] = useState(String(SCOUT_DEFAULTS.maxDrafts));

  useEffect(() => {
    let stopped = false;
    void readScoutSettings(tauriLocalHubDisk)
      .then((next) => {
        if (stopped) return;
        setSettings(next);
        setTime(next.time);
        setMax(String(next.maxDrafts));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!stopped) setReady(true);
      });
    return () => {
      stopped = true;
    };
  }, []);

  async function commit(next: ScoutSettings) {
    const saved = await saveSettings(next);
    if (!saved) return;
    setSettings(saved);
    setTime(saved.time);
    setMax(String(saved.maxDrafts));
    await syncHabits(saved).catch(() => undefined);
  }

  return (
    <div className="flex flex-col items-end gap-2" data-overnight-scout="">
      <button
        type="button"
        role="switch"
        aria-label="Overnight scout"
        aria-checked={settings.enabled}
        disabled={!ready}
        className="text-[13px] text-content underline-offset-2 hover:underline disabled:opacity-50"
        onClick={() => void commit({ ...settings, enabled: !settings.enabled })}
      >
        {settings.enabled ? "On" : "Off"}
      </button>
      <label className="text-[13px] text-content">
        Drafts per night
        <input
          aria-label="Drafts per night"
          value={max}
          disabled={!ready}
          inputMode="numeric"
          className="ml-2 w-12 bg-transparent text-right text-[13px] text-content outline-none"
          onChange={(event) => setMax(event.target.value)}
          onBlur={() => {
            const parsed = Number(max);
            void commit({ ...settings, maxDrafts: parsed });
          }}
        />
      </label>
      <label className="text-[13px] text-content">
        Time
        <input
          aria-label="Time"
          value={time}
          disabled={!ready}
          className="ml-2 w-16 bg-transparent text-right text-[13px] text-content outline-none"
          onChange={(event) => setTime(event.target.value)}
          onBlur={() => void commit({ ...settings, time })}
        />
      </label>
      <div className="flex items-center gap-2 text-[13px] text-content">
        <span>{folderName(settings.watchFolder)}</span>
        <button
          type="button"
          className="underline-offset-2 hover:underline disabled:opacity-50"
          disabled={!ready}
          onClick={() => {
            void import("../../../platform/tauri/fs").then(async ({ pickFolders }) => {
              const picked = await pickFolders("Watch folder");
              const folder = picked[0];
              if (!folder) return;
              await commit({ ...settings, watchFolder: folder });
            });
          }}
        >
          Choose a folder
        </button>
        {settings.watchFolder ? (
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={() => void commit({ ...settings, watchFolder: null })}
          >
            Clear folder
          </button>
        ) : null}
      </div>
    </div>
  );
}
