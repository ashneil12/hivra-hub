import { useEffect, useState } from "react";
import { SettingRow, SettingSegmented, SettingSwitch, settingButtonClass, settingInputClass } from "../../settings/ui/SettingRow";
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

export const COMPUTER_USE_DESCRIPTION = "Off by default. Lets chats look at apps on this Mac, and use them if you allow.";

/** The full account, shown under More. */
export const COMPUTER_USE_DETAILS: readonly string[] = [
  "Workers and habit runs never get it. Password, keychain, wallet and payment apps and the system's sign-in prompts " +
    "are always refused, whatever you set here.",
  "Claude asks before each step unless a chat has full access. Changes reach a running chat at its next step.",
];

const MODES = [
  { value: "observe" as const, label: "Look only" },
  { value: "control" as const, label: "Look and use" },
];

function when(at: number): string {
  return new Date(at).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });
}

/**
 * Settings > General: computer use (WP-255). One row with the switch; when on, a row each for look only or look and
 * use, the allowed apps, clicking by position, the setup check, each chat with its own say, and the newest activity.
 * Nothing shows off a Mac.
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
    <>
      <SettingRow
        id="computer-use"
        label={COMPUTER_USE_LABEL}
        description={COMPUTER_USE_DESCRIPTION}
        details={COMPUTER_USE_DETAILS.map((paragraph, at) => (
          <p key={at} className={at ? "mt-1.5" : undefined}>
            {paragraph}
          </p>
        ))}
        below={
          <>
            {view && !view.sidecar && (
              <p className="mt-1 text-[12px] leading-relaxed text-content/65">
                Needs the helper: <code className="font-mono">{COMPUTER_USE_INSTALL}</code>
              </p>
            )}
            {error && <p className="mt-1 break-words text-[12px] text-red-400">{error}</p>}
          </>
        }
      >
        <SettingSwitch label={COMPUTER_USE_LABEL} on={enabled} disabled={!view || saving} onChange={(on) => void save({ enabled: on })} />
      </SettingRow>
      {enabled && settings && (
        <>
          <SettingRow label="What chats may do">
            <SettingSegmented label="What chats may do" value={settings.mode} options={MODES} disabled={saving} onChange={(mode) => void save({ mode })} />
          </SettingRow>
          <SettingRow label="Allowed apps" description="Empty means any app except the blocked ones.">
            <input
              aria-label="Allowed apps"
              value={appsText}
              onChange={(event) => setAppsText(event.target.value)}
              onBlur={() => {
                const apps = splitApps(appsText);
                if (apps.join("\n") !== settings.allowedApps.join("\n")) void save({ allowedApps: apps });
              }}
              placeholder="Notes, Safari"
              className={`w-48 ${settingInputClass}`}
            />
          </SettingRow>
          {settings.mode === "control" && (
            <SettingRow label="Click by position" description="Click a spot in a screenshot, not only a named button.">
              <SettingSwitch label="Click by position" on={settings.allowCoordinates} disabled={saving} onChange={(on) => void save({ allowCoordinates: on })} />
            </SettingRow>
          )}
          <SettingRow
            label="Setup"
            description="Asks macOS for the permissions it needs."
            below={
              check && check !== "running" ? (
                <pre className={`mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-content/5 p-2 font-mono text-[11px] ${check.ok ? "text-content/70" : "text-red-400"}`}>
                  {check.output || (check.ok ? "Ready." : "The check failed.")}
                </pre>
              ) : null
            }
          >
            <button type="button" onClick={() => void runCheck()} disabled={check === "running"} className={settingButtonClass}>
              {check === "running" ? "Checking" : "Check setup"}
            </button>
          </SettingRow>
          {chats.map(([chat, mode]) => (
            <SettingRow key={chat} label={<span className="font-mono text-[12px]">{chat}</span>} description={describeChatMode(mode)}>
              <button type="button" onClick={() => void resetChat(chat)} className={settingButtonClass}>
                Follow Settings
              </button>
            </SettingRow>
          ))}
          <SettingRow
            label="Recent activity"
            below={
              activity.length === 0 ? (
                <p className="mt-1 text-[12px] text-content/60">Nothing yet.</p>
              ) : (
                <ul className="mt-1.5 space-y-1 text-[12px] text-content/70" aria-label="Computer use activity">
                  {activity.map((row, at) => (
                    <li key={`${row.at}-${at}`} className="flex gap-3">
                      <span className="shrink-0 text-content/60">{when(row.at)}</span>
                      <span className="min-w-0 flex-1 truncate">
                        {row.app ? `${row.app}: ` : ""}
                        {row.detail}
                      </span>
                      <span className={`shrink-0 ${row.allowed ? "text-content/60" : "text-red-400"}`}>{row.allowed ? "done" : "refused"}</span>
                    </li>
                  ))}
                </ul>
              )
            }
          />
        </>
      )}
    </>
  );
}
