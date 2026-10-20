import { useEffect, useMemo, useState } from "react";
import { IS_MAC } from "../../../platform/tauri/platform";
import { Airplane } from "../../../shared/ui/icons";
import { examplesOn } from "../../hub/model/examples";
import { hubData, useHubDataVersion } from "../../hub/model/hubData";
import { leadFor } from "../../hub/model/hubLeads";
import { useNow } from "../../hub/model/liveJobs";
import { findMono, monoLook } from "../../monos/model/mono";
import {
  activeSwitches,
  adoptStatus,
  autopilotBackend,
  autopilotError,
  autopilotLogSnapshot,
  autopilotSnapshot,
  autoResumeOn,
  EVERYTHING,
  OPEN_CHAT_EVENT,
  refreshAutopilot,
  setAutopilotBackend,
  useAutopilotVersion,
  type LogEntry,
} from "../model/autopilot";
import { byDay, heldThisRun, isCall, outcomeLabel, switchLines, timeLabel, type SwitchLine } from "../model/autopilotView";
import { formatUntil, untilPresets } from "../model/endTime";
import { exampleAutopilot } from "../model/memoryAutopilot";
import { RED_LIST } from "../model/redList";

const PRIMARY = "rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90 disabled:opacity-40";
const QUIET = "rounded-md px-2.5 py-1 text-[12px] text-content/70 hover:bg-content/5 hover:text-content";
const CHIP = "rounded-md px-2.5 py-1 text-[12px] transition-colors";

function monoName(monoId: string): string {
  try {
    const mono = findMono(monoId);
    return mono ? monoLook(mono).name : (leadFor(monoId)?.name ?? monoId);
  } catch {
    return monoId;
  }
}

function localInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A switch row's words (Ash's whole message when a Mono switched it), kept to one line. */
function shortDetail(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function openChat(chatId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail: chatId }));
}

/**
 * The Autopilot screen: the switch (for everything or per project, with an end time), what keeps it going (the Mac
 * awake, a relaunch after a crash), the red-list calls left for Ash, and the log of every call it made.
 */
export function AutopilotView() {
  useAutopilotVersion();
  useHubDataVersion();
  const now = useNow(30_000);
  useEffect(() => {
    // The browser preview has no Rust side: the examples flag shows a sample weekend.
    if (!autopilotBackend() && examplesOn()) setAutopilotBackend(exampleAutopilot());
    void refreshAutopilot();
    // Leaving the page counts as having looked.
    return () => void autopilotBackend()?.seen(Date.now()).catch(() => undefined);
  }, []);
  const status = autopilotSnapshot();
  const log = autopilotLogSnapshot();
  const projects = hubData().listProjects();
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const lines = switchLines(status, now, projectName, monoName);
  const on = activeSwitches(status, now);
  const held = heldThisRun(log);
  const available = !!autopilotBackend();

  return (
    <div role="region" aria-label="Autopilot" data-hub-surface data-hub-autopilot className="flex min-h-0 min-w-0 flex-1 flex-col text-content">
      <div className="flex h-10 shrink-0 select-none items-center border-b border-stroke" data-tauri-drag-region="deep">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <Airplane className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
          <span className="min-w-0 truncate text-content">Autopilot</span>
        </div>
        {IS_MAC ? null : <div className="w-[120px]" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[720px] flex-col gap-7 px-8 py-8">
          {!available ? (
            <p className="text-[13px] text-content/60">Autopilot needs the desktop app.</p>
          ) : (
            <>
              <section aria-label="Switch" className="flex flex-col gap-3" data-autopilot-switch={on.length ? "on" : "off"}>
                {lines.length ? (
                  <div className="flex flex-col gap-2">
                    {lines.map((line) => (
                      <SwitchRow key={line.scope} line={line} />
                    ))}
                    <KeepsGoing />
                  </div>
                ) : (
                  <div>
                    <p className="text-[14px] font-medium text-content">Autopilot is off.</p>
                    <p className="mt-0.5 text-[13px] leading-5 text-content/60">
                      When it's on, agents take their own recommendation instead of asking you, and every call lands in the log below. Your red list always waits for you.
                    </p>
                  </div>
                )}
                <TurnOn projects={projects.map((p) => ({ id: p.id, name: p.name }))} on={on.length > 0} now={now} />
                {autopilotError() ? <p className="text-[12px] text-content/60">{autopilotError()}</p> : null}
              </section>

              {held.length ? (
                <section aria-label="Waiting for you" data-autopilot-held>
                  <h2 className="mb-1 text-xs text-content/60">Waiting for you</h2>
                  <p className="px-2 pb-1 text-[12px] text-content/50">Red-list calls autopilot left for you. Each waits in the chat that asked.</p>
                  <div className="flex flex-col">
                    {held.map((entry) => (
                      <LogRow key={entry.id} entry={entry} projectName={projectName} fresh={false} />
                    ))}
                  </div>
                </section>
              ) : null}

              <LogSection log={log} now={now} seenAt={status?.logSeenAt ?? 0} projectName={projectName} />

              <section aria-label="Never automated">
                <h2 className="mb-1 text-xs text-content/60">Never automated</h2>
                <ul className="grid gap-x-6 gap-y-0.5 px-2 text-[12px] leading-5 text-content/70 sm:grid-cols-2" data-autopilot-red-list>
                  {RED_LIST.map((item) => (
                    <li key={item.id}>{item.label}</li>
                  ))}
                </ul>
              </section>

              <AutoResume projects={projects.map((p) => ({ id: p.id, name: p.name }))} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function KeepsGoing() {
  const status = autopilotSnapshot();
  if (!status) return null;
  const awake = status.awake.held
    ? "The Mac stays awake until it ends."
    : status.awake.error
      ? `Couldn't keep the Mac awake: ${status.awake.error}`
      : status.awake.supported
        ? "Keeping the Mac awake…"
        : "This computer can't be kept awake from here.";
  const relaunch = status.relaunch.installed
    ? "If the app crashes, it reopens within a minute."
    : (status.relaunch.reason ?? "Reopen after a crash: starting…");
  return (
    <p className="px-1 text-[12px] leading-5 text-content/55" data-autopilot-keeps-going>
      {awake} {relaunch}
    </p>
  );
}

function SwitchRow({ line }: { line: SwitchLine }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex items-start gap-3 rounded-lg border border-stroke px-3 py-2.5 hub-fade-in" data-autopilot-on={line.scope}>
      <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-accent" />
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium text-content">{line.text}</p>
        <p className="text-[12px] leading-5 text-content/60">{line.remaining} · {line.setBy}</p>
        {error ? (
          <p role="alert" className="text-[12px] leading-5 text-content/70">
            Couldn't turn it off: {error}
          </p>
        ) : null}
      </div>
      <TurnOff scopes={[line.scope]} onError={setError} />
    </div>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Ends a switch. A failure is said, and the screen reads the store again so it shows what is really on. */
function TurnOff({ scopes, onError }: { scopes: string[]; onError: (error: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      className={QUIET}
      onClick={() => {
        const backend = autopilotBackend();
        if (!backend) return;
        setBusy(true);
        onError(null);
        void backend
          .off({ scopes, by: "ash", who: "Ash" })
          .then(adoptStatus)
          .catch((e: unknown) => {
            onError(message(e));
            void refreshAutopilot();
          })
          .finally(() => setBusy(false));
      }}
    >
      Turn off
    </button>
  );
}

function TurnOn({ projects, on, now }: { projects: { id: string; name: string }[]; on: boolean; now: number }) {
  const presets = useMemo(() => untilPresets(now), [Math.floor(now / 60_000)]);
  const [scopes, setScopes] = useState<string[]>([EVERYTHING]);
  const [until, setUntil] = useState<number | null>(null);
  const [custom, setCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(!on);
  useEffect(() => setOpen(!on), [on]);
  if (!open)
    return (
      <div>
        <button type="button" className={QUIET} onClick={() => setOpen(true)} data-autopilot-change>
          Change the end time or add a project
        </button>
      </div>
    );
  const toggle = (id: string) => {
    if (id === EVERYTHING) return setScopes([EVERYTHING]);
    const rest = scopes.filter((s) => s !== EVERYTHING);
    const next = rest.includes(id) ? rest.filter((s) => s !== id) : [...rest, id];
    setScopes(next.length ? next : [EVERYTHING]);
  };
  const chosen = until ?? presets[presets.length - 1]?.ms ?? now + 8 * 3_600_000;
  const turnOn = () => {
    const backend = autopilotBackend();
    if (!backend) return;
    setBusy(true);
    setError(null);
    void backend
      .set({ scopes, untilMs: chosen, by: "ash", who: "Ash" })
      .then((next) => {
        adoptStatus(next);
        setUntil(null);
        setCustom(false);
      })
      .catch((e: unknown) => setError(message(e)))
      .finally(() => setBusy(false));
  };
  const chip = (selected: boolean) => `${CHIP} ${selected ? "bg-content/12 text-content" : "bg-content/5 text-content/70 hover:bg-content/10"}`;
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-content/[0.03] px-3 py-3" data-autopilot-turn-on>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-12 text-[12px] text-content/55">For</span>
        <button type="button" className={chip(scopes.includes(EVERYTHING))} aria-pressed={scopes.includes(EVERYTHING)} onClick={() => toggle(EVERYTHING)}>
          Everything
        </button>
        {projects.map((p) => (
          <button key={p.id} type="button" className={chip(scopes.includes(p.id))} aria-pressed={scopes.includes(p.id)} onClick={() => toggle(p.id)}>
            {p.name}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-12 text-[12px] text-content/55">Until</span>
        {presets.map((p) => (
          <button key={p.label} type="button" className={chip(!custom && chosen === p.ms)} aria-pressed={!custom && chosen === p.ms} onClick={() => { setCustom(false); setUntil(p.ms); }}>
            {p.label}
          </button>
        ))}
        {custom ? (
          <input
            type="datetime-local"
            aria-label="End time"
            value={localInput(chosen)}
            min={localInput(now + 60_000)}
            onChange={(e) => {
              const ms = new Date(e.target.value).getTime();
              if (Number.isFinite(ms)) setUntil(ms);
            }}
            className="rounded-md bg-content/5 px-2 py-1 text-[12px] text-content outline-none"
          />
        ) : (
          <button type="button" className={chip(false)} onClick={() => setCustom(true)}>
            Another time…
          </button>
        )}
      </div>
      <div className="flex items-center gap-3">
        <button type="button" className={PRIMARY} disabled={busy} onClick={turnOn} data-autopilot-turn-on-button>
          {on ? "Update" : "Turn on"}
        </button>
        <span className="text-[12px] text-content/55">Ends {formatUntil(chosen, now)}</span>
        {on ? (
          <button type="button" className={QUIET} onClick={() => setOpen(false)}>
            Cancel
          </button>
        ) : null}
      </div>
      {error ? <p className="text-[12px] text-content/70">{error}</p> : null}
    </div>
  );
}

function LogSection({ log, now, seenAt, projectName }: { log: LogEntry[]; now: number; seenAt: number; projectName: (id: string) => string }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? log : log.filter((e) => isCall(e) || e.kind === "switch" || e.kind === "relaunch");
  const groups = byDay(shown, now);
  return (
    <section aria-label="Log" data-autopilot-log>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-xs text-content/60">What autopilot decided</h2>
        <button type="button" className="ml-auto text-[11px] text-content/45 hover:text-content/80" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Calls only" : "Show resumes too"}
        </button>
      </div>
      {groups.length ? (
        groups.map((group) => (
          <div key={group.label} className="mb-3">
            <div className="px-2 pb-0.5 text-[11px] text-content/45">{group.label}</div>
            <div className="flex flex-col">
              {group.entries.map((entry) => (
                <LogRow key={entry.id} entry={entry} projectName={projectName} fresh={isCall(entry) && entry.at > seenAt} />
              ))}
            </div>
          </div>
        ))
      ) : (
        <p className="px-2 text-[13px] text-content/50">Nothing yet. Calls show here as agents make them.</p>
      )}
    </section>
  );
}

function LogRow({ entry, projectName, fresh }: { entry: LogEntry; projectName: (id: string) => string; fresh: boolean }) {
  const call = isCall(entry);
  const held = entry.outcome === "held";
  return (
    <div className="group flex items-start gap-3 rounded-md px-2 py-1.5 hover:bg-content/[0.03]" data-autopilot-entry={entry.outcome}>
      <span className="w-10 shrink-0 pt-px text-[12px] tabular-nums text-content/45">{timeLabel(entry.at)}</span>
      <div className="min-w-0 flex-1">
        <p className={`text-[13px] leading-5 ${call ? "text-content" : "text-content/65"}`}>
          {fresh ? <span aria-label="New" className="mr-1.5 inline-block size-1.5 -translate-y-px rounded-full bg-content/60" /> : null}
          {entry.what}
        </p>
        {entry.recommendation && call ? (
          <p className="text-[12px] leading-5 text-content/70">
            {held ? "Its recommendation: " : "→ "}
            {entry.recommendation}
          </p>
        ) : null}
        <p className="text-[11px] leading-4 text-content/45">
          <span className={held ? "text-accent" : undefined}>{outcomeLabel(entry)}</span>
          {entry.who ? ` · ${entry.who}` : ""}
          {entry.project ? ` · ${projectName(entry.project)}` : ""}
          {entry.kind === "switch" && entry.detail ? ` · “${shortDetail(entry.detail)}”` : ""}
        </p>
      </div>
      {entry.chatId ? (
        <button type="button" className={`${QUIET} shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100`} onClick={() => openChat(entry.chatId!)}>
          Open chat
        </button>
      ) : null}
    </div>
  );
}

function AutoResume({ projects }: { projects: { id: string; name: string }[] }) {
  const status = autopilotSnapshot();
  const settings = status?.autoResume;
  const [error, setError] = useState<string | null>(null);
  const set = (input: { default?: boolean; project?: string; value?: boolean | null }) => {
    const backend = autopilotBackend();
    if (!backend) return;
    setError(null);
    void backend
      .setAutoResume(input)
      .then(() => refreshAutopilot())
      .catch((e: unknown) => {
        setError(message(e));
        void refreshAutopilot();
      });
  };
  if (!settings) return null;
  return (
    <section aria-label="Usage limits" data-autopilot-auto-resume>
      <h2 className="mb-1 text-xs text-content/60">Usage limits</h2>
      <div className="flex items-center gap-3 px-2 py-1">
        <span className="min-w-0 flex-1 text-[13px] leading-5 text-content/85">
          Agents resume by themselves when a usage limit resets
          <span className="block text-[12px] text-content/50">Monos, Leads and the work they hand out. They show “Paused until 14:10” meanwhile, and stop after 3 tries in a row.</span>
        </span>
        <Toggle label="Agents resume by themselves" on={settings.default} onChange={(value) => set({ default: value })} />
      </div>
      {error ? (
        <p role="alert" className="px-2 text-[12px] leading-5 text-content/70">
          Couldn't change it: {error}
        </p>
      ) : null}
      {projects.length ? (
        <div className="flex flex-wrap gap-1.5 px-2 pt-1">
          {projects.map((p) => {
            const value = autoResumeOn(settings, p.id);
            const overridden = typeof settings.projects[p.id] === "boolean";
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={value}
                title={overridden ? "Set for this project; click to change" : "Follows the setting above"}
                onClick={() => set({ project: p.id, value: value === settings.default ? !value : null })}
                className={`${CHIP} ${value ? "bg-content/8 text-content/80" : "bg-transparent text-content/45 line-through decoration-content/30"}`}
              >
                {p.name}
              </button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-content/20"}`}
    >
      <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${on ? "left-4.5" : "left-0.5"}`} />
    </button>
  );
}
