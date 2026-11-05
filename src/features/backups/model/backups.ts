// Settings → Backups (WP-75). The commands live in src-tauri/src/backups. Tauri is imported
// only when a command runs, so a browser test of the page never loads it.

export type BackupSchedule = "off" | "hourly" | "daily";

export type BackupInfo = {
  id: string;
  createdAt: number;
};

export type BackupItem = {
  kind: string;
  id: string;
  title: string;
};

export type BackupsStatus = {
  schedule: BackupSchedule;
  folder: string;
  folderIsDefault: boolean;
  lastGood: BackupInfo | null;
  dev: boolean;
};

const SCHEDULE_LABELS: Record<BackupSchedule, string> = {
  off: "Off",
  hourly: "Hourly",
  daily: "Daily",
};

export function isSchedule(value: string): value is BackupSchedule {
  return value === "off" || value === "hourly" || value === "daily";
}

/** The word Settings shows for a schedule. Anything else falls back to the daily default. */
export function scheduleLabel(schedule: string): string {
  return isSchedule(schedule) ? SCHEDULE_LABELS[schedule] : SCHEDULE_LABELS.daily;
}

/** A restored item always keeps this ending, even when the title already has it. */
export function restoredTitle(title: string): string {
  return `${title} (restored)`;
}

export type SettingsGeneration = {
  generation: number;
  busy: boolean;
};

/** A second click while one settings change is in flight does not start. */
export function claimSettingsChange(state: SettingsGeneration): SettingsGeneration | null {
  if (state.busy) return null;
  return { generation: state.generation + 1, busy: true };
}

/**
 * Paint a settings result only when it is still the latest click. A late result returns null
 * and leaves the newer schedule or folder alone.
 */
export function applySettingsResult<T>(
  state: SettingsGeneration,
  mine: number,
  status: T,
  patch: Partial<T>,
): { state: SettingsGeneration; status: T } | null {
  if (state.generation !== mine) return null;
  return { state: { ...state, busy: false }, status: { ...status, ...patch } };
}

/** Clear the in-flight flag only for the click that set it. */
export function finishSettingsChange(state: SettingsGeneration, mine: number): SettingsGeneration {
  if (state.generation !== mine) return state;
  return { ...state, busy: false };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A UTC date, so Chromium and WebKit show the same backup time. */
export function backupWhen(createdAt: number): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(name, args);
}

export function backupsStatus(): Promise<BackupsStatus> {
  return command("backups_status");
}

export function setBackupSchedule(schedule: BackupSchedule): Promise<void> {
  return command("backups_set_schedule", { schedule });
}

export function setBackupFolder(folder: string | null): Promise<void> {
  return command("backups_set_folder", { folder });
}

export function createBackup(): Promise<BackupInfo> {
  return command("backups_create");
}

export function listBackups(): Promise<BackupInfo[]> {
  return command("backups_list");
}

export function backupItems(id: string): Promise<BackupItem[]> {
  return command("backups_items", { id });
}

export function restoreBackupItem(id: string, kind: string, itemId: string): Promise<BackupItem> {
  return command("backups_restore_item", { id, kind, itemId });
}

export function restoreBackupAll(id: string): Promise<void> {
  return command("backups_restore_all", { id });
}

/** The folder picker. Null when the person cancels. */
export async function pickBackupFolder(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title: "Backup folder" });
  return typeof picked === "string" && picked.length > 0 ? picked : null;
}
