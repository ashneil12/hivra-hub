import { useEffect, useState } from "react";
import {
  describeTeamWorkspace,
  joinTeamWorkspace,
  loadTeamPresence,
  loadTeamWorkspace,
  PRESENCE_REFRESH_MS,
  saveTeamWorkspace,
  TEAM_WORKSPACE_DEFAULT,
  type TeamWorkspaceStatus,
} from "../model/teamWorkspace";

/**
 * Settings: "Share projects with my team". Off until the person turns it on. Turning it on sends nothing by itself:
 * a shared project only goes out once the team server address is saved and an invitation has been accepted.
 * The rules are in src-tauri/src/team_workspace.rs.
 */
export function TeamWorkspaceSetting() {
  const [status, setStatus] = useState<TeamWorkspaceStatus>();
  const [enabled, setEnabled] = useState(TEAM_WORKSPACE_DEFAULT);
  const [address, setAddress] = useState("");
  const [invitation, setInvitation] = useState("");
  const [account, setAccount] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [people, setPeople] = useState<string[]>([]);
  const active = status?.active === true;

  // Who is checked in is read from the server's presence list, only while sharing is active.
  useEffect(() => {
    if (!active) {
      setPeople([]);
      return;
    }
    let current = true;
    const look = () =>
      loadTeamPresence().then(
        (list) => {
          if (current && Array.isArray(list)) setPeople(list);
        },
        () => undefined,
      );
    void look();
    const timer = window.setInterval(() => void look(), PRESENCE_REFRESH_MS);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [active]);

  useEffect(() => {
    let current = true;
    loadTeamWorkspace().then(
      (next) => {
        // An answer that isn't a status leaves the default showing.
        if (!current || typeof next?.enabled !== "boolean") return;
        setStatus(next);
        setEnabled(next.enabled);
        setAddress(next.endpoint ?? "");
      },
      (reason) => {
        if (current) setError(String(reason));
      },
    );
    return () => {
      current = false;
    };
  }, []);

  const apply = (next: TeamWorkspaceStatus) => {
    setStatus(next);
    setEnabled(next.enabled);
    setAddress(next.endpoint ?? "");
  };

  // The switch keeps the saved address, so turning it off and on again does not lose it.
  const change = async (next: boolean) => {
    setEnabled(next);
    setBusy(true);
    setError(undefined);
    try {
      const saved = await saveTeamWorkspace(next, status?.endpoint ?? "");
      if (typeof saved?.enabled === "boolean") apply(saved);
    } catch (reason) {
      setEnabled(!next);
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAddress = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const saved = await saveTeamWorkspace(enabled, address.trim());
      if (typeof saved?.enabled === "boolean") apply(saved);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await joinTeamWorkspace(invitation.trim(), account.trim());
      if (typeof next?.enabled === "boolean") apply(next);
      // The invitation is spent once used, so it is not kept on the screen.
      setInvitation("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const canJoin =
    !busy &&
    !!status?.enabled &&
    !!status?.endpointConfigured &&
    invitation.trim() !== "" &&
    account.trim() !== "";

  return (
    <div
      id="setting-team-workspace"
      data-setting-id="team-workspace"
      className="flex flex-col gap-2 text-[13px]"
    >
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={enabled}
          disabled={busy || !status}
          onChange={(event) => void change(event.target.checked)}
        />
        <span>Share projects with my team</span>
      </label>
      <p className="pl-6 text-[12px] text-content/50">
        {status ? describeTeamWorkspace(status) : "Checking the setting."}
      </p>
      {people.length > 0 && (
        <p className="pl-6 text-[12px] text-content/65">Here now: {people.join(", ")}</p>
      )}

      <div className="flex flex-col gap-1.5 pl-6">
        <label className="text-[12px] text-content/65" htmlFor="team-workspace-address">
          Team server address
        </label>
        <div className="flex gap-2">
          <input
            id="team-workspace-address"
            aria-label="Team server address"
            className="min-w-0 flex-1 rounded border border-white/10 bg-transparent px-2 py-1"
            placeholder="https://"
            value={address}
            disabled={busy || !status}
            onChange={(event) => setAddress(event.target.value)}
          />
          <button
            type="button"
            className="rounded border border-white/10 px-2 py-1"
            disabled={busy || !status || address.trim() === (status?.endpoint ?? "")}
            onClick={() => void saveAddress()}
          >
            Save
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 pl-6">
        <p className="text-[12px] text-content/65">Join with an invitation from your team</p>
        <input
          aria-label="Invitation code"
          className="rounded border border-white/10 bg-transparent px-2 py-1"
          value={invitation}
          disabled={busy || !status?.enabled}
          onChange={(event) => setInvitation(event.target.value)}
        />
        <input
          aria-label="Your name"
          className="rounded border border-white/10 bg-transparent px-2 py-1"
          value={account}
          disabled={busy || !status?.enabled}
          onChange={(event) => setAccount(event.target.value)}
        />
        <button
          type="button"
          className="self-start rounded border border-white/10 px-2 py-1"
          disabled={!canJoin}
          onClick={() => void join()}
        >
          Join
        </button>
      </div>

      {error && (
        <p className="break-words pl-6 text-[12px] text-red-400">{error}</p>
      )}
    </div>
  );
}
