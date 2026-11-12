import { useEffect, useState } from "react";
import {
  COMPUTER_USE_INSTALL,
  checkComputerUse,
  describeChatMode,
  loadComputerUse,
  loadComputerUseActivity,
  saveComputerUse,
  setChatComputerUse,
  splitApps,
  type ComputerUseActivity,
  type ComputerUseChange,
  type ComputerUseView,
} from "../model/computerUse";

export const COMPUTER_USE_LABEL = "Computer use";

export const COMPUTER_USE_DESCRIPTION =
  "Off by default. When on, the chats you talk to can look at apps on this Mac and, if you choose Look and use, click " +
  "and type in them. Workers and habit runs never get it. Password, keychain, wallet and payment apps and the system's " +
  "sign-in prompts are always refused, whatever you set here. Claude asks before each step unless a chat has full " +
  "access. Changes reach a running chat at its next step.";

const switchClass = (on: boolean) =>
  `relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
    on ? "bg-accent" : "bg-content/20"
  }`;

function Switch({ label, on, disabled, onChange }: { label: string; on: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-label={label} aria-checked={on} disabled={disabled} onClick={() => onChange(!on)} className={switchClass(on)}>
      <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${on ? "left-4.5" : "left-0.5"}`} />
    </button>
  );
}

function when(at: number): string {
  return new Date(at).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });
}

/**
 * Settings > General: computer use (WP-255). The switch, look only or look and use, the allowed apps, clicking by
 * position, the setup check, the chats with their own say, and the newest activity. Nothing shows off a Mac.
 */
export function ComputerUseSetting() {
  const [view, setView] = useState<ComputerUseView>();
  const [appsText, setAppsText] = useState("");
  const [activity, setActivity] = useState<ComputerUseActivity[]>([]);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; output: string } | "running">();

  useEffect(() => {
    let live = true;
    void loadComputerUse().then((next) => {
      if (!live || !next) return;
      setView(next);
      setAppsText(next.settings.allowedApps.join(", "));
    });
    void loadComputerUseActivity(10).then(
      (rows) => live && Array.isArray(rows) && setActivity(rows),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  if (view && !view.supported) return null;
  const settings = view?.settings;
  const enabled = settings?.enabled ?? false;

  const save = async (patch: Partial<ComputerUseChange>) => {
    if (!settings) return;
    setSaving(true);
    setError(undefined);
    try {
      const next = await saveComputerUse({
        enabled: settings.enabled,
        mode: settings.mode,
        allowedApps: settings.allowedApps,
        allowCoordinates: settings.allowCoordinates,
        ...patch,
      });
      setView(next);
      setAppsText(next.settings.allowedApps.join(", "));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  const runCheck = async () => {
    setCheck("running");
    try {
      setCheck(await checkComputerUse());
    } catch (reason) {
      setCheck({ ok: false, output: String(reason) });
    }
  };

  const resetChat = async (chat: string) => {
    try {
      setView(await setChatComputerUse(chat, null));
    } catch (reason) {
      setError(String(reason));
    }
  };

  const chats = Object.entries(settings?.chats ?? {});

  return (
    <div id="setting-computer-use" data-setting-id="computer-use" className="settings-row border-b border-content/5 px-4 py-3.5 last:border-b-0">
      <div className="flex items-start gap-6">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-content">{COMPUTER_USE_LABEL}</div>
          <p className="mt-1 text-[12px] leading-relaxed text-content/45">{COMPUTER_USE_DESCRIPTION}</p>
          {view && !view.sidecar && (
            <p className="mt-1 text-[12px] leading-relaxed text-content/65">
              It needs the open-computer-use helper. Install it in Terminal with <code className="font-mono">{COMPUTER_USE_INSTALL}</code>, then press Check setup.
            </p>
          )}
          {error && <p className="mt-1 break-words text-[12px] text-red-400">{error}</p>}
        </div>
        <Switch label={COMPUTER_USE_LABEL} on={enabled} disabled={!view || saving} onChange={(on) => void save({ enabled: on })} />
      </div>
      {enabled && settings && (
        <div className="mt-3 space-y-3 text-[12px] text-content/70">
          <div className="flex items-center gap-2" role="radiogroup" aria-label="What chats may do">
            {(
              [
                ["observe", "Look only"],
                ["control", "Look and use"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={settings.mode === mode}
                disabled={saving}
                onClick={() => void save({ mode })}
                className={`rounded-md border px-2.5 py-1 ${settings.mode === mode ? "border-accent bg-accent/10 text-content" : "border-content/10 text-content/60"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="block">
            <span className="block text-content/60">Allowed apps (empty means any app but the blocked ones)</span>
            <input
              aria-label="Allowed apps"
              value={appsText}
              onChange={(event) => setAppsText(event.target.value)}
              onBlur={() => {
                const apps = splitApps(appsText);
                if (apps.join("\n") !== settings.allowedApps.join("\n")) void save({ allowedApps: apps });
              }}
              placeholder="Notes, Safari"
              className="mt-1 w-full rounded-md border border-content/10 bg-transparent px-2 py-1 text-content"
            />
          </label>
          {settings.mode === "control" && (
            <div className="flex items-center justify-between gap-4">
              <span>Click by position in a screenshot, not only by element</span>
              <Switch label="Click by position" on={settings.allowCoordinates} disabled={saving} onChange={(on) => void save({ allowCoordinates: on })} />
            </div>
          )}
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void runCheck()} disabled={check === "running"} className="shrink-0 whitespace-nowrap rounded-md border border-content/10 px-2.5 py-1 text-content">
              {check === "running" ? "Checking" : "Check setup"}
            </button>
            <span className="text-content/45">Asks macOS for Accessibility and Screen Recording if they are missing.</span>
          </div>
          {check && check !== "running" && (
            <pre className={`max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-content/5 p-2 font-mono text-[11px] ${check.ok ? "text-content/70" : "text-red-400"}`}>
              {check.output || (check.ok ? "Ready." : "The check failed.")}
            </pre>
          )}
          {chats.length > 0 && (
            <div>
              <div className="text-content/60">Chats with their own say</div>
              <ul className="mt-1 space-y-1">
                {chats.map(([chat, mode]) => (
                  <li key={chat} className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-[11px]">{chat}</span>
                    <span className="shrink-0">{describeChatMode(mode)}</span>
                    <button type="button" onClick={() => void resetChat(chat)} className="shrink-0 text-accent">
                      Follow Settings
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <div className="text-content/60">Recent activity</div>
            {activity.length === 0 ? (
              <p className="mt-1 text-content/45">Nothing yet.</p>
            ) : (
              <ul className="mt-1 space-y-1" aria-label="Computer use activity">
                {activity.map((row, at) => (
                  <li key={`${row.at}-${at}`} className="flex gap-2">
                    <span className="shrink-0 text-content/45">{when(row.at)}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {row.app ? `${row.app}: ` : ""}
                      {row.detail}
                    </span>
                    <span className={`shrink-0 ${row.allowed ? "text-content/45" : "text-red-400"}`}>{row.allowed ? "done" : "refused"}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
