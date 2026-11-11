import { useEffect, useState } from "react";
import {
  AGENT_SANDBOX_DEFAULT,
  AGENT_SANDBOX_DESCRIPTION,
  AGENT_SANDBOX_ENVIRONMENT_NOTE,
  AGENT_SANDBOX_LABEL,
  loadAgentSandbox,
  saveAgentSandbox,
  type AgentSandboxStatus,
} from "../model/agentSandbox";

/**
 * Settings > General: the switch for the macOS agent sandbox. It writes the file the app reads, so a change applies to
 * agents started after it. Nothing is shown off macOS, where the sandbox does not exist.
 */
export function AgentSandboxSetting() {
  const [status, setStatus] = useState<AgentSandboxStatus>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let current = true;
    loadAgentSandbox().then(
      (next) => {
        // An answer that isn't a status leaves the default showing.
        if (current && typeof next?.enabled === "boolean") setStatus(next);
      },
      (reason) => {
        if (current) setError(String(reason));
      },
    );
    return () => {
      current = false;
    };
  }, []);

  if (status && !status.supported) return null;

  const enabled = status?.enabled ?? AGENT_SANDBOX_DEFAULT;
  const locked = !status || status.setByEnvironment || saving;

  const change = async (next: boolean) => {
    setSaving(true);
    setError(undefined);
    try {
      // On a refusal the switch keeps the app's last answer, so it never shows a choice the app did not keep.
      const saved = await saveAgentSandbox(next);
      if (typeof saved?.enabled === "boolean") setStatus(saved);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      id="setting-agent-sandbox"
      data-setting-id="agent-sandbox"
      className="settings-row flex items-start gap-6 border-b border-content/5 px-4 py-3.5 last:border-b-0"
    >
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-content">{AGENT_SANDBOX_LABEL}</div>
        <p className="mt-1 text-[12px] leading-relaxed text-content/45">{AGENT_SANDBOX_DESCRIPTION}</p>
        {status?.setByEnvironment && (
          <p className="mt-1 text-[12px] leading-relaxed text-content/65">{AGENT_SANDBOX_ENVIRONMENT_NOTE}</p>
        )}
        {error && <p className="mt-1 break-words text-[12px] text-red-400">{error}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-label={AGENT_SANDBOX_LABEL}
        aria-checked={enabled}
        disabled={locked}
        onClick={() => void change(!enabled)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          enabled ? "bg-accent" : "bg-content/20"
        }`}
      >
        <span
          className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${
            enabled ? "left-4.5" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}
