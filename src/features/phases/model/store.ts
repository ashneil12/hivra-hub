// WP-84: one phase record per task. A write lands only on the version it read.

import { persistDocs } from "./files";
import { addComment, answer, begin, finishRun, phaseView, rearm, removeTask, running, setPath, type FinishResult, type Run, type Work } from "./machine";
import { isPath, readSettings, type PhaseSettings, type TaskHint } from "./settings";

type Bucket = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem?(key: string): void };

const memory = new Map<string, string>();
const memoryBucket: Bucket = {
  getItem: (key) => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key, value) => memory.set(key, value),
  removeItem: (key) => memory.delete(key),
};

const works = new Map<string, Work>();
const listeners = new Set<() => void>();
const crewTasks = new Map<string, string>();
const LOCK_MS = 3_000;

function bucket(): Bucket {
  const candidate = (globalThis as { localStorage?: Bucket }).localStorage;
  if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
  return memoryBucket;
}

function keyFor(taskId: string): string | undefined {
  if (!taskId || taskId.includes("/") || taskId.includes("\\") || taskId.includes("..")) return undefined;
  return `hivra:phase-work:${taskId}`;
}

function lockKey(taskId: string): string | undefined {
  const key = keyFor(taskId);
  return key ? `${key}:lock` : undefined;
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

/** An id that does not start again at phase-1 when the screen opens. */
export function commentId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") return `phase-${cryptoObj.randomUUID()}`;
  const bytes = new Uint8Array(16);
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") cryptoObj.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return `phase-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function isComment(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const comment = value as Record<string, unknown>;
  return typeof comment.id === "string" && typeof comment.text === "string" && typeof comment.used === "boolean";
}

function isDoc(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const doc = value as Record<string, unknown>;
  return (
    Number.isInteger(doc.number) &&
    typeof doc.phase === "string" &&
    typeof doc.title === "string" &&
    typeof doc.body === "string" &&
    typeof doc.fileName === "string" &&
    Array.isArray(doc.comments) &&
    (doc.comments as unknown[]).every(isComment)
  );
}

function isRun(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value as Record<string, unknown>;
  return typeof run.id === "string" && typeof run.phase === "string" && typeof run.skill === "string" && typeof run.status === "string" && Array.isArray(run.steering);
}

function isWork(value: unknown): value is Work {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.taskId === "string" &&
    Number.isInteger(record.version) &&
    isPath(record.path) &&
    Array.isArray(record.docs) &&
    (record.docs as unknown[]).every(isDoc) &&
    Array.isArray(record.runs) &&
    (record.runs as unknown[]).every(isRun) &&
    typeof record.why === "string" &&
    (record.taskComments === undefined || (Array.isArray(record.taskComments) && (record.taskComments as unknown[]).every(isComment)))
  );
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

/** Writes the saved value and leaves the copy this window already holds. */
export function plantPhaseRaw(taskId: string, raw: string): void {
  const key = keyFor(taskId);
  if (!key) return;
  bucket().setItem(key, raw);
}

function takeLock(taskId: string): string | undefined {
  const key = lockKey(taskId);
  if (!key) return "none";
  const now = Date.now();
  const raw = bucket().getItem(key);
  if (raw) {
    try {
      const held = JSON.parse(raw) as { token?: unknown; at?: unknown };
      if (typeof held.token === "string" && typeof held.at === "number" && now >= held.at && now - held.at < LOCK_MS) return undefined;
    } catch {
      // A broken lock is not a writer. Take it.
    }
  }
  const token = commentId();
  bucket().setItem(key, JSON.stringify({ token, at: now }));
  try {
    const check = JSON.parse(bucket().getItem(key) ?? "") as { token?: unknown };
    if (check.token !== token) return undefined;
  } catch {
    return undefined;
  }
  return token;
}

function dropLock(taskId: string, token: string): void {
  if (token === "none") return;
  const key = lockKey(taskId);
  if (!key) return;
  try {
    const held = JSON.parse(bucket().getItem(key) ?? "") as { token?: unknown };
    if (held.token === token) bucket().removeItem?.(key);
  } catch {
    // Already gone.
  }
}

/** A test holds the lock the way another window would. */
export function holdForeignLock(taskId: string): void {
  const key = lockKey(taskId);
  if (!key) return;
  bucket().setItem(key, JSON.stringify({ token: "other-window", at: Date.now() }));
}

/** Another window wrote this key. Equal versions still replace the copy we hold. */
export function notePhaseStorage(key: string | null): void {
  if (!key?.startsWith("hivra:phase-work:") || key.endsWith(":lock")) return;
  const taskId = key.slice("hivra:phase-work:".length);
  const stored = readStored(taskId);
  const held = works.get(taskId);
  if (!stored) return;
  if (!held || stored.version > held.version || (stored.version === held.version && stored.stamp !== undefined && stored.stamp !== held.stamp)) {
    works.set(taskId, stored);
    notify();
  }
}

function installStorageListener(): void {
  const target = (globalThis as { window?: { addEventListener?: (type: string, listener: (event: { key: string | null }) => void) => void } }).window;
  if (!target || typeof target.addEventListener !== "function") return;
  const flag = globalThis as { __hivraPhaseStorage?: boolean };
  if (flag.__hivraPhaseStorage) return;
  flag.__hivraPhaseStorage = true;
  target.addEventListener("storage", (event) => notePhaseStorage(event.key));
}

installStorageListener();

/** The work on record, or nothing when the saved value is missing or garbage. */
export function workFor(taskId: string): Work | undefined {
  const stored = readStored(taskId);
  const held = works.get(taskId);
  if (stored && (!held || stored.version > held.version || (stored.version === held.version && stored.stamp !== undefined && stored.stamp !== held.stamp))) {
    works.set(taskId, stored);
  }
  return works.get(taskId);
}

/** Lands `next` only when the record is still `expectedVersion`. The other window keeps its write. */
export function commitWork(next: Work, expectedVersion: number): { stale: boolean; work: Work } {
  const token = takeLock(next.taskId);
  if (!token) {
    const current = readStored(next.taskId) ?? works.get(next.taskId);
    if (current) works.set(next.taskId, current);
    return { stale: true, work: current ?? next };
  }
  try {
    const current = readStored(next.taskId) ?? works.get(next.taskId);
    if (current && current.version !== expectedVersion) {
      works.set(next.taskId, current);
      return { stale: true, work: current };
    }
    if (!Number.isInteger(next.version) || next.version !== expectedVersion + 1) {
      return { stale: true, work: current ?? next };
    }
    const stamped: Work = { ...next, stamp: commentId() };
    works.set(next.taskId, stamped);
    writeStored(stamped);
    const seen = readStored(next.taskId);
    if (!seen || seen.stamp !== stamped.stamp) {
      if (seen) works.set(next.taskId, seen);
      return { stale: true, work: seen ?? current ?? next };
    }
    notify();
    return { stale: false, work: stamped };
  } finally {
    dropLock(next.taskId, token);
  }
}

/** A fixture's starting point. Two live windows use commitWork instead. */
export function seedWork(work: Work): void {
  const stamped: Work = { ...work, stamp: work.stamp ?? commentId() };
  works.set(work.taskId, stamped);
  writeStored(stamped);
  notify();
}

export type Crew = (run: Run, work: Work) => FinishResult | Promise<FinishResult>;

let crew: Crew | undefined;

/** A dev copy sets this to the fake Claude. Nothing here starts a real login. */
export function setPhaseCrew(next: Crew | undefined): void {
  crew = next;
}

type PhaseFiles = { root: string; write: (path: string, body: string) => void };

let files: PhaseFiles | undefined;

/** Where a finished phase document is written. No root means the record still holds it. */
export function setPhaseFiles(next: PhaseFiles | undefined): void {
  files = next;
}

let onBuild: ((work: Work) => void) | undefined;

/** Called once when the build phase is written, so the normal crew path can start. */
export function setPhaseBuild(next: ((work: Work) => void) | undefined): void {
  onBuild = next;
}

const builds: string[] = [];

function noteBuild(work: Work): void {
  if (builds.includes(work.taskId)) return;
  builds.push(work.taskId);
  try {
    onBuild?.(work);
  } catch {
    // The handoff can fail. The record still says building.
  }
}

function persist(work: Work): void {
  if (!files) return;
  try {
    persistDocs(files.root, work.taskId, work.docs, files.write);
  } catch {
    // A write that fails is not a finished phase. The record still holds the document.
  }
}

/** Runs the open phase until it waits, is building, or the crew stays quiet. A timeout is tried once more. */
async function drive(work: Work, ids: () => string): Promise<Work> {
  let current = work;
  let quietTries = 0;
  for (let step = 0; step < 12; step += 1) {
    let run = running(current);
    if (!run) {
      if (quietTries >= 1) return current;
      const armed = rearm(current, ids);
      if (!running(armed)) return current;
      const bumped = { ...armed, version: current.version + 1 };
      const committed = commitWork(bumped, current.version);
      if (committed.stale) return committed.work;
      current = committed.work;
      run = running(current);
      if (!run) return current;
      quietTries += 1;
    }
    if (!crew) return current;
    const reply = await Promise.resolve()
      .then(() => crew!(run, current))
      .catch(() => ({ unreachable: true }) as FinishResult);
    const finished = finishRun(current, current.version, run.id, reply, ids);
    if (finished.stale) return current;
    const wasBuilding = current.building;
    const committed = commitWork(finished.work, current.version);
    if (committed.stale) return committed.work;
    current = committed.work;
    persist(current);
    if (!wasBuilding && current.building) noteBuild(current);
    const done = current.runs.find((item) => item.id === run.id);
    if (done?.status === "retry") {
      if (quietTries >= 1) return current;
      continue;
    }
    quietTries = 0;
    if (current.waiting || current.removed || !running(current)) return current;
  }
  return current;
}

/** Starts the phases for a task, or keeps going from the record already there. */
export async function startPhaseWork(taskId: string, hint: TaskHint, settingsRaw: unknown, ids: () => string): Promise<Work | undefined> {
  const existing = workFor(taskId);
  if (existing?.removed) return existing;
  if (existing) return drive(existing, ids);
  const work = begin(taskId, hint, settingsRaw, ids);
  const committed = commitWork(work, 0);
  if (committed.stale) return committed.work;
  return drive(committed.work, ids);
}

export async function answerWork(taskId: string, choice: string, words: string, ids: () => string): Promise<{ stale: boolean; work?: Work }> {
  const current = workFor(taskId);
  if (!current) return { stale: true };
  const result = answer(current, current.version, choice, words, ids);
  if (result.stale || result.refused) return { stale: true, work: current };
  const committed = commitWork(result.work, current.version);
  if (committed.stale) return { stale: true, work: committed.work };
  return { stale: false, work: await drive(committed.work, ids) };
}

function writeComment(taskId: string, text: string, id: string, target: { kind: "task" } | { kind: "doc"; docNumber: number }): void {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = workFor(taskId);
    if (!current) return;
    const result = addComment(current, current.version, target, text, id);
    if (result.stale) continue;
    if (result.refused || result.work === current) return;
    const committed = commitWork(result.work, current.version);
    if (!committed.stale) return;
  }
}

export function noteTaskComment(taskId: string, text: string, id: string): void {
  writeComment(taskId, text, id, { kind: "task" });
}

export function noteDocComment(taskId: string, docNumber: number, text: string, id: string): void {
  writeComment(taskId, text, id, { kind: "doc", docNumber });
}

export async function changePath(taskId: string, path: string, ids: () => string): Promise<void> {
  const current = workFor(taskId);
  if (!current) return;
  const result = setPath(current, current.version, path, ids);
  if (result.stale || result.work === current) return;
  const committed = commitWork(result.work, current.version);
  if (committed.stale) return;
  await drive(committed.work, ids);
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

/** The shared task a crew row moves, when the delegation itself does not name one. */
export function bindCrew(delegationId: string, taskId: string): void {
  if (!delegationId.trim() || !taskId.trim()) return;
  crewTasks.set(delegationId, taskId);
}

/** The worker's own task id wins. Otherwise the id recorded when the crew started. */
export function taskForCrew(delegationId: string, workerTaskId?: string | null): string {
  const named = typeof workerTaskId === "string" ? workerTaskId.trim() : "";
  if (named) return named;
  return crewTasks.get(delegationId) ?? "";
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
