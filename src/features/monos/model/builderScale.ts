// WP-161: how many builders may start, and when new ones wait for the machine.
// A pause never stops a builder that is already running. It only refuses a new launch.

/** Today's ceiling, from the worker pool (6 at once) until a person raises it. */
export const DEFAULT_MAX_BUILDERS = 6;
/** The same cap as the worker pool. A stored value above this is clamped. */
export const MAX_BUILDERS = 30;
/** Default load pause: 1-minute load average above this many times the core count. */
export const LOAD_PER_CORE = 1.6;
/** Default disk pause: new builders wait when the root disk has less than this many GB free. On until a person turns it off. */
export const DEFAULT_FREE_DISK_GB = 30;
/**
 * A stored scale from this version on says "disk pause off" with a null. Before it, a null only meant "never set", because
 * the pause was off until a person turned it on, so a stored null from before is read as the new default.
 */
export const STORED_SCALE_VERSION = 2;
const LOAD_MAX = 10_000;
const GB_MAX = 1_000_000;

export type LoadPause = { kind: "default" } | { kind: "off" } | { kind: "above"; value: number };

/** The shared ceiling and the optional pauses. Each pause is off when null or `kind: "off"`. */
export type BuilderScale = {
  /** Ceiling for a project that has not set its own. The default is 6. */
  maxBuilders: number;
  /** 1-minute load average. `default` is 1.6 times the cores, once the core count is known. */
  load: LoadPause;
  /** Pause new builders when free memory is below this many GB. Null means off. */
  pauseFreeMemoryGb: number | null;
  /** Pause new builders when free disk is below this many GB. The default is 30. Null means a person turned it off. */
  pauseFreeDiskGb: number | null;
};

export const DEFAULT_BUILDER_SCALE: BuilderScale = {
  maxBuilders: DEFAULT_MAX_BUILDERS,
  load: { kind: "default" },
  pauseFreeMemoryGb: null,
  pauseFreeDiskGb: DEFAULT_FREE_DISK_GB,
};

/**
 * What is stored. `load` is "default", "off", or `{ above }`. A default scale is not stored. `version` tells a null disk
 * pause that was chosen (2 and up) from one that was only never set (absent, written before the pause was on by default).
 */
export type StoredBuilderScale = {
  version: number;
  maxBuilders: number;
  load: "default" | "off" | { above: number };
  pauseFreeMemoryGb: number | null;
  pauseFreeDiskGb: number | null;
};

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function sanitizeMaxBuilders(value: unknown, fallback = DEFAULT_MAX_BUILDERS): number {
  const n = finiteNumber(value);
  if (n === undefined) return fallback;
  return Math.min(MAX_BUILDERS, Math.max(1, Math.round(n)));
}

function sanitizeGb(value: unknown): number | null {
  if (value === null || value === undefined || value === false || value === "") return null;
  const n = finiteNumber(value);
  if (n === undefined || n <= 0 || n > GB_MAX) return null;
  return round3(n);
}

/**
 * The disk floor. Missing or unusable is the default, the safe way round. Null, "", false and 0 are a person saying
 * "do not check the disk", so they stay off.
 */
function sanitizeDiskGb(value: unknown): number | null {
  if (value === undefined) return DEFAULT_FREE_DISK_GB;
  if (value === null || value === false || value === "") return null;
  const n = finiteNumber(value);
  if (n === undefined || n < 0 || n > GB_MAX) return DEFAULT_FREE_DISK_GB;
  if (n === 0) return null;
  const rounded = round3(n);
  return rounded > 0 ? rounded : DEFAULT_FREE_DISK_GB;
}

function sanitizeLoad(value: unknown): LoadPause {
  if (value === null || value === undefined || value === "default") return { kind: "default" };
  if (value === false || value === "off") return { kind: "off" };
  if (typeof value === "object") {
    const row = value as { kind?: unknown; value?: unknown; above?: unknown };
    if (row.kind === "off") return { kind: "off" };
    if (row.kind === "default") return { kind: "default" };
    if (row.kind === "above" || row.above !== undefined) {
      const n = finiteNumber(row.kind === "above" ? row.value : row.above);
      if (n === undefined || n <= 0 || n > LOAD_MAX) return { kind: "default" };
      return { kind: "above", value: round3(n) };
    }
    return { kind: "default" };
  }
  const n = finiteNumber(value);
  if (n === undefined || n <= 0 || n > LOAD_MAX) return { kind: "default" };
  return { kind: "above", value: round3(n) };
}

/**
 * A scale held in memory, or any untrusted value, becomes a safe scale. Extra fields are dropped. A disk pause that is
 * absent is the default (on); a null is off. For a row read back from storage use {@link builderScaleFromStored}.
 */
export function sanitizeBuilderScale(raw: unknown): BuilderScale {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      maxBuilders: DEFAULT_MAX_BUILDERS,
      load: { kind: "default" },
      pauseFreeMemoryGb: null,
      pauseFreeDiskGb: DEFAULT_FREE_DISK_GB,
    };
  }
  const row = raw as Record<string, unknown>;
  return {
    maxBuilders: sanitizeMaxBuilders(row.maxBuilders),
    load: sanitizeLoad(row.load !== undefined ? row.load : row.pauseLoad),
    pauseFreeMemoryGb: sanitizeGb(row.pauseFreeMemoryGb),
    pauseFreeDiskGb: sanitizeDiskGb(row.pauseFreeDiskGb),
  };
}

/**
 * A row read back from storage. One saved before the disk pause was on by default (no `version`) has a null disk pause
 * that was only "never set", so it takes the new default. A person's own choice there is a number, and it stays. A row
 * from this version on keeps a null as a deliberate off. Nothing stored is the default scale.
 */
export function builderScaleFromStored(raw: unknown): BuilderScale {
  const clean = sanitizeBuilderScale(raw);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return clean;
  const version = finiteNumber((raw as Record<string, unknown>).version);
  if (version !== undefined && version >= STORED_SCALE_VERSION) return clean;
  return clean.pauseFreeDiskGb === null ? { ...clean, pauseFreeDiskGb: DEFAULT_FREE_DISK_GB } : clean;
}

export function builderScaleIsDefault(scale: BuilderScale): boolean {
  const clean = sanitizeBuilderScale(scale);
  return (
    clean.maxBuilders === DEFAULT_BUILDER_SCALE.maxBuilders &&
    clean.load.kind === "default" &&
    clean.pauseFreeMemoryGb === null &&
    clean.pauseFreeDiskGb === DEFAULT_FREE_DISK_GB
  );
}

/** Null when the scale is the default, so the store can drop the row. */
export function builderScaleToStored(scale: BuilderScale): StoredBuilderScale | null {
  const clean = sanitizeBuilderScale(scale);
  if (builderScaleIsDefault(clean)) return null;
  return {
    version: STORED_SCALE_VERSION,
    maxBuilders: clean.maxBuilders,
    load: clean.load.kind === "above" ? { above: clean.load.value } : clean.load.kind,
    pauseFreeMemoryGb: clean.pauseFreeMemoryGb,
    pauseFreeDiskGb: clean.pauseFreeDiskGb,
  };
}

/** Said wherever the pauses are shown: one setting for the whole machine, not one per project. */
export const PAUSES_ALL_PROJECTS = "These pauses apply to all projects.";

/** The plain sentence under the settings. */
export function scaleLine(scale: BuilderScale): string {
  const clean = sanitizeBuilderScale(scale);
  const load =
    clean.load.kind === "off"
      ? "Load is not checked."
      : clean.load.kind === "default"
        ? "New builders pause when the load average is above 1.6 times the number of cores."
        : `New builders pause when the load average is above ${clean.load.value}.`;
  const memory =
    clean.pauseFreeMemoryGb == null
      ? "Free memory is not checked."
      : `New builders pause when free memory is below ${clean.pauseFreeMemoryGb} GB.`;
  const disk =
    clean.pauseFreeDiskGb == null
      ? "Free disk is not checked."
      : `New builders pause when free disk is below ${clean.pauseFreeDiskGb} GB.`;
  return `${load} ${memory} ${disk} Running builders keep going.`;
}

/** A reading older than this is missing, not a reason to pause. */
export const HEALTH_STALE_MS = 15_000;
/** How long a health sample is reused before another read. */
export const HEALTH_CACHE_MS = 4_000;

/**
 * One health sample. A missing field skips that check. `readAt` with `now` drops a sample older than
 * {@link HEALTH_STALE_MS}. A sample with no `readAt` is trusted (a fixture, or a reading just taken).
 */
export type BuilderHealth = {
  /** 1-minute load average. */
  load1?: number | null;
  /** Cores online. The default load pause needs this. */
  cores?: number | null;
  /** Free memory, in GB. */
  freeMemoryGb?: number | null;
  /** Free disk, in GB. */
  freeDiskGb?: number | null;
  /** When the sample was taken, in epoch ms. */
  readAt?: number;
  /** Clock for the staleness check. Defaults to the time of the call. */
  now?: number;
};

export type LaunchDecision = { ok: true; reason: "" } | { ok: false; reason: string };

const ALLOWED: LaunchDecision = { ok: true, reason: "" };

function finiteMetric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function shown(n: number): string {
  return String(round3(n));
}

/** The sample, unless it is missing, not an object, or older than {@link HEALTH_STALE_MS}. */
function currentHealth(health: BuilderHealth | null | undefined): BuilderHealth | null {
  if (!health || typeof health !== "object" || Array.isArray(health)) return null;
  if (health.readAt !== undefined) {
    const readAt = finiteMetric(health.readAt);
    const now = finiteMetric(health.now) ?? Date.now();
    if (readAt === undefined || now - readAt > HEALTH_STALE_MS) return null;
  }
  return health;
}

/**
 * Whether a new builder may start. The ceiling is not read here: raising max builders cannot
 * ignore a pause. A missing or stale sample is not a health pause. A spend limit still applies.
 * A pause never names a builder to stop.
 */
export function builderLaunchAllowed(
  health: BuilderHealth | null | undefined,
  limits: BuilderScale,
  spend?: { status?: string; reason?: string } | null,
): LaunchDecision {
  const sample = currentHealth(health);
  if (sample) {
    const scale = sanitizeBuilderScale(limits);
    const load1 = finiteMetric(sample.load1);
    if (scale.load.kind !== "off" && load1 !== undefined) {
      const cores = finiteMetric(sample.cores);
      const threshold =
        scale.load.kind === "above"
          ? scale.load.value
          : cores !== undefined && cores > 0
            ? round3(LOAD_PER_CORE * cores)
            : undefined;
      if (threshold !== undefined && load1 > threshold) {
        return {
          ok: false,
          reason: `The load average is ${shown(load1)}, which exceeds ${shown(threshold)}. Running builders keep going.`,
        };
      }
    }
    const memoryCut = scale.pauseFreeMemoryGb;
    const freeMemory = finiteMetric(sample.freeMemoryGb);
    if (memoryCut != null && freeMemory !== undefined && freeMemory < memoryCut) {
      return {
        ok: false,
        reason: `Free memory is ${shown(freeMemory)} GB, which is below ${shown(memoryCut)} GB. Running builders keep going.`,
      };
    }
    const disk = diskHold(sample, scale);
    if (disk) {
      return {
        ok: false,
        reason: `Free disk is ${shown(disk.freeGb)} GB, which is below ${shown(disk.floorGb)} GB. Running builders keep going.`,
      };
    }
  }
  // WP-176: a spend limit is the same gate. Health wins when both apply. Over refuses a new launch only.
  if (spend?.status === "over" && typeof spend.reason === "string" && spend.reason.trim()) {
    return { ok: false, reason: spend.reason.trim() };
  }
  return ALLOWED;
}

/** The free disk and the floor it is under. */
export type DiskHold = { freeGb: number; floorGb: number };

/**
 * Whether the disk pause is holding new builders right now: the pause is on and a current sample is under it. Read on
 * its own, so it still says so when the load pause is crossed too (the load clears by waiting, the disk does not).
 */
export function diskHold(health: BuilderHealth | null | undefined, limits: BuilderScale): DiskHold | null {
  const sample = currentHealth(health);
  if (!sample) return null;
  const floorGb = sanitizeBuilderScale(limits).pauseFreeDiskGb;
  const freeGb = finiteMetric(sample.freeDiskGb);
  if (floorGb == null || freeGb === undefined || freeGb >= floorGb) return null;
  return { freeGb, floorGb };
}

/** The action on the line, and the name of the place it opens (Settings > Worktrees > Clean up). */
export const FREE_UP_SPACE = "Free up space";

/** One line for Needs you: builders are waiting and the disk is why. It names the free space and the floor. */
export type BuilderHoldNeed = {
  id: "builders-disk";
  text: string;
  action: typeof FREE_UP_SPACE;
  freeGb: number;
  floorGb: number;
};

/** One decimal, rounded down, so a reading just under the floor never reads as the floor itself. */
function freeShown(n: number): string {
  return String(Math.floor(n * 10) / 10);
}

/**
 * The Needs you line for builders held by the disk pause, or null when none wait or the disk is inside the floor. `waiting`
 * is how many builders are in the queue. It clears by itself once the disk is back over the floor.
 */
export function builderHoldNeed(
  waiting: number,
  health: BuilderHealth | null | undefined,
  limits: BuilderScale,
): BuilderHoldNeed | null {
  if (!(waiting > 0)) return null;
  const hold = diskHold(health, limits);
  if (!hold) return null;
  return {
    id: "builders-disk",
    text: `New builders are waiting: ${freeShown(hold.freeGb)} GB free, under the ${shown(hold.floorGb)} GB floor`,
    action: FREE_UP_SPACE,
    freeGb: hold.freeGb,
    floorGb: hold.floorGb,
  };
}
