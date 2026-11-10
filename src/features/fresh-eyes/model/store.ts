// WP-144: the project's fresh-eyes setting and the review waiting on a plan.
// Writes go through a queue and a token, so a late window does not overwrite a newer one.

import type { Finding } from "./review";
import type { Persona } from "./personas";
import { readSetting, type FreshEyesSetting } from "./setting";

export type ReviewStatus = "pending" | "approved" | "skipped_by_person" | "editing";

export type ReviewRecord = {
  project: string;
  requestId: string;
  revision: number;
  status: ReviewStatus;
  findings: Finding[];
  failed: Persona[];
  /** Ask the reviewers again. A timeout is not a final result. */
  retry: boolean;
  /** The inbox question was asked. A failed ask stays false so the next start tries again. */
  asked: boolean;
  plan: string;
};

type FileShape = {
  revision: number;
  token: string;
  settings: Record<string, unknown>;
  reviews: ReviewRecord[];
};

export type EyesStorage = {
  read(): string | null;
  write(value: string): void;
};

const STORAGE_KEY = "hivra.fresh-eyes.v1";

const STATUSES = new Set<ReviewStatus>(["pending", "approved", "skipped_by_person", "editing"]);

export function memoryStorage(initial: string | null = null): EyesStorage {
  let raw = initial;
  return {
    read: () => raw,
    write: (value) => {
      raw = value;
    },
  };
}

let active: EyesStorage | undefined;

export function setFreshEyesStorage(storage: EyesStorage | undefined): void {
  active = storage;
}

export function freshEyesStorage(): EyesStorage {
  if (active) return active;
  return {
    read: () => {
      try {
        return localStorage.getItem(STORAGE_KEY);
      } catch {
        return null;
      }
    },
    write: (value) => {
      try {
        localStorage.setItem(STORAGE_KEY, value);
      } catch {
        // A private window or a full disk leaves the review off.
      }
    },
  };
}

export function projectKey(project: string): string {
  return project.replace(/\\/g, "/").trim();
}

function emptyFile(): FileShape {
  return { revision: 0, token: "0", settings: {}, reviews: [] };
}

function normalize(row: ReviewRecord): ReviewRecord {
  return {
    ...row,
    retry: row.retry === true,
    asked: row.asked === true,
    failed: Array.isArray(row.failed) ? row.failed : [],
    findings: Array.isArray(row.findings) ? row.findings : [],
    plan: typeof row.plan === "string" ? row.plan : "",
  };
}

function isReview(value: unknown): value is ReviewRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<ReviewRecord>;
  return (
    typeof row.project === "string" &&
    typeof row.requestId === "string" &&
    typeof row.revision === "number" &&
    typeof row.status === "string" &&
    STATUSES.has(row.status as ReviewStatus) &&
    Array.isArray(row.findings)
  );
}

export function loadFreshEyes(storage: EyesStorage = freshEyesStorage()): FileShape {
  const raw = storage.read();
  if (!raw) return emptyFile();
  try {
    const parsed = JSON.parse(raw) as Partial<FileShape>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.revision !== "number" || !Number.isFinite(parsed.revision)) {
      return emptyFile();
    }
    const settings =
      parsed.settings && typeof parsed.settings === "object" && !Array.isArray(parsed.settings)
        ? (parsed.settings as Record<string, unknown>)
        : {};
    return {
      revision: parsed.revision,
      token: typeof parsed.token === "string" ? parsed.token : String(parsed.revision),
      settings,
      reviews: Array.isArray(parsed.reviews) ? parsed.reviews.filter(isReview).map(normalize) : [],
    };
  } catch {
    return emptyFile();
  }
}

let chain: Promise<unknown> = Promise.resolve();

/** Tests hold a write so a late reply can be checked. Production leaves this unset. */
let hold: Promise<void> | null = null;

export function holdFreshEyesWrites(next: Promise<void> | null): void {
  hold = next;
}

function queued<T>(fn: () => T): Promise<T> {
  const run = chain.then(
    async () => {
      if (hold) await hold;
      return fn();
    },
    async () => {
      if (hold) await hold;
      return fn();
    },
  );
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const listeners = new Set<() => void>();

export function subscribeFreshEyes(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of listeners) fn();
}

function stamp(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Write only if the file is still the revision we read. A mismatch keeps the newer file. */
function save(storage: EyesStorage, file: FileShape, expected: number): boolean {
  const current = loadFreshEyes(storage);
  if (current.revision !== expected || current.token !== file.token) return false;
  const token = stamp();
  const next: FileShape = { ...file, revision: expected + 1, token, settings: file.settings, reviews: file.reviews };
  storage.write(JSON.stringify(next));
  const after = loadFreshEyes(storage);
  if (after.token !== token || after.revision !== expected + 1) return false;
  notify();
  return true;
}

export function freshEyesRevision(storage: EyesStorage = freshEyesStorage()): number {
  return loadFreshEyes(storage).revision;
}

export function settingFor(project: string, storage: EyesStorage = freshEyesStorage()): FreshEyesSetting {
  const key = projectKey(project);
  if (!key) return readSetting(undefined);
  return readSetting(loadFreshEyes(storage).settings[key]);
}

export function writeSetting(
  project: string,
  patch: Partial<FreshEyesSetting>,
  storage: EyesStorage = freshEyesStorage(),
): Promise<FreshEyesSetting> {
  const key = projectKey(project);
  return queued(() => {
    if (!key) return readSetting(undefined);
    const file = loadFreshEyes(storage);
    const current = readSetting(file.settings[key]);
    const record = {
      enabled: patch.enabled ?? current.enabled,
      autoAcceptClean: patch.autoAcceptClean ?? current.autoAcceptClean,
      reviewerCount: patch.reviewerCount ?? current.reviewerCount,
      model: patch.model === undefined ? current.model : patch.model,
    };
    const next = readSetting(record);
    file.settings = { ...file.settings, [key]: next };
    if (!save(storage, file, file.revision)) {
      const again = loadFreshEyes(storage);
      const latest = readSetting(again.settings[key]);
      const merged = readSetting({
        enabled: patch.enabled ?? latest.enabled,
        autoAcceptClean: patch.autoAcceptClean ?? latest.autoAcceptClean,
        reviewerCount: patch.reviewerCount ?? latest.reviewerCount,
        model: patch.model === undefined ? latest.model : patch.model,
      });
      again.settings = { ...again.settings, [key]: merged };
      save(storage, again, again.revision);
      return merged;
    }
    return next;
  });
}

export function reviewFor(
  project: string,
  requestId: string,
  storage: EyesStorage = freshEyesStorage(),
): ReviewRecord | null {
  const key = projectKey(project);
  return loadFreshEyes(storage).reviews.find((row) => row.project === key && row.requestId === requestId) ?? null;
}

export function latestReview(project: string, storage: EyesStorage = freshEyesStorage()): ReviewRecord | null {
  const key = projectKey(project);
  const rows = loadFreshEyes(storage).reviews.filter((row) => row.project === key);
  return rows.length > 0 ? rows[rows.length - 1] : null;
}

/**
 * Replace one review if it is still at `expectedRevision` (0 when it is new).
 * A stale writer loses and the newer review stays.
 */
export function putReview(
  record: ReviewRecord,
  expectedRevision: number,
  storage: EyesStorage = freshEyesStorage(),
): Promise<{ ok: boolean; current: ReviewRecord | null }> {
  return queued(() => {
    const file = loadFreshEyes(storage);
    const current = file.reviews.find((row) => row.project === record.project && row.requestId === record.requestId) ?? null;
    const at = current?.revision ?? 0;
    if (at !== expectedRevision) return { ok: false, current };
    const next: ReviewRecord = { ...record, revision: expectedRevision + 1 };
    file.reviews = [
      ...file.reviews.filter((row) => !(row.project === record.project && row.requestId === record.requestId)),
      next,
    ];
    if (!save(storage, file, file.revision)) {
      return { ok: false, current: reviewFor(record.project, record.requestId, storage) };
    }
    return { ok: true, current: next };
  });
}
