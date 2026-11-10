// WP-104: the Settings health list. Sentences are decided here from facts a caller hands in, so a test
// never needs a real machine, a CLI, or a network.

export const HEALTH_REFRESH_MS = 15 * 60 * 1000;
export const LOW_DISK_BYTES = 2 * 1024 * 1024 * 1024;

export type HealthTone = "ok" | "check" | "problem";

export type HealthRow = {
  id: string;
  tone: HealthTone;
  text: string;
};

export type CliHealth = {
  id: string;
  name: string;
  /** Null when the existing probe did not finish, so a miss is not reported as "not installed". */
  installed: boolean | null;
  /** Null when this app has no sign-in check for that CLI, or the check did not finish. */
  signedIn: boolean | null;
};

export type GitHealth =
  | { state: "ok"; version: string | null }
  | { state: "missing" }
  | { state: "unread" };

export type GatewayState = "answered" | "timedOut" | "down" | "refused";

export type GatewayHealth = {
  name: string;
  state: GatewayState;
};

export type HealthFacts = {
  clis: readonly CliHealth[];
  git: GitHealth;
  diskFreeBytes: number | null;
  database: "ok" | "problem" | "unread";
  dataWritable: boolean | null;
  plugins: "readable" | "missing" | "unreadable" | "unread";
  /** Epoch milliseconds of the newest backup, or null when there are none. */
  lastBackupAt: number | null;
  now: number;
  gateway: GatewayHealth | null;
};

const TONE_LABEL: Record<HealthTone, string> = {
  ok: "OK",
  check: "Check this",
  problem: "Problem",
};

const CLI_ID = /^[a-z][a-z0-9_-]{0,20}$/;
const GIT_VERSION = /^git version \d[\w.+-]{0,40}$/;
const SIGN_IN_IDS = new Set(["claude", "codex"]);

export function healthLine(row: HealthRow): string {
  return `${TONE_LABEL[row.tone]}. ${row.text}`;
}

export function toneLabel(tone: HealthTone): string {
  return TONE_LABEL[tone];
}

function words(value: string, fallback: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return (flat || fallback).slice(0, 80);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A non-negative finite number, or null when the value cannot be trusted. */
function bytes(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function when(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * The first configured custom model that has an address. No row and no request when this is null.
 * A blank address is skipped. The name is flattened so it cannot break a line.
 */
export function configuredEndpoint(
  models: readonly { name?: unknown; baseUrl?: unknown }[],
): { name: string; url: string } | null {
  for (const model of models) {
    const url = typeof model.baseUrl === "string" ? model.baseUrl.trim() : "";
    if (!url) continue;
    const name = typeof model.name === "string" ? words(model.name, "") : "";
    return { name: name || "That endpoint", url };
  }
  return null;
}

/**
 * One row per CLI the caller lists. A duplicate id keeps the first row. Sign-in is read only for a CLI
 * this app already knows how to check, and only once it is installed.
 */
export async function readCliHealth(
  harnesses: readonly { id: string; name: string }[],
  ports: {
    installed: (id: string) => boolean | null;
    identity: (id: string) => Promise<unknown>;
  },
): Promise<CliHealth[]> {
  const seen = new Set<string>();
  const rows: CliHealth[] = [];
  for (const harness of harnesses) {
    if (!CLI_ID.test(harness.id) || seen.has(harness.id)) continue;
    seen.add(harness.id);
    const installed = ports.installed(harness.id);
    let signedIn: boolean | null = null;
    if (installed === true && SIGN_IN_IDS.has(harness.id)) {
      try {
        signedIn = (await ports.identity(harness.id)) != null;
      } catch {
        signedIn = null;
      }
    }
    rows.push({
      id: harness.id,
      name: words(harness.name, "This CLI"),
      installed: installed === true ? true : installed === false ? false : null,
      signedIn,
    });
  }
  return rows;
}

function gitOf(value: unknown): GitHealth {
  const body = record(value);
  const state = oneOf(body?.state, ["ok", "missing", "unread"] as const);
  if (state === "missing") return { state: "missing" };
  if (state === "ok") {
    const version = typeof body?.version === "string" ? body.version : null;
    return { state: "ok", version };
  }
  return { state: "unread" };
}

function gatewayOf(name: string | null, value: unknown): GatewayHealth | null {
  if (!name) return null;
  const body = record(value);
  const state = oneOf(body?.state, ["answered", "timedOut", "down", "refused"] as const) ?? "down";
  return { name, state };
}

/** Machine facts are untrusted: a missing or odd field becomes "could not check", never a false OK. */
export function factsFrom(
  raw: unknown,
  extras: { clis: readonly CliHealth[]; gatewayName: string | null; now: number },
): HealthFacts {
  const body = record(raw);
  const writable = body?.dataWritable;
  return {
    clis: extras.clis,
    git: gitOf(body?.git),
    diskFreeBytes: bytes(body?.diskFreeBytes),
    database: oneOf(body?.database, ["ok", "problem", "unread"] as const) ?? "unread",
    dataWritable: writable === true ? true : writable === false ? false : null,
    plugins: oneOf(body?.plugins, ["readable", "missing", "unreadable", "unread"] as const) ?? "unread",
    lastBackupAt: when(body?.lastBackupAt),
    now: extras.now,
    gateway: gatewayOf(extras.gatewayName, body?.gateway),
  };
}

/**
 * Build the facts for one pass. A port that throws is that part unread, not a failed page.
 * The gateway address is sent only when one is configured.
 */
export async function assembleHealth(io: {
  clis: () => Promise<readonly CliHealth[]>;
  endpoint: () => { name: string; url: string } | null;
  machine: (gatewayUrl: string | null) => Promise<unknown>;
  now: () => number;
}): Promise<HealthFacts> {
  const endpoint = io.endpoint();
  const [clis, machine] = await Promise.all([
    io.clis().catch(() => [] as CliHealth[]),
    io.machine(endpoint?.url ?? null).catch(() => null),
  ]);
  return factsFrom(machine, {
    clis,
    gatewayName: endpoint?.name ?? null,
    now: io.now(),
  });
}

function cliRow(cli: CliHealth): HealthRow {
  const name = words(cli.name, "This CLI");
  if (cli.installed == null) {
    return {
      id: `cli:${cli.id}`,
      tone: "check",
      text: `Couldn't check whether ${name} is installed. It will be checked again shortly.`,
    };
  }
  if (!cli.installed) {
    return {
      id: `cli:${cli.id}`,
      tone: "problem",
      text: `${name} is not installed. Install it, then open Hivra again.`,
    };
  }
  if (cli.signedIn === true) {
    return { id: `cli:${cli.id}`, tone: "ok", text: `${name} is installed and signed in.` };
  }
  if (cli.signedIn === false) {
    return {
      id: `cli:${cli.id}`,
      tone: "check",
      text: `${name} is installed but not signed in. Sign in from Providers.`,
    };
  }
  return { id: `cli:${cli.id}`, tone: "ok", text: `${name} is installed.` };
}

function gitRow(git: GitHealth): HealthRow {
  if (git.state === "missing") {
    return { id: "git", tone: "problem", text: "Git is not installed. Install Git, then open Hivra again." };
  }
  if (git.state === "unread") {
    return { id: "git", tone: "check", text: "Couldn't check Git this time. It will be checked again shortly." };
  }
  const version = git.version && GIT_VERSION.test(git.version) ? ` (${git.version})` : "";
  return { id: "git", tone: "ok", text: `Git is installed${version}.` };
}

function diskRow(free: number | null): HealthRow {
  if (free == null) {
    return { id: "disk", tone: "check", text: "Couldn't read free disk space. It will be checked again shortly." };
  }
  if (free < LOW_DISK_BYTES) {
    return { id: "disk", tone: "check", text: "Less than 2 GB is free. Free some space before a long run." };
  }
  return { id: "disk", tone: "ok", text: "There is enough free disk space." };
}

function databaseRow(state: HealthFacts["database"]): HealthRow {
  if (state === "ok") return { id: "database", tone: "ok", text: "The app database looks fine." };
  if (state === "problem") {
    return {
      id: "database",
      tone: "problem",
      text: "The app database failed its check. Copy diagnostics before you keep working.",
    };
  }
  return { id: "database", tone: "check", text: "Couldn't check the app database this time. It will be checked again shortly." };
}

function dataRow(writable: boolean | null): HealthRow {
  if (writable == null) {
    return { id: "data", tone: "check", text: "Couldn't check the data folder this time. It will be checked again shortly." };
  }
  if (!writable) {
    return { id: "data", tone: "problem", text: "The data folder cannot be written. Check that Hivra can save files." };
  }
  return { id: "data", tone: "ok", text: "The data folder can be written." };
}

function pluginsRow(state: HealthFacts["plugins"]): HealthRow {
  if (state === "readable") return { id: "plugins", tone: "ok", text: "The plugins folder can be read." };
  if (state === "missing") return { id: "plugins", tone: "ok", text: "No plugins folder yet." };
  if (state === "unreadable") {
    return { id: "plugins", tone: "problem", text: "The plugins folder cannot be read. Check its permissions." };
  }
  return { id: "plugins", tone: "check", text: "Couldn't check the plugins folder this time. It will be checked again shortly." };
}

function ago(ms: number): string | null {
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (ms < minute) return null;
  if (ms < hour) {
    const n = Math.floor(ms / minute);
    return n === 1 ? "1 minute ago" : `${n} minutes ago`;
  }
  if (ms < day) {
    const n = Math.floor(ms / hour);
    return n === 1 ? "1 hour ago" : `${n} hours ago`;
  }
  const n = Math.floor(ms / day);
  return n === 1 ? "1 day ago" : `${n} days ago`;
}

function backupRow(at: number, now: number): HealthRow {
  if (at > now) {
    return { id: "backup", tone: "check", text: "The last backup time is ahead of this Mac. Check the clock." };
  }
  const phrase = ago(now - at);
  return {
    id: "backup",
    tone: "ok",
    text: phrase ? `Last backup was ${phrase}.` : "Last backup was just now.",
  };
}

function gatewayRow(gateway: GatewayHealth): HealthRow {
  const name = words(gateway.name, "That endpoint");
  if (gateway.state === "answered") return { id: "gateway", tone: "ok", text: `${name} answered.` };
  if (gateway.state === "timedOut") {
    return { id: "gateway", tone: "check", text: `${name} did not answer in time. It will be checked again shortly.` };
  }
  if (gateway.state === "refused") {
    return { id: "gateway", tone: "check", text: `${name} does not have an address Hivra can check.` };
  }
  return { id: "gateway", tone: "check", text: `Couldn't reach ${name} this time. It will be checked again shortly.` };
}

/** The rows, in the order the page shows them. No backup row and no gateway row unless there is something to say. */
export function healthRows(facts: HealthFacts): HealthRow[] {
  const seen = new Set<string>();
  const rows: HealthRow[] = [];
  for (const cli of facts.clis) {
    if (!CLI_ID.test(cli.id) || seen.has(cli.id)) continue;
    seen.add(cli.id);
    rows.push(cliRow({ ...cli, name: words(cli.name, "This CLI") }));
  }
  rows.push(gitRow(facts.git));
  rows.push(diskRow(facts.diskFreeBytes));
  rows.push(databaseRow(facts.database));
  rows.push(dataRow(facts.dataWritable));
  rows.push(pluginsRow(facts.plugins));
  if (facts.lastBackupAt != null) rows.push(backupRow(facts.lastBackupAt, facts.now));
  if (facts.gateway) rows.push(gatewayRow(facts.gateway));
  return rows;
}
