// WP-92: the vault's three app actions, behind the MCP tools `secrets_request`, `secrets_list` and `secrets_run`.
//
// - The person's app does the checks in Rust (src-tauri/src/secrets): scope resolution, the approval card, the grant.
//   This module only says where the asking chat is: its id, its Mono, and its project.
// - The chat's project comes first, then global. A Mono's own chat has no project, so it asks globally; a chat in a
//   project (or a coding team's chat) asks in that project.
// - No result holds a value. `secrets.list` returns handles, `secrets.request` returns the open request or a handle,
//   and `secrets.run` returns the one signed grant the MCP server spends in `monocode secret-run`.
import { looksLikeProject } from "../../projects/model/recents";
import {
  grantFor,
  listSecrets,
  requestSecret,
  scopeLabel,
  type RequestOutcome,
  type RunOutcome,
  type SecretRow,
} from "../../secrets/model/secrets";
import type { Session } from "../../sessions/model/session";
import type { AgentAppHost } from "./agentApp";
import { forUser } from "../../hub/model/userName";

/** The FIELDS entries of the vault's actions (agentApp.ts). */
export const SECRET_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["secrets.request", ["name", "why"]],
  ["secrets.list", []],
  ["secrets.run", ["name", "env", "command", "cwd", "timeoutSeconds"]],
];

const NAME_MAX = 64;
const WHY_MAX = 2000;
const ENV = /^[A-Z_][A-Z0-9_]{0,63}$/;
const ARGV_MAX = 100;
const ARG_MAX = 4096;

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${field} must be a short line of text`);
  return value.trim();
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  return text(value, field, max);
}

/** `command` is an argv: the program and its arguments, one per element, never a shell line. */
function commandOf(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > ARGV_MAX ||
    !value.every((part) => typeof part === "string" && part.length <= ARG_MAX)
  )
    throw new Error("command must be the program and its arguments, one list element each");
  return value as string[];
}

function timeoutOf(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 600)
    throw new Error("timeoutSeconds must be a whole number of seconds, from 1 to 600");
  return value;
}

/** A worker's keys, as `delegate_task`'s `secrets` names them: at most 3, each into its own variable. */
export type WorkerArmRequest = {
  chat: string;
  mono: string;
  project?: string;
  /** The worker's CLI, which the approvals are for. */
  executable: string;
  secrets: { name: string; env: string }[];
};

export type WorkerArmOutcome =
  | { state: "missing"; name: string; scope: string }
  | { state: "waiting"; decisionKey: string; name: string; scope: string }
  | { state: "denied"; decisionKey: string; name: string }
  | { state: "ready"; secrets: unknown[] };

/** The asking chat, as the vault names it: its id, its Mono, and the project it works in (none for global). */
function where(
  source: Session,
  host: AgentAppHost,
): { chat: string; mono?: string; project?: string } {
  const mono = host.monoOf?.(source.id)?.id ?? host.ownerMonoOf?.(source.id);
  const team = host.codingTeamOf?.(source.id);
  // A Mono's own chat lives outside its projects; it asks globally unless a project session carries it.
  const project = mono
    ? undefined
    : (team?.folder ?? (looksLikeProject(source.cwd) ? source.cwd : undefined));
  return {
    chat: source.id,
    ...(mono ? { mono } : {}),
    ...(project ? { project } : {}),
  };
}

/** One secret as an agent may read it: a handle, never a value. */
function handle(row: SecretRow) {
  return {
    name: row.name,
    label: row.label,
    scope: row.scope,
    scopeWords: scopeLabel(row.scope),
    last4: row.last4,
    addedAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    approved: row.approved,
    envFiles: row.envFiles,
  };
}

async function request(source: Session, input: Record<string, unknown>, host: AgentAppHost) {
  const name = text(input.name, "name", NAME_MAX);
  const why = text(input.why, "why", WHY_MAX);
  const outcome: RequestOutcome = await requestSecret({ ...where(source, host), name, why });
  if (outcome.secret) {
    return {
      state: "found",
      ...handle(outcome.secret),
      note: forUser`It is already saved (${scopeLabel(outcome.secret.scope)}). Use it with secrets_run; its value stays in their keychain and never reaches you.`,
    };
  }
  const row = outcome.request;
  if (!row) throw new Error("The request wasn't saved. Try again.");
  return {
    requestId: row.id,
    state: "waiting",
    name: row.name,
    scope: row.scope,
    note: forUser`Asked. The card waits in their chat and Inbox. Tell them in one line that you need the key, then end your turn; when they save it, a note comes back to you and you run the command then.`,
  };
}

async function list(source: Session, host: AgentAppHost) {
  const rows = await listSecrets();
  const { project } = where(source, host);
  // A chat sees the keys it could actually use: its project's and the global ones.
  const mine = rows.filter((row) => row.scope === "global" || row.scope === `project.${project}`);
  return {
    secrets: mine.map(handle),
    ...(mine.length
      ? { note: forUser`Run one with secrets_run; no tool returns a value.` }
      : { note: forUser`No key is saved yet. Ask for one with secrets_request.` }),
  };
}

async function run(source: Session, input: Record<string, unknown>, host: AgentAppHost) {
  const name = text(input.name, "name", NAME_MAX);
  const env = text(input.env, "env", 64);
  if (!ENV.test(env))
    throw new Error(
      "env must be capital letters, digits and underscores, like STRIPE_API_KEY",
    );
  const command = commandOf(input.command);
  const cwd = optionalText(input.cwd, "cwd", 4096);
  const timeoutSeconds = timeoutOf(input.timeoutSeconds);
  const outcome: RunOutcome = await grantFor({
    ...where(source, host),
    name,
    env,
    command,
    ...(cwd ? { cwd } : {}),
    ...(timeoutSeconds ? { timeoutSeconds } : {}),
  });
  switch (outcome.state) {
    case "missing":
      return {
        ...outcome,
        note: forUser`No key of that name is saved. Call secrets_request with this name and a why, then end your turn.`,
      };
    case "waiting":
      return {
        ...outcome,
        note: forUser`The person hasn't approved this command with the key yet. Tell them in one line what it will run, then end your turn; their answer comes back to you and you can run it again.`,
      };
    case "denied":
      return { ...outcome, note: forUser`They said no. Carry on without the key, or ask again later with the reason you need it.` };
    default: {
      // The app ran the command and answers with the scrubbed result. No grant is passed on: one that somehow arrived is
      // dropped here, never sent back to the agent over the control port.
      const result: Record<string, unknown> = { ...outcome };
      delete result.grant;
      return result;
    }
  }
}

/** The `secrets.*` actions (agentApp.ts dispatches them here after checking their fields). */
export function handleSecrets(
  source: Session,
  action: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
): Promise<unknown> {
  switch (action) {
    case "secrets.request":
      return request(source, input, host);
    case "secrets.list":
      return list(source, host);
    case "secrets.run":
      return run(source, input, host);
  }
  return Promise.reject(new Error(`Unknown app action: ${action}`));
}
