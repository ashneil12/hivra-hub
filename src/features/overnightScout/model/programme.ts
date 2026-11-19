// WP-165: programme rows the overnight scout may write. It never starts, merges or spends.

import { securityParkReason } from "./security";

export const PROGRAMME_ROW_CAP = 200;
export const PROGRAMME_NOTE_CAP = 500;
export const PROGRAMME_TITLE_CAP = 200;
export const PROGRAMME_BRIEF_CAP = 8_000;

export const PROGRAMME_STATUSES = ["queued", "building", "pr_open", "merged", "parked", "failed"] as const;
export type ProgrammeStatus = (typeof PROGRAMME_STATUSES)[number];

export type ProgrammeRow = {
  id: string;
  wp: string;
  title: string;
  /** Relative to the project data record. Never an absolute path. */
  briefPath: string;
  branch: string;
  status: ProgrammeStatus;
  securityPark: boolean;
  draft: boolean;
  priority: number;
  notes: string;
  projectId: string;
  createdAt: number;
  updatedAt: number;
};

export type DraftCandidate = {
  source: string;
  title: string;
  /** Words the scout is allowed to judge. The fixed brief ending is not included. */
  text: string;
  wp?: string;
};

export type Placement = {
  rows: ProgrammeRow[];
  briefs: Record<string, string>;
  launched: false;
  merged: false;
  spent: false;
  notified: false;
};

const DRAFT_ID = /^draft-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function draftId(source: string, title: string): string {
  const raw = `${source}-${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return `draft-${raw || "package"}`;
}

export function briefRelativePath(id: string): string {
  return `overnight-scout/briefs/${id}.md`;
}

function clip(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Drop a path that could leave the project data record. */
export function relativeBriefPath(id: string, value: unknown): string | null {
  if (!DRAFT_ID.test(id)) return null;
  const expected = briefRelativePath(id);
  if (value !== expected) return null;
  return expected;
}

export function parseProgrammeRow(value: unknown, now: number): ProgrammeRow | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!DRAFT_ID.test(id)) return null;
  const briefPath = relativeBriefPath(id, raw.briefPath);
  if (!briefPath) return null;
  const status = raw.status;
  if (typeof status !== "string" || !PROGRAMME_STATUSES.includes(status as ProgrammeStatus)) return null;
  const title = typeof raw.title === "string" ? clip(raw.title, PROGRAMME_TITLE_CAP) : "";
  if (!title) return null;
  const projectId = typeof raw.projectId === "string" && PROJECT_ID.test(raw.projectId) ? raw.projectId : "project";
  const notes = typeof raw.notes === "string" ? clip(raw.notes, PROGRAMME_NOTE_CAP) : "";
  const wp = typeof raw.wp === "string" ? clip(raw.wp, 40) : "";
  const branch = typeof raw.branch === "string" ? clip(raw.branch, 80) : "";
  const priority = finite(raw.priority, 0);
  return {
    id,
    wp,
    title,
    briefPath,
    branch,
    status: status as ProgrammeStatus,
    securityPark: raw.securityPark === true,
    draft: raw.draft === true,
    priority: priority >= 0 && priority <= 100 ? priority : 0,
    notes,
    projectId,
    createdAt: finite(raw.createdAt, now),
    updatedAt: finite(raw.updatedAt, now),
  };
}

export function parseProgrammeRows(value: unknown, now: number): ProgrammeRow[] {
  if (!Array.isArray(value)) return [];
  const rows: ProgrammeRow[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const row = parseProgrammeRow(item, now);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
    if (rows.length >= PROGRAMME_ROW_CAP) break;
  }
  return rows;
}

function briefBody(candidate: DraftCandidate, parked: boolean): string {
  const heading = parked ? "Parked for a security check" : "Waiting for you";
  const body = clip(candidate.text, PROGRAMME_BRIEF_CAP);
  return `# ${clip(candidate.title, PROGRAMME_TITLE_CAP)}\n\n${heading}.\n\n${body}\n\nThis draft does not start work.\n`;
}

/**
 * Add at most `maxDrafts` new rows. Sensitive drafts are parked. Rows already stored are left as they are,
 * including ones that are building. Nothing here launches, merges or spends.
 */
export function placeDrafts(input: {
  enabled: boolean;
  maxDrafts: number;
  existing: readonly ProgrammeRow[];
  briefs: Readonly<Record<string, string>>;
  candidates: readonly DraftCandidate[];
  now: number;
  projectId: string;
}): Placement {
  const existing = parseProgrammeRows(input.existing, input.now);
  const briefs: Record<string, string> = {};
  for (const row of existing) {
    const text = input.briefs[row.id];
    if (typeof text === "string" && text.trim()) briefs[row.id] = text.slice(0, PROGRAMME_BRIEF_CAP);
  }
  const base: Placement = { rows: existing, briefs, launched: false, merged: false, spent: false, notified: false };
  if (input.enabled !== true) return base;
  const max = Number.isInteger(input.maxDrafts) && input.maxDrafts > 0 ? Math.min(input.maxDrafts, SCOUT_MAX_IMPORT) : 0;
  if (max === 0) return base;
  const projectId = PROJECT_ID.test(input.projectId) ? input.projectId : "project";
  const seen = new Set(existing.map((row) => row.id));
  const rows = [...existing];
  let added = 0;
  for (const candidate of input.candidates) {
    if (added >= max || rows.length >= PROGRAMME_ROW_CAP) break;
    if (!candidate || typeof candidate.title !== "string" || typeof candidate.text !== "string") continue;
    const title = clip(candidate.title, PROGRAMME_TITLE_CAP);
    if (!title) continue;
    const id = draftId(typeof candidate.source === "string" ? candidate.source : "", title);
    if (seen.has(id)) continue;
    seen.add(id);
    const reason = securityParkReason(`${title}\n${candidate.text}`);
    const parked = reason != null;
    const row: ProgrammeRow = {
      id,
      wp: typeof candidate.wp === "string" ? clip(candidate.wp, 40) : "",
      title,
      briefPath: briefRelativePath(id),
      branch: "",
      status: parked ? "parked" : "queued",
      securityPark: parked,
      draft: true,
      priority: 0,
      notes: parked ? "security-park" : "",
      projectId,
      createdAt: input.now,
      updatedAt: input.now,
    };
    rows.push(row);
    briefs[id] = briefBody(candidate, parked);
    added += 1;
  }
  return { rows, briefs, launched: false, merged: false, spent: false, notified: false };
}

/** Local alias so a bad import name cannot raise the cap. */
const SCOUT_MAX_IMPORT = 20;
