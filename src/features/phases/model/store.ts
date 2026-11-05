// WP-84: one phase record per task. A write lands only on the version it read.

import { addComment, answer, finishRun, phaseView, removeTask, running, setPath, type FinishResult, type Work } from "./machine";
import { isPath, readSettings, type PhaseSettings } from "./settings";

type Bucket = { getItem(key: string): string | null; setItem(key: string, value: string): void };

const memory = new Map<string, string>();
const memoryBucket: Bucket = {
  getItem: (key) => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key, value) => memory.set(key, value),
};

const works = new Map<string, Work>();
const listeners = new Set<() => void>();

function bucket(): Bucket {
  const candidate = (globalThis as { localStorage?: Bucket }).localStorage;
  if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
  return memoryBucket;
}

function keyFor(taskId: string): string | undefined {
  if (!taskId || taskId.includes("/") || taskId.includes("\\") || taskId.includes("..")) return undefined;
  return `hivra:phase-work:${taskId}`;
}

function settingsKey(projectKey: string): string {
  const safe = projectKey.replace(/[^A-Za-z0-9._:-]+/g, "_").slice(0, 200);
  return `hivra:phase-settings:${safe}`;
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribePhase(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function isWork(value: unknown): value is Work {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.taskId === "string" && Number.isInteger(record.version) && isPath(record.path) && Array.isArray(record.docs) && Array.isArray(record.runs) && typeof record.why === "string";
}

function readStored(taskId: string): Work | undefined {
  const key = keyFor(taskId);
  if (!key) return undefined;
  const raw = bucket().getItem(key);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isWork(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeStored(work: Work): void {
  const key = keyFor(work.taskId);
  if (!key) return;
  bucket().setItem(key, JSON.stringify(work));
}

/** A test plants a raw saved value. Garbage must read back as no phase work. */
export function writePhaseRaw(taskId: string, raw: string): void {
  const key = keyFor(taskId);
  if (!key) return;
  works.delete(taskId);
  bucket().setItem(key, raw);
}

/** The work on record, or nothing when the saved value is missing or garbage. */
export function workFor(taskId: string): Work | undefined {
  const stored = readStored(taskId);
  const held = works.get(taskId);
  if (stored && (!held || stored.version > held.version)) works.set(taskId, stored);
  return works.get(taskId);
}

/** Lands `next` only when the record is still `expectedVersion`. The other window keeps its write. */
export function commitWork(next: Work, expectedVersion: number): { stale: boolean; work: Work } {
  const current = readStored(next.taskId) ?? works.get(next.taskId);
  if (current && current.version !== expectedVersion) {
    works.set(next.taskId, current);
    return { stale: true, work: current };
  }
  if (!Number.isInteger(next.version) || next.version !== expectedVersion + 1) {
    return { stale: true, work: current ?? next };
  }
  works.set(next.taskId, next);
  writeStored(next);
  notify();
  return { stale: false, work: next };
}

/** A fixture's starting point. Two live windows use commitWork instead. */
export function seedWork(work: Work): void {
  works.set(work.taskId, work);
  writeStored(work);
  notify();
}

export type Crew = (run: NonNullable<ReturnType<typeof running>>, work: Work) => FinishResult;

let crew: Crew | undefined;

/** A dev copy sets this to the fake Claude. Nothing here starts a real login. */
export function setPhaseCrew(next: Crew | undefined): void {
  crew = next;
}

function drive(work: Work, ids: () => string): Work {
  const run = running(work);
  if (!run || !crew) return work;
  const reply = crew(run, work);
  const finished = finishRun(work, work.version, run.id, reply, ids);
  if (finished.stale) return work;
  const committed = commitWork(finished.work, work.version);
  return committed.work;
}

export function answerWork(taskId: string, choice: string, words: string, ids: () => string): { stale: boolean; work?: Work } {
  const current = workFor(taskId);
  if (!current) return { stale: true };
  const result = answer(current, current.version, choice, words, ids);
  if (result.stale || result.refused) return { stale: true, work: current };
  const committed = commitWork(result.work, current.version);
  if (committed.stale) return { stale: true, work: committed.work };
  return { stale: false, work: drive(committed.work, ids) };
}

export function noteTaskComment(taskId: string, text: string, id: string): void {
  const current = workFor(taskId);
  if (!current) return;
  const result = addComment(current, current.version, { kind: "task" }, text, id);
  if (!result.stale && !result.refused && result.work !== current) commitWork(result.work, current.version);
}

export function noteDocComment(taskId: string, docNumber: number, text: string, id: string): void {
  const current = workFor(taskId);
  if (!current) return;
  const result = addComment(current, current.version, { kind: "doc", docNumber }, text, id);
  if (!result.stale && !result.refused && result.work !== current) commitWork(result.work, current.version);
}

export function changePath(taskId: string, path: string, ids: () => string): void {
  const current = workFor(taskId);
  if (!current) return;
  const result = setPath(current, current.version, path, ids);
  if (!result.stale && result.work !== current) commitWork(result.work, current.version);
}

export function dropWork(taskId: string): void {
  const current = workFor(taskId);
  if (!current) return;
  const result = removeTask(current, current.version);
  if (!result.stale) commitWork(result.work, current.version);
}

export function phaseFor(taskId: string): ReturnType<typeof phaseView> | undefined {
  const work = workFor(taskId);
  return work ? phaseView(work) : undefined;
}

export function loadPhaseSettings(projectKey: string): PhaseSettings {
  const raw = bucket().getItem(settingsKey(projectKey));
  if (!raw) return readSettings(undefined);
  try {
    return readSettings(JSON.parse(raw) as unknown);
  } catch {
    return readSettings(undefined);
  }
}

export function savePhaseSettings(projectKey: string, raw: unknown): PhaseSettings {
  const settings = readSettings(raw);
  bucket().setItem(settingsKey(projectKey), JSON.stringify(settings));
  return settings;
}
