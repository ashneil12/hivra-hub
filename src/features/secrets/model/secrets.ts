// WP-92: the Secrets page's door to the vault (src-tauri/src/secrets/commands.rs).
//
// A value goes in on the person's Save, and comes back out only from `secrets_reveal`, on a tap. Everything else here
// moves handles: name, label, scope, last four, approvals, .env files. Nothing in this module writes to
// localStorage, sessionStorage or IndexedDB.
import { invoke } from "@tauri-apps/api/core";

export type SecretRow = {
  scope: string;
  name: string;
  label: string;
  last4: string | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  version: number;
  approved: string[];
  executables: string[];
  envFiles: string[];
  needsValue: boolean;
};

export type RequestRow = {
  id: string;
  chat: string;
  mono: string | null;
  project: string | null;
  scope: string;
  name: string;
  why: string;
  state: "open" | "saving" | "filled" | "declined" | "expired" | string;
  createdAt: number;
  updatedAt: number;
};

export type GrantRow = {
  scope: string;
  name: string;
  subjectKind: "mono" | "project" | string;
  subjectId: string;
  executable: string;
  mode: "once" | "always" | string;
  createdAt: number;
};

/** A `.env` the app left as it was, and why, in plain words. */
export type RefusedFile = { worktree: string; why: string };
export type RotateReport = {
  secret: SecretRow;
  updated: string[];
  leftAlone: string[];
  envFiles: string[];
  /** `.env` files a re-check refused (now tracked, no longer ignored, now a link). */
  refused?: RefusedFile[];
  /** Updated files that other accounts on this Mac can read. */
  shared?: string[];
};
export type DeleteReport = {
  removedGrants: number;
  removedEnvLines: string[];
  keychainKept: boolean;
  /** `.env` lines the app left, and why. */
  envLeft?: RefusedFile[];
};
/** What writing a `.env` tells the person besides "done". */
export type EnvWriteReport = { readableByOthers: boolean };
export const SHARED_FILE_NOTE = "This file can be read by other accounts on this Mac.";
export type SaveTicket = { request: RequestRow; token: string };

/** `secrets.request`': a handle when the name already resolves, or the open request (a card). */
export type RequestOutcome = { secret: SecretRow | null; request: RequestRow | null };

export type RunInput = {
  chat: string;
  mono?: string;
  project?: string;
  name: string;
  env: string;
  command: string[];
  cwd?: string;
  timeoutSeconds?: number;
};

/** `secrets.run`'s answer: missing, waiting for the person, refused, or the one signed grant. */
export type RunOutcome =
  | { state: "missing"; name: string; scope: string }
  | { state: "waiting"; decisionKey: string; name: string; scope: string }
  | { state: "denied"; decisionKey: string; name: string }
  | {
      state: "granted";
      grant: string;
      scope: string;
      name: string;
      version: number;
      env: string;
      timeoutSeconds: number;
    };

const COMMAND = "plugin:hub|";

/** The slug the vault will store for a name shown on the card. Pure, so the card can show it before typing. */
export function slugOf(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[ _]/g, "-");
}

/** Whether a typed name is one the vault accepts (the Rust rule, mirrored for the card's hint only). */
export function slugIsValid(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62})?[a-z0-9]$/.test(slugOf(name)) || /^[a-z0-9]$/.test(slugOf(name));
}

export function listSecrets(): Promise<SecretRow[]> {
  return invoke(`${COMMAND}secrets_list`);
}

export function listRequests(): Promise<RequestRow[]> {
  return invoke(`${COMMAND}secrets_requests`);
}

export function saveNew(scope: string, name: string, label: string | null, value: string): Promise<SecretRow> {
  return invoke(`${COMMAND}secrets_save_new`, { scope, name, label, value });
}

export function beginSave(id: string): Promise<SaveTicket> {
  return invoke(`${COMMAND}secrets_begin_save`, { id });
}

/** The card's Save: the value is passed once, straight to Rust, and never put in state that outlives the card. */
export function saveRequest(id: string, token: string, label: string | null, value: string): Promise<SecretRow> {
  return invoke(`${COMMAND}secrets_save`, { id, token, label, value });
}

export function declineRequest(id: string, token: string | null): Promise<void> {
  return invoke(`${COMMAND}secrets_decline`, { id, token });
}

export function renameSecret(scope: string, name: string, label: string, version: number): Promise<SecretRow> {
  return invoke(`${COMMAND}secrets_rename`, { scope, name, label, version });
}

/** Rotate: the new value, and, only on the person's tap, the `.env` lines that still hold the old one. */
export function rotateSecret(
  scope: string,
  name: string,
  label: string | null,
  value: string,
  updateEnv = false,
): Promise<RotateReport> {
  return invoke(`${COMMAND}secrets_rotate`, { scope, name, label, value, updateEnv });
}

/** `app secrets.request`: a card, or the handle when the name already resolves. */
export function requestSecret(input: {
  chat: string;
  mono?: string;
  project?: string;
  name: string;
  why: string;
}): Promise<RequestOutcome> {
  return invoke(`${COMMAND}secrets_request`, { input });
}

/** `app secrets.run`: the checks, the approval card, then one signed grant (spent by `monocode secret-run`). */
export function grantFor(request: RunInput): Promise<RunOutcome> {
  return invoke(`${COMMAND}secrets_grant`, { request });
}

/** The `.env` files that hold a secret: the rotate card's "update the files that hold it". */
export function envFilesFor(
  scope: string,
  name: string,
): Promise<{ scope: string; name: string; worktree: string; envName: string; writtenAt: number }[]> {
  return invoke(`${COMMAND}secrets_env_files`, { scope, name });
}

export function deleteSecret(scope: string, name: string): Promise<DeleteReport> {
  return invoke(`${COMMAND}secrets_delete`, { scope, name });
}

/** The one command in the app that returns a value. */
export function revealSecret(scope: string, name: string): Promise<string> {
  return invoke(`${COMMAND}secrets_reveal`, { scope, name });
}

export function grantsFor(scope: string, name: string): Promise<GrantRow[]> {
  return invoke(`${COMMAND}secrets_grants`, { scope, name });
}

export function revokeGrant(
  scope: string,
  name: string,
  subjectKind: string,
  subjectId: string,
  executable: string | null,
): Promise<number> {
  return invoke(`${COMMAND}secrets_revoke_grant`, { scope, name, subjectKind, subjectId, executable });
}

export function writeEnv(
  project: string,
  worktree: string,
  scope: string,
  name: string,
  envName: string,
): Promise<EnvWriteReport> {
  return invoke(`${COMMAND}secrets_env_write`, { project, worktree, scope, name, envName });
}

export function removeEnv(input: {
  project: string;
  worktree: string;
  scope: string;
  name: string;
  envName: string;
}): Promise<boolean> {
  return invoke(`${COMMAND}secrets_env_remove`, { input });
}

/** The label and the warning beside the setting, and the same warning under the "Always" buttons on a card. */
export const ANY_CODE_LABEL = "Let me choose 'Always' for programs that can run any code";
export const ANY_CODE_WARNING =
  "'Always' lets an agent use this key for anything, without asking you. Leave this off unless you are sure.";

export type AlwaysSetting = { on: boolean; removedGrants: number };

/** Whether "Always" may be picked for a program that can run any code. One value per install; off unless turned on. */
export function getAlwaysForAnyCode(): Promise<boolean> {
  return invoke(`${COMMAND}secrets_always_for_any_code`);
}

/** Turning it off also takes back the "Always" approvals it had allowed for such programs. */
export function setAlwaysForAnyCode(on: boolean): Promise<AlwaysSetting> {
  return invoke(`${COMMAND}secrets_set_always_for_any_code`, { on });
}

export function slug(name: string): Promise<string> {
  return invoke(`${COMMAND}secrets_slug`, { name });
}

/** Where a secret is, in plain words: "Everywhere", or "Project: <folder name>". */
export function scopeLabel(scope: string): string {
  if (scope === "global") return "Everywhere";
  const id = scope.startsWith("project.") ? scope.slice("project.".length) : scope;
  const name = id.split(/[\\/]/).filter(Boolean).pop() ?? id;
  return `Project: ${name}`;
}

/** The scope a project's own copy of a key lives in. */
export function projectScope(project: string): string {
  return `project.${project}`;
}

const PROJECT_COPY_USED = "This project's copy is used; there is also one for everywhere.";
const PROJECT_COPY_OVERRIDES = "Projects that have their own copy of this name use that one instead.";

/** A row's key, as the page and these notes name it. */
export function rowKey(row: Pick<SecretRow, "scope" | "name">): string {
  return `${row.scope}\u0000${row.name}`;
}

/**
 * When a name is saved both for everywhere and for a project, a run in that project uses the project's copy. These are
 * the sentences that say so, one per row that has a same-named twin, keyed by [`rowKey`].
 */
export function copyNotes(rows: readonly Pick<SecretRow, "scope" | "name">[]): Map<string, string> {
  const notes = new Map<string, string>();
  const everywhere = new Set(rows.filter((row) => row.scope === "global").map((row) => row.name));
  const inProjects = new Set(rows.filter((row) => row.scope !== "global").map((row) => row.name));
  for (const row of rows) {
    if (row.scope === "global" && inProjects.has(row.name)) notes.set(rowKey(row), PROJECT_COPY_OVERRIDES);
    if (row.scope !== "global" && everywhere.has(row.name)) notes.set(rowKey(row), PROJECT_COPY_USED);
  }
  return notes;
}

/** Who a grant covers, in plain words. */
export function grantLabel(grant: GrantRow): string {
  return grant.subjectKind === "project"
    ? `This project (${grant.subjectId.split(/[\\/]/).filter(Boolean).pop() ?? grant.subjectId})`
    : grant.subjectId;
}

/** A row's date, as a person reads it. */
export function dayOf(millis: number | null): string {
  if (!millis) return "never";
  return new Date(millis).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** The last four, or "no hints" when the value is short. */
export function last4Label(last4: string | null): string {
  return last4 ? `ends ${last4}` : "no last four";
}