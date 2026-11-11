// Which copy of MonoCode Hub this window belongs to, and the build it runs (src-tauri/src/instance.rs).
//
// The Rust side hands every window `window.__MONOCODE_APP__` before the page's own scripts run: the identity compiled
// into the app (the daily app or a dev copy), its build stamp and what it may do. A dev copy keeps habits and
// auto-resume off here; everything else is switched off in Rust. Outside the app (vitest, the browser preview) there
// is no identity and the daily behaviour applies, as before.

import { DISPLAY_NAME } from "./displayName";

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
  /** The background sweep that deletes the build output of finished worktrees (worktree_autoclean.rs). */
  clearBuildOutput: boolean;
};

/**
 * The fake-Claude test bench's plan (scripts/hub-verify-live.mjs, src-tauri/src/verify_live.rs). Only a dev copy under
 * a temporary HOME ever has one: open a Mono on a scratch project and send its first message, once per run.
 */
export type VerifyPlan = {
  runId: string;
  /** monoId: open that existing Mono once it works on project, instead of making a new one. */
  kickoff?: { project: string; monoName: string; prompt: string; monoId?: string };
  /** The bench's fake Claude takes /goal (a dev copy otherwise never sends it: claude.ts goalsAllowed). */
  goals?: boolean;
  /** How long a worker may be silent before it is marked stalled (the bench's seconds, not minutes). */
  stallMs?: number;
  /** The real-Claude bench (scripts/hub-realtest.mjs): the window takes scripted actions (verifyDriver.ts). */
  driver?: boolean;
  /** The real bench's Claude Code runs on DeepSeek through the local gateway launcher (`--deepseek-sub`). */
  deepseek?: boolean;
  /** The real bench's Claude Code runs on another launcher of Ash's (`--agents grok-sub`, `--agents openrouter-sub`). Not a DeepSeek model rewrite. */
  launcher?: boolean;
  /** Hub projects the copy's local store starts with (added once; the bench's projects used to come from a stub). */
  projects?: Array<{ id: string; name: string; folder?: string }>;
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
  verify?: VerifyPlan;
};

function readVerifyPlan(value: unknown): VerifyPlan | undefined {
  if (!isRecord(value) || typeof value.runId !== "string" || !value.runId) return undefined;
  const kickoff = value.kickoff;
  return {
    runId: value.runId,
    ...(value.goals === true ? { goals: true } : {}),
    ...(typeof value.stallMs === "number" && value.stallMs >= 1_000 && value.stallMs <= 600_000 ? { stallMs: value.stallMs } : {}),
    ...(value.driver === true ? { driver: true } : {}),
    ...(value.deepseek === true ? { deepseek: true } : {}),
    ...(value.launcher === true ? { launcher: true } : {}),
    ...(Array.isArray(value.projects)
      ? {
          projects: value.projects
            .filter(isRecord)
            .filter((p) => typeof p.id === "string" && typeof p.name === "string")
            .map((p) => ({ id: p.id as string, name: p.name as string, ...(typeof p.folder === "string" ? { folder: p.folder } : {}) })),
        }
      : {}),
    ...(isRecord(kickoff) &&
    typeof kickoff.project === "string" &&
    typeof kickoff.monoName === "string" &&
    typeof kickoff.prompt === "string"
      ? {
          kickoff: {
            project: kickoff.project,
            monoName: kickoff.monoName,
            prompt: kickoff.prompt,
            ...(typeof kickoff.monoId === "string" && kickoff.monoId
              ? { monoId: kickoff.monoId }
              : {}),
          },
        }
      : {}),
  };
}

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
  clearBuildOutput: true,
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
    // Never on the daily app, whatever the window was handed.
    ...(source.kind === "dev" && readVerifyPlan(source.verify)
      ? { verify: readVerifyPlan(source.verify) }
      : {}),
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

/** The name at the end of every window title: "Hivra", or for a dev copy "Hivra Dev - <branch> @ <sha>". */
export function windowTitleSuffix(
  identity: AppIdentity | null = appIdentity(),
): string {
  return isDevCopy(identity)
    ? `${DISPLAY_NAME} Dev - ${stampLabel(identity!.stamp)}`
    : DISPLAY_NAME;
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

/**
 * The Settings footer. r65 (Critiquito): the daily app shows only its version ("Hivra 0.16.7"); a dev copy keeps
 * "hub/next @ 09141d8 · built 19 Oct 2026, 21:04 · dev copy <slot>" so a test run can tell builds apart.
 * The name is the display name, never `identity.product` (that is the bundle name the binary was built with).
 */
export function buildLine(identity: AppIdentity): string {
  const named = displayVersion(identity.version);
  if (identity.kind !== "dev") return named;
  const parts = [
    named,
    stampLabel(identity.stamp),
  ];
  const built = builtAtLabel(identity.stamp.builtAt);
  if (built) parts.push(`built ${built}`);
  parts.push(`dev copy ${identity.slot?.trim() ?? ""}`.trim());
  return parts.join(" · ");
}

/** "Hivra 0.16.0", or just "Hivra" when the version is missing or blank. */
function displayVersion(version: string): string {
  const trimmed = version.trim();
  return trimmed ? `${DISPLAY_NAME} ${trimmed}` : DISPLAY_NAME;
}
