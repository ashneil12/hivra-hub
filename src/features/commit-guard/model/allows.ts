import { invoke } from "@tauri-apps/api/core";

/** One line a person allowed. `repo` is the repository's id (a hash), not its path. */
export interface CommitGuardAllow {
  repo: string;
  file: string;
  hash: string;
}

/** Allows the refusal with this id. Called only from a direct click on "Allow this line"; the app keeps what the id names. */
export function allowCommitGuardLine(id: string): Promise<void> {
  return invoke<void>("commit_guard_allow", { id });
}

/** The allows on record, for the Settings list. */
export function listCommitGuardAllows(): Promise<CommitGuardAllow[]> {
  return invoke<CommitGuardAllow[]>("commit_guard_allows");
}

/** Removes one allow. Called only from a direct click on Remove in Settings. */
export function removeCommitGuardAllow(allow: CommitGuardAllow): Promise<void> {
  return invoke<void>("commit_guard_remove", { repo: allow.repo, file: allow.file, hash: allow.hash });
}
