// Which copy of MonoCode Hub this window belongs to, and the build it runs (src-tauri/src/instance.rs).
//
// The Rust side hands every window `window.__MONOCODE_APP__` before the page's own scripts run: the identity compiled
// into the app (the daily app or a dev copy), its build stamp and what it may do. A dev copy keeps habits and
// auto-resume off here; everything else is switched off in Rust. Outside the app (vitest, the browser preview) there
// is no identity and the daily behaviour applies, as before.

export type AppKind = "daily" | "dev";

export type AppStamp = {
  sha: string;
  branch: string;
  dirty: boolean;
  builtAt: string;
};

export type AppPolicy = {
  liveAshOs: boolean;
  dailyKeychain: boolean;
  dailyClaude: boolean;
  reapOrphans: boolean;
  phoneAccess: boolean;
  habits: boolean;
  automations: boolean;
  reminders: boolean;
  autoResume: boolean;
  notificationPrompt: boolean;
  globalShortcut: boolean;
};

export type AppIdentity = {
  product: string;
  version: string;
  identifier: string;
  kind: AppKind;
  slot: string | null;
  stamp: AppStamp;
  schemaVersion: number;
  policy: AppPolicy;
};

const GLOBAL = "__MONOCODE_APP__";

const DAILY_POLICY: AppPolicy = {
  liveAshOs: true,
  dailyKeychain: true,
  dailyClaude: true,
  reapOrphans: true,
  phoneAccess: true,
  habits: true,
  automations: true,
  reminders: true,
  autoResume: true,
  notificationPrompt: true,
  globalShortcut: true,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The identity in `source`, or null when it is missing or not the shape the app writes. */
export function readAppIdentity(source: unknown): AppIdentity | null {
  if (!isRecord(source) || !isRecord(source.stamp) || !isRecord(source.policy))
    return null;
  const { stamp, policy } = source;
  if (source.kind !== "daily" && source.kind !== "dev") return null;
  if (
    typeof source.identifier !== "string" ||
    typeof stamp.sha !== "string" ||
    typeof stamp.branch !== "string" ||
    typeof stamp.dirty !== "boolean"
  )
    return null;
  const flags = Object.fromEntries(
    Object.keys(DAILY_POLICY).map((key) => [key, policy[key] === true]),
  ) as AppPolicy;
  return {
    product: typeof source.product === "string" ? source.product : "MonoCode Hub",
    version: typeof source.version === "string" ? source.version : "",
    identifier: source.identifier,
    kind: source.kind,
    slot: typeof source.slot === "string" ? source.slot : null,
    stamp: {
      sha: stamp.sha,
      branch: stamp.branch,
      dirty: stamp.dirty,
      builtAt: typeof stamp.builtAt === "string" ? stamp.builtAt : "",
    },
    schemaVersion:
      typeof source.schemaVersion === "number" ? source.schemaVersion : 0,
    policy: flags,
  };
}

/** This window's identity, or null outside the app. */
export function appIdentity(): AppIdentity | null {
  return readAppIdentity(
    (globalThis as Record<string, unknown>)[GLOBAL] ?? null,
  );
}

export function isDevCopy(identity: AppIdentity | null = appIdentity()): boolean {
  return identity?.kind === "dev";
}

/** What this copy may do. Without an identity (tests, browser preview): the daily app's behaviour. */
export function appPolicy(identity: AppIdentity | null = appIdentity()): AppPolicy {
  return identity ? identity.policy : DAILY_POLICY;
}

export function shortSha(sha: string): string {
  return /^[0-9a-f]{7,}$/i.test(sha) ? sha.slice(0, 7) : sha;
}

/** "hub/1b-identity @ 09141d8", with "-dirty" when the build had uncommitted changes. */
export function stampLabel(stamp: AppStamp): string {
  return `${stamp.branch} @ ${shortSha(stamp.sha)}${stamp.dirty ? "-dirty" : ""}`;
}

/** The name at the end of every window title: "MonoCode", or for a dev copy "MonoCode Hub Dev - <branch> @ <sha>". */
export function windowTitleSuffix(
  identity: AppIdentity | null = appIdentity(),
): string {
  return isDevCopy(identity)
    ? `MonoCode Hub Dev - ${stampLabel(identity!.stamp)}`
    : "MonoCode";
}

/** "19 Oct 2026, 21:04" in local time, or the raw text when it isn't a date. */
export function builtAtLabel(builtAt: string): string {
  const date = new Date(builtAt);
  if (!builtAt || Number.isNaN(date.getTime())) return builtAt;
  return date.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The Settings footer: "MonoCode Hub 0.16.0 · hub/next @ 09141d8 · built 19 Oct 2026, 21:04", plus the copy. */
export function buildLine(identity: AppIdentity): string {
  const parts = [
    `${identity.product} ${identity.version}`.trim(),
    stampLabel(identity.stamp),
  ];
  const built = builtAtLabel(identity.stamp.builtAt);
  if (built) parts.push(`built ${built}`);
  parts.push(
    identity.kind === "dev"
      ? `dev copy ${identity.slot ?? ""}`.trim()
      : "daily app",
  );
  return parts.join(" · ");
}
