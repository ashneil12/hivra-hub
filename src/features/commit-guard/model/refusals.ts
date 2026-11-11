import { invoke } from "@tauri-apps/api/core";

/** A refusal as the app recorded it. The banner shows these fields, never the text of the refusal. */
export interface CommitGuardRefusalView {
  id: string;
  folder: string;
  file: string;
  line: number;
  commit: string;
  /** WP-248: the refusal is for a whole tracked approvals file, not one line. */
  wholeFile?: boolean;
}

/** The app's record of a refusal, or null when it holds none. */
export function getCommitGuardRefusal(id: string): Promise<CommitGuardRefusalView | null> {
  return invoke<CommitGuardRefusalView | null>("commit_guard_refusal", { id });
}
