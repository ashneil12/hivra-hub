// WP-161: how many builders may start, and when new ones wait for the machine.
// A pause never stops a builder that is already running. It only refuses a new launch.

/** Today's ceiling, from the worker pool (6 at once) until a person raises it. */
export const DEFAULT_MAX_BUILDERS = 6;
/** The same cap as the worker pool. A stored value above this is clamped. */
export const MAX_BUILDERS = 30;
/** Default load pause: 1-minute load average above this many times the core count. */
export const LOAD_PER_CORE = 1.6;
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
  /** Pause new builders when free disk is below this many GB. Null means off. */
  pauseFreeDiskGb: number | null;
};

export const DEFAULT_BUILDER_SCALE: BuilderScale = {
  maxBuilders: DEFAULT_MAX_BUILDERS,
  load: { kind: "default" },
  pauseFreeMemoryGb: null,
  pauseFreeDiskGb: null,
};

/** What is stored. `load` is "default", "off", or `{ above }`. A default scale is not stored. */
export type StoredBuilderScale = {
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

/** Untrusted settings (disk, another window, an import) become a safe scale. Extra fields are dropped. */
export function sanitizeBuilderScale(raw: unknown): BuilderScale {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      maxBuilders: DEFAULT_MAX_BUILDERS,
      load: { kind: "default" },
      pauseFreeMemoryGb: null,
      pauseFreeDiskGb: null,
    };
  }
  const row = raw as Record<string, unknown>;
  return {
    maxBuilders: sanitizeMaxBuilders(row.maxBuilders),
    load: sanitizeLoad(row.load !== undefined ? row.load : row.pauseLoad),
    pauseFreeMemoryGb: sanitizeGb(row.pauseFreeMemoryGb),
    pauseFreeDiskGb: sanitizeGb(row.pauseFreeDiskGb),
  };
}

export function builderScaleIsDefault(scale: BuilderScale): boolean {
  const clean = sanitizeBuilderScale(scale);
  return (
    clean.maxBuilders === DEFAULT_BUILDER_SCALE.maxBuilders &&
    clean.load.kind === "default" &&
    clean.pauseFreeMemoryGb === null &&
    clean.pauseFreeDiskGb === null
  );
}

/** Null when the scale is the default, so the store can drop the row. */
export function builderScaleToStored(scale: BuilderScale): StoredBuilderScale | null {
  const clean = sanitizeBuilderScale(scale);
  if (builderScaleIsDefault(clean)) return null;
  return {
    maxBuilders: clean.maxBuilders,
    load: clean.load.kind === "above" ? { above: clean.load.value } : clean.load.kind,
    pauseFreeMemoryGb: clean.pauseFreeMemoryGb,
    pauseFreeDiskGb: clean.pauseFreeDiskGb,
  };
}

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

/**
 * Whether a new builder may start. The ceiling is not read here: raising max builders cannot
 * ignore a pause. A missing or stale sample allows the launch. A pause never names a builder to stop.
 */
export function builderLaunchAllowed(health: BuilderHealth | null | undefined, limits: BuilderScale): LaunchDecision {
  if (!health || typeof health !== "object" || Array.isArray(health)) return ALLOWED;
  if (health.readAt !== undefined) {
    const readAt = finiteMetric(health.readAt);
    const now = finiteMetric(health.now) ?? Date.now();
    if (readAt === undefined || now - readAt > HEALTH_STALE_MS) return ALLOWED;
  }
  const scale = sanitizeBuilderScale(limits);
  const load1 = finiteMetric(health.load1);
  if (scale.load.kind !== "off" && load1 !== undefined) {
    const cores = finiteMetric(health.cores);
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
  const freeMemory = finiteMetric(health.freeMemoryGb);
  if (memoryCut != null && freeMemory !== undefined && freeMemory < memoryCut) {
    return {
      ok: false,
      reason: `Free memory is ${shown(freeMemory)} GB, which is below ${shown(memoryCut)} GB. Running builders keep going.`,
    };
  }
  const diskCut = scale.pauseFreeDiskGb;
  const freeDisk = finiteMetric(health.freeDiskGb);
  if (diskCut != null && freeDisk !== undefined && freeDisk < diskCut) {
    return {
      ok: false,
      reason: `Free disk is ${shown(freeDisk)} GB, which is below ${shown(diskCut)} GB. Running builders keep going.`,
    };
  }
  return ALLOWED;
}
