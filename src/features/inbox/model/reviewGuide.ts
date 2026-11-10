// WP-132b: a review guide for one GitHub pull request head, kept on this machine.
// The writer is given the diff already on screen. A late or mismatched write is dropped.

import { limitSection } from "../../../shared/lib/jsonText";
import {
  mergePrDiff,
  parsePrPatch,
  type PrDiffFile,
  type PrDiffMetaFile,
  type PrDiffStatus,
} from "../../source-control/model/prDiff";

export const REVIEW_GUIDE_TIMEOUT_MS = 45_000;
export const REVIEW_GUIDE_STORE_EVENT = "monocode:review-guide-store";

const NOTE_LIMIT = 280;
const LOCKFILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "cargo.lock",
  "bun.lock",
  "bun.lockb",
  "gemfile.lock",
  "poetry.lock",
  "composer.lock",
  "go.sum",
  "packages.lock.json",
]);

export type GuideFile = {
  path: string;
  previousPath: string | null;
  status: PrDiffStatus;
  additions: number;
  deletions: number;
  changedLines: { line: number | null; text: string }[];
};

export type GuideComment = {
  path: string;
  line: number | null;
  body: string;
  resolved: boolean;
};

export type GuideStop = {
  path: string;
  startLine: number | null;
  endLine: number | null;
  note: string;
  lookClosely: boolean;
};

export type ReviewGuide = {
  head: string;
  stops: GuideStop[];
};

export type StoredGuide = {
  revision: number;
  token: string;
  head: string;
  guide: ReviewGuide;
};

export type GuideStore = {
  read(key: string): string | null;
  write(key: string, value: string): void;
};

export type GuideAsk = (prompt: string, signal: AbortSignal) => Promise<string>;

export type GuideFailReason =
  | "unavailable"
  | "empty"
  | "no-head"
  | "dropped"
  | "stale"
  | "failed";

export type GuideWriteResult =
  | { ok: true; guide: ReviewGuide }
  | { ok: false; reason: GuideFailReason };

export function guideWriteSentence(reason: GuideFailReason): string {
  switch (reason) {
    case "unavailable":
      return "The guide writer is not available.";
    case "empty":
      return "There is nothing to guide.";
    case "no-head":
      return "This pull request has no head to write a guide for.";
    case "dropped":
      return "A newer guide was kept.";
    case "stale":
      return "This guide is out of date.";
    case "failed":
      return "The guide could not be written.";
  }
}

export function reviewGuideKey(repo: string, number: number): string | null {
  const clean = repo.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(clean)) return null;
  if (!Number.isInteger(number) || number <= 0 || number > 1_000_000_000) {
    return null;
  }
  return `monocode.reviewGuide:${clean}#${number}`;
}

export function isMechanicalFile(path: string, status: string): boolean {
  if (status === "renamed") return true;
  const lower = path.replace(/\\/g, "/").toLowerCase();
  const base = lower.split("/").pop() ?? "";
  if (LOCKFILES.has(base)) return true;
  if (lower.endsWith(".snap") || lower.includes("__snapshots__/")) return true;
  if (lower.endsWith(".min.js") || lower.endsWith(".min.css")) return true;
  if (
    lower.includes("/generated/") ||
    lower.endsWith(".generated.ts") ||
    lower.endsWith(".generated.go") ||
    lower.endsWith(".generated.rs")
  ) {
    return true;
  }
  return false;
}

export function guideFilesFromDiff(diff: {
  files: readonly PrDiffMetaFile[];
  patch: string;
}): GuideFile[] {
  const parsed = mergePrDiff(diff.files, parsePrPatch(diff.patch));
  const seen = new Set<string>();
  const files: GuideFile[] = [];
  for (const file of parsed) {
    const path = file.path.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    files.push(toGuideFile(file, path));
  }
  return files;
}

function toGuideFile(file: PrDiffFile, path: string): GuideFile {
  const changedLines: GuideFile["changedLines"] = [];
  for (const line of file.lines) {
    if (line.kind !== "add" && line.kind !== "del") continue;
    changedLines.push({
      line: line.newNumber ?? line.oldNumber,
      text: line.text,
    });
  }
  return {
    path,
    previousPath: file.previousPath,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changedLines,
  };
}

export function headFromThread(thread: unknown): string {
  if (!thread || typeof thread !== "object") return "";
  const commits = (thread as { commits?: unknown }).commits;
  if (!Array.isArray(commits)) return "";
  let best = "";
  let bestTime = Number.NEGATIVE_INFINITY;
  for (const commit of commits) {
    if (!commit || typeof commit !== "object") continue;
    const oid = (commit as { oid?: unknown }).oid;
    const date = (commit as { committedDate?: unknown }).committedDate;
    if (typeof oid !== "string" || !isHead(oid)) continue;
    if (typeof date !== "string") continue;
    const time = Date.parse(date);
    if (Number.isNaN(time)) continue;
    if (time >= bestTime) {
      bestTime = time;
      best = oid.trim();
    }
  }
  return best;
}

export function commentsFromThread(thread: unknown): GuideComment[] {
  if (!thread || typeof thread !== "object") return [];
  const comments = (thread as { comments?: unknown }).comments;
  if (!Array.isArray(comments)) return [];
  const out: GuideComment[] = [];
  for (const comment of comments) collectComment(comment, out, false);
  return out;
}

function collectComment(
  comment: unknown,
  out: GuideComment[],
  parentResolved: boolean,
) {
  if (!comment || typeof comment !== "object") return;
  const row = comment as Record<string, unknown>;
  const resolved = row.resolved === true || parentResolved;
  if (!resolved) {
    const path = typeof row.path === "string" ? row.path.trim() : "";
    const body = typeof row.body === "string" ? row.body.trim() : "";
    const line =
      typeof row.line === "number" &&
      Number.isInteger(row.line) &&
      row.line > 0
        ? row.line
        : null;
    if (path && body) out.push({ path, line, body, resolved: false });
  }
  if (Array.isArray(row.replies)) {
    for (const reply of row.replies) collectComment(reply, out, resolved);
  }
}

export function buildGuidePrompt(input: {
  head: string;
  files: readonly GuideFile[];
  comments: readonly GuideComment[];
}): string {
  const files = input.files
    .map((file) => {
      const lines = file.changedLines
        .slice(0, 8)
        .map((line) => `${line.line ?? "?"}: ${line.text}`)
        .join("\n");
      return [
        `${file.path} (${file.status}, +${file.additions} -${file.deletions}${
          isMechanicalFile(file.path, file.status) ? ", mechanical" : ""
        })`,
        lines,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
  const comments = input.comments
    .filter((comment) => comment.resolved !== true)
    .slice(0, 20)
    .map(
      (comment) =>
        `${comment.path}:${comment.line ?? "?"}\n${comment.body}`,
    )
    .join("\n\n");
  return [
    "You write a short review guide for one GitHub pull request.",
    "Return a JSON object with key stops.",
    "Do not call tools. Reply with JSON only.",
    "Rules:",
    "- stops is an array, in reading order",
    "- each stop has path, startLine, endLine, note, lookClosely",
    "- path must be one of the files below",
    "- note is one short sentence",
    "- lookClosely is true only when a person has to make a call the diff cannot",
    "- do not give any other mark",
    "- put renamed files, snapshots, and other mechanical files last",
    "- mention every file",
    "- do not discuss comments that are already resolved",
    "- cover this pull request only",
    "",
    `Head: ${input.head}`,
    "",
    "Files:",
    limitSection(files, 40_000),
    "",
    "Unresolved comments:",
    limitSection(comments || "(none)", 12_000),
  ].join("\n");
}

export function arrangeGuide(
  head: string,
  files: readonly GuideFile[],
  modelStops: unknown,
): ReviewGuide | null {
  if (!isHead(head) || !Array.isArray(modelStops) || files.length === 0) {
    return null;
  }
  const byPath = new Map<string, GuideFile>();
  for (const file of files) {
    if (!file.path || byPath.has(file.path)) continue;
    byPath.set(file.path, file);
  }
  if (byPath.size === 0) return null;
  const used = new Set<string>();
  const reading: GuideStop[] = [];
  const mechanical: GuideStop[] = [];
  const place = (
    file: GuideFile,
    note: string,
    lookClosely: boolean,
    startLine: number | null,
    endLine: number | null,
  ) => {
    if (used.has(file.path)) return;
    used.add(file.path);
    const stop = finishStop(file, note, lookClosely, startLine, endLine);
    if (isMechanicalFile(file.path, file.status)) mechanical.push(stop);
    else reading.push(stop);
  };
  for (const raw of modelStops) {
    const parsed = readModelStop(raw, byPath);
    if (!parsed) continue;
    place(
      parsed.file,
      parsed.note,
      parsed.lookClosely,
      parsed.startLine,
      parsed.endLine,
    );
  }
  for (const file of byPath.values()) {
    if (!used.has(file.path)) {
      place(file, "Changed in this pull request.", false, null, null);
    }
  }
  return { head: head.trim(), stops: [...reading, ...mechanical] };
}

export function parseGuideReply(
  raw: string,
  files: readonly GuideFile[],
  head: string,
): ReviewGuide | null {
  const rec = jsonRecord(raw);
  if (!rec || !("stops" in rec)) return null;
  return arrangeGuide(head, files, rec.stops);
}

export function guideFreshness(
  record: StoredGuide | null,
  head: string,
): "none" | "current" | "stale" {
  if (!record) return "none";
  if (!isHead(head) || record.head !== head.trim()) return "stale";
  return "current";
}

export function parseStored(raw: string | null): StoredGuide | null {
  if (!raw || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  if (
    typeof row.revision !== "number" ||
    !Number.isInteger(row.revision) ||
    row.revision < 0
  ) {
    return null;
  }
  if (typeof row.token !== "string" || !row.token.trim()) return null;
  if (typeof row.head !== "string" || !isHead(row.head)) return null;
  const guide = row.guide;
  if (!guide || typeof guide !== "object" || Array.isArray(guide)) return null;
  const guideRow = guide as Record<string, unknown>;
  if (guideRow.head !== row.head.trim()) return null;
  if (!Array.isArray(guideRow.stops)) return null;
  const stops: GuideStop[] = [];
  for (const stop of guideRow.stops) {
    const clean = readStoredStop(stop);
    if (!clean) return null;
    stops.push(clean);
  }
  return {
    revision: row.revision,
    token: row.token,
    head: row.head.trim(),
    guide: { head: row.head.trim(), stops },
  };
}

export function readReviewGuide(
  store: GuideStore,
  key: string,
): StoredGuide | null {
  try {
    return parseStored(store.read(key));
  } catch {
    return null;
  }
}

export function commitStoredGuide(
  store: GuideStore,
  key: string,
  attempt: {
    expectedRevision: number;
    basedOnHead: string;
    currentHead: string;
    guide: ReviewGuide;
    token: string;
  },
): { ok: true; revision: number } | { ok: false; reason: "dropped" | "stale" | "failed" } {
  if (
    !isHead(attempt.basedOnHead) ||
    attempt.currentHead.trim() !== attempt.basedOnHead.trim() ||
    attempt.guide.head !== attempt.basedOnHead.trim()
  ) {
    return { ok: false, reason: "stale" };
  }
  let current: StoredGuide | null;
  try {
    current = readReviewGuide(store, key);
  } catch {
    return { ok: false, reason: "failed" };
  }
  const revision = current?.revision ?? 0;
  if (revision !== attempt.expectedRevision) {
    return { ok: false, reason: "dropped" };
  }
  const nextRevision = revision + 1;
  const next: StoredGuide = {
    revision: nextRevision,
    token: attempt.token,
    head: attempt.currentHead.trim(),
    guide: attempt.guide,
  };
  try {
    store.write(key, JSON.stringify(next));
  } catch {
    return { ok: false, reason: "failed" };
  }
  const after = readReviewGuide(store, key);
  if (!after || after.token !== attempt.token || after.revision !== nextRevision) {
    return { ok: false, reason: "dropped" };
  }
  return { ok: true, revision: nextRevision };
}

const tails = new Map<string, Promise<unknown>>();

export function writeReviewGuide(input: {
  store: GuideStore;
  key: string;
  head: string;
  files: readonly GuideFile[];
  comments: readonly GuideComment[];
  ask: GuideAsk | null;
  timeoutMs: number;
  currentHead?: () => string;
  token?: string;
  queue?: boolean;
  signal?: AbortSignal;
}): Promise<GuideWriteResult> {
  if (input.queue === false) return writeReviewGuideNow(input);
  const prev = tails.get(input.key) ?? Promise.resolve();
  const run = prev.then(
    () => writeReviewGuideNow(input),
    () => writeReviewGuideNow(input),
  );
  tails.set(
    input.key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function writeReviewGuideNow(input: {
  store: GuideStore;
  key: string;
  head: string;
  files: readonly GuideFile[];
  comments: readonly GuideComment[];
  ask: GuideAsk | null;
  timeoutMs: number;
  currentHead?: () => string;
  token?: string;
  signal?: AbortSignal;
}): Promise<GuideWriteResult> {
  if (!isHead(input.head)) return { ok: false, reason: "no-head" };
  if (input.files.length === 0) return { ok: false, reason: "empty" };
  if (!input.ask) return { ok: false, reason: "unavailable" };
  if (input.signal?.aborted) return { ok: false, reason: "failed" };
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    return { ok: false, reason: "failed" };
  }
  const expectedRevision = readReviewGuide(input.store, input.key)?.revision ?? 0;
  const basedOnHead = input.head.trim();
  let raw: string;
  try {
    raw = await askWithin(
      input.ask,
      buildGuidePrompt({
        head: basedOnHead,
        files: input.files,
        comments: input.comments,
      }),
      input.timeoutMs,
      input.signal,
    );
  } catch {
    return { ok: false, reason: "failed" };
  }
  if (!raw.trim()) return { ok: false, reason: "failed" };
  const guide = parseGuideReply(raw, input.files, basedOnHead);
  if (!guide) return { ok: false, reason: "failed" };
  const currentHead = (input.currentHead?.() ?? basedOnHead).trim();
  const committed = commitStoredGuide(input.store, input.key, {
    expectedRevision,
    basedOnHead,
    currentHead,
    guide,
    token: input.token?.trim() || newToken(),
  });
  if (!committed.ok) return committed;
  return { ok: true, guide };
}

export function localReviewGuideStore(): GuideStore {
  return {
    read(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    write(key, value) {
      localStorage.setItem(key, value);
      if (typeof window === "undefined") return;
      window.dispatchEvent(new Event(REVIEW_GUIDE_STORE_EVENT));
    },
  };
}

export function subscribeReviewGuideStore(onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith("monocode.reviewGuide:")) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(REVIEW_GUIDE_STORE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(REVIEW_GUIDE_STORE_EVENT, onChange);
  };
}

function askWithin(
  ask: GuideAsk,
  prompt: string,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  const onParent = () => controller.abort();
  parent?.addEventListener("abort", onParent);
  if (parent?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<string>((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timeout"));
    }, timeoutMs);
    ask(prompt, controller.signal).then(
      (text) => {
        if (controller.signal.aborted) reject(new Error("timeout"));
        else resolve(text);
      },
      (error: unknown) => reject(error),
    );
  }).finally(() => {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener("abort", onParent);
  });
}

function newToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isHead(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value.trim());
}

function jsonRecord(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  if (start < 0) return null;
  const slice = trimmed.slice(start);
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = 0; index < slice.length; index += 1) {
    const char = slice[index];
    if (inString) {
      if (escaping) escaping = false;
      else if (char === "\\") escaping = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(slice.slice(0, index + 1));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
          }
          return parsed as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function readModelStop(
  raw: unknown,
  byPath: Map<string, GuideFile>,
): {
  file: GuideFile;
  note: string;
  lookClosely: boolean;
  startLine: number | null;
  endLine: number | null;
} | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const path = typeof row.path === "string" ? row.path.trim() : "";
  const file = byPath.get(path);
  if (!file) return null;
  return {
    file,
    note: typeof row.note === "string" ? row.note : "",
    lookClosely: isLookClosely(row.lookClosely),
    startLine: lineNumber(row.startLine),
    endLine: lineNumber(row.endLine),
  };
}

function readStoredStop(raw: unknown): GuideStop | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.path !== "string" || !row.path.trim()) return null;
  if (typeof row.note !== "string" || !row.note.trim()) return null;
  if (typeof row.lookClosely !== "boolean") return null;
  const startLine = row.startLine === null ? null : lineNumber(row.startLine);
  const endLine = row.endLine === null ? null : lineNumber(row.endLine);
  if (row.startLine !== null && startLine === null) return null;
  if (row.endLine !== null && endLine === null) return null;
  return {
    path: row.path.trim(),
    note: row.note.trim(),
    lookClosely: row.lookClosely,
    startLine,
    endLine,
  };
}

function finishStop(
  file: GuideFile,
  note: string,
  lookClosely: boolean,
  startLine: number | null,
  endLine: number | null,
): GuideStop {
  const numbers = file.changedLines.flatMap((line) =>
    line.line != null && line.line > 0 ? [line.line] : [],
  );
  const fallbackStart = numbers.length ? Math.min(...numbers) : null;
  const fallbackEnd = numbers.length ? Math.max(...numbers) : null;
  const start = startLine ?? (endLine == null ? fallbackStart : endLine);
  const end = endLine ?? (startLine == null ? fallbackEnd : startLine);
  const clean = note.replace(/\s+/g, " ").trim().slice(0, NOTE_LIMIT);
  return {
    path: file.path,
    startLine: start,
    endLine: end != null && start != null && end < start ? start : end,
    note: clean || "Changed in this pull request.",
    lookClosely,
  };
}

function isLookClosely(value: unknown): boolean {
  return value === true || value === "Look closely";
}

function lineNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}
