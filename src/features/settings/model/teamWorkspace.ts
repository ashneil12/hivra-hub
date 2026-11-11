import { invoke } from "@tauri-apps/api/core";

/**
 * "Share projects with my team" (src-tauri/src/team_workspace.rs). Off until the person turns it on. The app keeps the
 * switch and the server address in its data folder, and the device's workspace token in the Keychain; the window only
 * sees whether a token is held, never the token itself.
 */
export const TEAM_WORKSPACE_DEFAULT = false;

export type TeamWorkspaceStatus = {
  enabled: boolean;
  /** The saved team server address. Not a secret, so the window may show it. */
  endpoint: string;
  endpointConfigured: boolean;
  /** This device holds a workspace token from an accepted invitation. */
  signedIn: boolean;
  /** On, the address passes the rules, and a token is held. Nothing is sent unless this is true. */
  active: boolean;
};

export const loadTeamWorkspace = () => invoke<TeamWorkspaceStatus>("team_workspace_status");

/** Saves the switch and the server address together. A bad address is refused and nothing is written. */
export const saveTeamWorkspace = (enabled: boolean, endpoint: string) =>
  invoke<TeamWorkspaceStatus>("team_workspace_save", { enabled, endpoint });

/** How often the window asks who is checked in, while sharing is active. */
export const PRESENCE_REFRESH_MS = 15_000;

/** The people checked in at the team server, as of the app's last sync round. Empty while the switch is off. */
export const loadTeamPresence = () => invoke<string[]>("team_workspace_presence");

/** Joins with an invitation link the team gave out. Refused while the switch is off. */
export const joinTeamWorkspace = (invitation: string, account: string) =>
  invoke<TeamWorkspaceStatus>("team_workspace_accept", { invitation, account });

/** The words under the switch. Plain, with no path, token or address repeated back. */
export function describeTeamWorkspace(status: TeamWorkspaceStatus): string {
  if (!status.enabled) return "Off. Nothing leaves this computer.";
  if (!status.endpointConfigured) return "On. Add the team server address to start sharing.";
  if (!status.signedIn) return "On. Join with an invitation to start sharing.";
  if (status.active) return "On. Shared projects sync with the team server.";
  return "On, but the team server address is not valid, so nothing is sent.";
}
