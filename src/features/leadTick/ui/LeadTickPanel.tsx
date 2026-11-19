// WP-160: the lead tick switch for the project the Crew tab shows. A save that failed says so; nothing is shown as
// kept when it wasn't. A late answer for another project does not land here.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LEAD_TICK_OPEN_ONLY, missedTicksLine } from "../model/schedule";
import type { LeadTickSetting } from "../model/setting";
import { leadTickStore, type LeadTickStore } from "../model/store";
import { LeadTickCard } from "./LeadTickCard";

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function LeadTickPanel({ project, store = leadTickStore(), now = Date.now }: { project: string; store?: LeadTickStore; now?: () => number }) {
  const revision = useSyncExternalStore(store.subscribe, store.revision, store.revision);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [clock, setClock] = useState(now());
  const projectNow = useRef(project);
  projectNow.current = project;
  useEffect(() => {
    const timer = setInterval(() => setClock(now()), 60_000);
    return () => clearInterval(timer);
  }, [now]);
  useEffect(() => setProblem(null), [project]);

  const folder = project.trim();
  if (!folder) return null;
  void revision;
  const setting = store.settingFor(folder);
  const run = store.runFor(folder);

  async function change(patch: Partial<LeadTickSetting>) {
    const mine = folder;
    setSaving(true);
    try {
      await store.writeSetting(mine, patch);
      if (projectNow.current.trim() === mine) setProblem(null);
    } catch (error) {
      if (projectNow.current.trim() === mine) setProblem(error instanceof Error ? error.message : "That didn't save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <LeadTickCard
      enabled={setting.enabled}
      intervalMinutes={setting.intervalMinutes}
      shipOnGreen={setting.shipOnGreen}
      openOnly={LEAD_TICK_OPEN_ONLY}
      lastLine={run?.lastLine || null}
      lastAt={run ? timeOf(run.lastTickAt) : null}
      missed={missedTicksLine(setting, run, Math.max(clock, now()))}
      problem={problem}
      saving={saving}
      onToggle={() => void change({ enabled: !setting.enabled })}
      onShipOnGreen={() => void change({ shipOnGreen: !setting.shipOnGreen })}
      onInterval={(minutes) => void change({ intervalMinutes: minutes })}
    />
  );
}
