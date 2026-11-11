// WP-182: fast mode on a Mono uses the catalog's `fast` setting. A model without
// that setting never carries it. A change made while a turn is running waits here
// until the turn is idle, so nothing restarts the running turn.
import type { AgentModel } from "../../sessions/model/models";
import { HARNESSES, type HarnessId } from "../../sessions/model/session";
import { findMono, monoForSession, type Mono } from "./mono";

const KEY = "monocode:mono-card-run";

export function modelOffersFast(model: Pick<AgentModel, "settings"> | undefined): boolean {
  return Boolean(model?.settings?.some((setting) => setting.id === "fast"));
}

/** Settings for a launch. Fast is omitted when this model does not offer it. */
export function withMonoFast(
  model: Pick<AgentModel, "settings"> | undefined,
  settings: Record<string, string> | undefined,
  engineFast: boolean | undefined,
): Record<string, string> {
  const next = { ...(settings ?? {}) };
  if (!modelOffersFast(model)) {
    delete next.fast;
    return next;
  }
  if (typeof engineFast === "boolean") next.fast = engineFast ? "true" : "false";
  return next;
}

export type CardRun = {
  monoId: string;
  harness: string;
  model: string;
  settings: Record<string, string>;
  engineFast?: boolean;
};

const memory = new Map<string, string>();

/** Test seam. Runs after a queued run is read and before it is written, so two windows can overlap. */
let beforeCardRunWrite: (() => void) | undefined;

export function setBeforeCardRunWriteForTests(next: (() => void) | undefined): void {
  beforeCardRunWrite = next;
}

function getItem(key: string): string | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage.getItem(key);
  } catch {
    /* a test runner with no storage */
  }
  return memory.get(key) ?? null;
}

function setItem(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, value);
      return;
    }
  } catch {
    /* fall through to memory */
  }
  memory.set(key, value);
}

function removeItem(key: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(key);
  } catch {
    /* memory below */
  }
  memory.delete(key);
}

function isSettings(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === "string");
}

function parseRun(value: unknown): CardRun | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.monoId !== "string" || typeof row.harness !== "string" || typeof row.model !== "string") return undefined;
  if (!isSettings(row.settings)) return undefined;
  if (row.engineFast !== undefined && typeof row.engineFast !== "boolean") return undefined;
  return {
    monoId: row.monoId,
    harness: row.harness,
    model: row.model,
    settings: row.settings,
    ...(typeof row.engineFast === "boolean" ? { engineFast: row.engineFast } : {}),
  };
}

function readRuns(): CardRun[] {
  try {
    const raw = JSON.parse(getItem(KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((row) => {
      const run = parseRun(row);
      return run ? [run] : [];
    });
  } catch {
    return [];
  }
}

function writeRuns(runs: readonly CardRun[]): void {
  beforeCardRunWrite?.();
  if (!runs.length) {
    removeItem(KEY);
    return;
  }
  setItem(KEY, JSON.stringify(runs));
}

export function queueCardRun(run: CardRun): void {
  writeRuns([...readRuns().filter((row) => row.monoId !== run.monoId), run]);
}

export function peekCardRun(monoId: string): CardRun | undefined {
  return readRuns().find((row) => row.monoId === monoId);
}

/** Drops this exact queued run. False when a newer one has replaced it. */
export function dropCardRun(run: CardRun): boolean {
  const runs = readRuns();
  const key = JSON.stringify(run);
  const next = runs.filter((row) => JSON.stringify(row) !== key);
  if (next.length === runs.length) return false;
  writeRuns(next);
  return true;
}

export function resetCardRunsForTests(): void {
  beforeCardRunWrite = undefined;
  removeItem(KEY);
}

export function cardRunMatches(mono: Pick<Mono, "id" | "engine" | "engineModel" | "engineFast">, run: CardRun): boolean {
  return run.monoId === mono.id && run.harness === mono.engine && run.model === mono.engineModel && run.engineFast === mono.engineFast;
}

export function isCardHarness(value: string): value is HarnessId {
  return (HARNESSES as readonly string[]).includes(value);
}

/**
 * Applies queued card runs for sessions that are not in a turn. A busy session
 * is left alone, and a run that no longer matches the Mono is dropped.
 */
export function applyIdleCardRuns(
  sessions: readonly { id: string; busy?: boolean }[],
  apply: (sessionId: string, run: CardRun) => void,
): void {
  for (const session of sessions) {
    if (session.busy) continue;
    const mono = monoForSession(session.id);
    if (!mono || mono.sessionId !== session.id) continue;
    const run = peekCardRun(mono.id);
    if (!run) continue;
    if (!cardRunMatches(mono, run) || !isCardHarness(run.harness)) {
      dropCardRun(run);
      continue;
    }
    if (!dropCardRun(run)) continue;
    const again = findMono(mono.id);
    if (!again || !cardRunMatches(again, run)) continue;
    apply(session.id, run);
  }
}
