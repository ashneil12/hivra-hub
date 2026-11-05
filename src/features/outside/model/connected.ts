// Settings → Connected apps (WP-79). The commands live in src-tauri/src/outside.
// Tauri is imported only when a command runs, so a browser test never loads it.

export type DoorStatus = {
  enabled: boolean;
  url: string | null;
  /** Why the door isn't listening. Missing means it started, or it was left off. */
  problem?: string | null;
  /** The saved port is in use. Offer to pick another. */
  portTaken?: boolean;
};

export type GrantView = {
  id: string;
  clientName: string;
  projects: string[];
  write: boolean;
  lastUsedAt: number | null;
};

export type PendingRequest = {
  id: string;
  clientName: string;
};

export type ProjectChoice = {
  id: string;
  name: string;
};

export type PendingPage = {
  requests: PendingRequest[];
  projects: ProjectChoice[];
};

export type ConsentResult = {
  redirectUri: string;
};

export type OutsideApi = {
  status: () => Promise<DoorStatus>;
  setEnabled: (enabled: boolean) => Promise<DoorStatus>;
  grants: () => Promise<GrantView[]>;
  disconnect: (id: string) => Promise<boolean>;
  pending: () => Promise<PendingPage>;
  approve: (
    requestId: string,
    projectIds: string[],
    write: boolean,
  ) => Promise<ConsentResult>;
  deny: (requestId: string) => Promise<ConsentResult>;
  /** Bind a different port. Only meaningful when `portTaken` is set. */
  pickNewPort: () => Promise<DoorStatus>;
};

/** What the person allowed this connection to do. */
export function accessLabel(write: boolean): string {
  return write ? "Read and task writes" : "Read only";
}

/**
 * When the connection was last used, in UTC, so Chromium and WebKit agree.
 * `0` is a real time. Only a missing value means the connection is unused.
 */
export function lastUsedLabel(at: number | null): string {
  if (at == null) return "Not used yet";
  return new Date(at).toISOString().slice(0, 16).replace("T", " ");
}

async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(name, args);
}

export const appApi: OutsideApi = {
  status: () => command("outside_status"),
  setEnabled: (enabled) => command("outside_set_enabled", { enabled }),
  grants: () => command("outside_grants"),
  disconnect: (id) => command("outside_disconnect", { id }),
  pending: () => command("outside_pending"),
  approve: (requestId, projectIds, write) =>
    command("outside_approve", { requestId, projectIds, write }),
  deny: (requestId) => command("outside_deny", { requestId }),
  pickNewPort: () => command("outside_pick_new_port"),
};
