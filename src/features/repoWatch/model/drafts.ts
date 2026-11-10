// WP-166: draft upgrade rows for the programme queue. WP-159 is not in this
// tree, so the rows sit in `.hivra/repo-watch-drafts.json` until that queue
// exists. The setting starts off, and a run with it off never touches the file.

import { CHANGES_RELATIVE, githubSlug, type RepoPin } from "./pins";
import { cleanText } from "./redact";
import type { PinReport } from "./watch";

export const MAX_DRAFTS = 100;
export const DRAFT_NOTES = "Draft upgrade. Not started.";
export const DRAFT_PRIORITY = 50;

export type ProgrammeDraft = {
  id: string;
  wp: "WP-166";
  title: string;
  briefPath: typeof CHANGES_RELATIVE;
  branch: string;
  status: "queued";
  securityPark: false;
  priority: number;
  notes: typeof DRAFT_NOTES;
  createdAt: number;
};

export type SeenRelease = { url: string; tag: string };

export type DraftDocument = {
  revision: number;
  drafts: ProgrammeDraft[];
  seen: SeenRelease[];
};

export type DraftIo = {
  read(projectRoot: string): Promise<{ text: string | null }>;
  /** False when `expectedRevision` is no longer the file's revision. */
  write(projectRoot: string, text: string, expectedRevision: number): Promise<boolean>;
};

export function emptyDrafts(): DraftDocument {
  return { revision: 0, drafts: [], seen: [] };
}

/** MIT, Apache-2.0 and MPL-2.0 only. AGPL, GPL and a blank licence are not taken. */
export function allowedLicence(raw: string): "MIT" | "Apache-2.0" | "MPL-2.0" | null {
  const text = raw
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (text === "mit") return "MIT";
  if (text === "apache 2.0") return "Apache-2.0";
  if (text === "mpl 2.0") return "MPL-2.0";
  return null;
}

function safeTag(tag: string): string {
  const clean = cleanText(tag).trim();
  if (!clean || clean !== tag.trim()) return "";
  if (clean.includes("..") || !/^[A-Za-z0-9._+-]{1,80}$/.test(clean)) return "";
  return clean;
}

function branchName(owner: string, repo: string): string {
  return `upgrade-${owner}-${repo}`.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 80);
}

function draftId(owner: string, repo: string, pinSha: string, kind: string): string {
  return `repo-watch:${owner}/${repo}:${pinSha}:${kind}`.toLowerCase();
}

/**
 * One queued row per clear win: commits ahead of the pin, or a release tag
 * that differs from the tag saved last time. The first time a tag is seen is
 * remembered and is not itself a win. A second run with the same win adds nothing.
 */
export function planDrafts(
  pins: readonly RepoPin[],
  reports: readonly PinReport[],
  current: DraftDocument,
  now: number,
): { document: DraftDocument; changed: boolean } {
  const byUrl = new Map(reports.map((report) => [report.url.toLowerCase(), report]));
  const seen = new Map(current.seen.map((row) => [row.url.toLowerCase(), row.tag]));
  const drafts = [...current.drafts];
  const ids = new Set(drafts.map((row) => row.id));
  let changed = false;

  for (const pin of pins) {
    const report = byUrl.get(pin.url.toLowerCase());
    if (!report || report.status === "unchecked" || !pin.pinSha) continue;
    if (!allowedLicence(pin.licence)) continue;
    const slug = githubSlug(pin.url);
    if (!slug) continue;
    const previous = seen.get(pin.url.toLowerCase()) ?? "";
    const tag = safeTag(report.release);
    const releaseChanged = tag !== "" && previous !== "" && tag !== previous;
    if (tag && tag !== previous) {
      seen.set(pin.url.toLowerCase(), tag);
      changed = true;
    }
    const commitsAhead = report.aheadBy > 0 || report.commits.length > 0;
    if (!commitsAhead && !releaseChanged) continue;
    const kind = commitsAhead ? "commits" : `release:${tag}`;
    const id = draftId(slug.owner, slug.repo, pin.pinSha, kind);
    if (ids.has(id) || drafts.length >= MAX_DRAFTS) continue;
    const title = cleanText(`Upgrade ${slug.owner}/${slug.repo}`).replace(/\s+/g, " ").trim().slice(0, 120);
    drafts.push({
      id,
      wp: "WP-166",
      title,
      briefPath: CHANGES_RELATIVE,
      branch: branchName(slug.owner, slug.repo),
      status: "queued",
      securityPark: false,
      priority: DRAFT_PRIORITY,
      notes: DRAFT_NOTES,
      createdAt: now,
    });
    ids.add(id);
    changed = true;
  }

  return {
    document: {
      revision: current.revision,
      drafts,
      seen: [...seen.entries()].map(([url, tag]) => ({ url, tag })),
    },
    changed,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function revisionOf(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? value
    : 0;
}

function revisionIn(text: string): number {
  const match = /"revision"\s*:\s*(\d+)/.exec(text);
  if (!match) return 0;
  const value = Number(match[1]);
  return revisionOf(value);
}

function rowOf(raw: unknown): ProgrammeDraft | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const title = typeof raw.title === "string" ? cleanText(raw.title).trim() : "";
  const branch = typeof raw.branch === "string" ? raw.branch.trim() : "";
  const createdAt = raw.createdAt;
  if (!id || id.length > 200 || id.includes("..") || /[\s\\]/.test(id)) return null;
  if (!title || title.length > 120) return null;
  if (raw.briefPath !== CHANGES_RELATIVE) return null;
  if (!branch || branch.length > 80 || /[/\\]/.test(branch) || branch.includes("..")) return null;
  if (raw.status !== "queued" || raw.securityPark !== false || raw.wp !== "WP-166") return null;
  if (raw.notes !== DRAFT_NOTES) return null;
  if (typeof raw.priority !== "number" || !Number.isFinite(raw.priority)) return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  return {
    id,
    wp: "WP-166",
    title,
    briefPath: CHANGES_RELATIVE,
    branch,
    status: "queued",
    securityPark: false,
    priority: raw.priority,
    notes: DRAFT_NOTES,
    createdAt,
  };
}

function seenOf(raw: unknown): SeenRelease | null {
  if (!isRecord(raw)) return null;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const tag = typeof raw.tag === "string" ? safeTag(raw.tag) : "";
  if (!githubSlug(url) || !tag) return null;
  return { url: url.toLowerCase(), tag };
}

/** Untrusted JSON. A broken file keeps its revision and drops the rows. */
export function parseDraftDocument(text: string | null | undefined): DraftDocument {
  if (!text?.trim()) return emptyDrafts();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { revision: revisionIn(text), drafts: [], seen: [] };
  }
  if (!isRecord(parsed)) return emptyDrafts();
  const drafts: ProgrammeDraft[] = [];
  const ids = new Set<string>();
  if (Array.isArray(parsed.drafts)) {
    for (const raw of parsed.drafts) {
      const row = rowOf(raw);
      if (!row || ids.has(row.id) || drafts.length >= MAX_DRAFTS) continue;
      ids.add(row.id);
      drafts.push(row);
    }
  }
  const seen: SeenRelease[] = [];
  const seenUrls = new Set<string>();
  if (Array.isArray(parsed.seen)) {
    for (const raw of parsed.seen) {
      const row = seenOf(raw);
      if (!row || seenUrls.has(row.url)) continue;
      seenUrls.add(row.url);
      seen.push(row);
    }
  }
  return { revision: revisionOf(parsed.revision), drafts, seen };
}

export function serializeDraftDocument(doc: DraftDocument): string {
  return `${JSON.stringify(
    {
      revision: revisionOf(doc.revision),
      drafts: doc.drafts,
      seen: doc.seen,
    },
    null,
    2,
  )}\n`;
}

export function commitDrafts(
  current: DraftDocument,
  expectedRevision: number,
  next: DraftDocument,
): { ok: true; document: DraftDocument } | { ok: false; reason: "conflict" } {
  if (current.revision !== expectedRevision) return { ok: false, reason: "conflict" };
  return {
    ok: true,
    document: { ...next, revision: expectedRevision + 1 },
  };
}

/**
 * Read, merge and write. Another window's save is read again. A stop before
 * the write leaves the file alone. Nothing is written when the plan is unchanged.
 */
export async function saveDrafts(
  io: DraftIo,
  root: string,
  pins: readonly RepoPin[],
  reports: readonly PinReport[],
  now: number,
  signal?: { aborted: boolean },
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) return;
    const current = parseDraftDocument((await io.read(root)).text);
    if (signal?.aborted) return;
    const planned = planDrafts(pins, reports, current, now);
    if (!planned.changed) return;
    const committed = commitDrafts(current, current.revision, planned.document);
    if (!committed.ok) continue;
    const wrote = await io.write(root, serializeDraftDocument(committed.document), current.revision);
    if (wrote) return;
  }
}
