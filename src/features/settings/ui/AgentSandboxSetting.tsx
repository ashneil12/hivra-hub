import { useEffect, useState } from "react";
import {
  AGENT_SANDBOX_DEFAULT,
  AGENT_SANDBOX_DESCRIPTION,
  AGENT_SANDBOX_DETAILS,
  AGENT_SANDBOX_ENVIRONMENT_NOTE,
  AGENT_SANDBOX_LABEL,
  loadAgentSandbox,
  saveAgentSandbox,
  type AgentSandboxStatus,
} from "../model/agentSandbox";
import { SettingRow, SettingSwitch } from "./SettingRow";

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
    <SettingRow
      id="agent-sandbox"
      label={AGENT_SANDBOX_LABEL}
      description={AGENT_SANDBOX_DESCRIPTION}
      details={AGENT_SANDBOX_DETAILS.map((paragraph, at) => (
        <p key={at} className={at ? "mt-1.5" : undefined}>
          {paragraph}
        </p>
      ))}
      below={
        <>
          {status?.setByEnvironment && (
            <p className="mt-1 text-[12px] leading-relaxed text-content/65">{AGENT_SANDBOX_ENVIRONMENT_NOTE}</p>
          )}
          {error && <p className="mt-1 break-words text-[12px] text-red-400">{error}</p>}
        </>
      }
    >
      <SettingSwitch label={AGENT_SANDBOX_LABEL} on={enabled} disabled={locked} onChange={(next) => void change(next)} />
    </SettingRow>
  );
}
