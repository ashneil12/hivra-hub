// WP-165: the scout record lives in the app's own store, not in the git checkout.

import type { LocalHubDisk } from "../../hub/model/localHub/localHub";
import { parseProgrammeRows, PROGRAMME_BRIEF_CAP, type ProgrammeRow } from "./programme";
import { parseScoutSettings, type ScoutSettings, SCOUT_DEFAULTS } from "./settings";

export const SCOUT_DOC_KEY = "overnight-scout";

const TRIES = 5;

/** The store did not answer. Not an empty scout, and not a saved change. */
export class ScoutStoreUnavailable extends Error {
  constructor() {
    super("unavailable");
    this.name = "ScoutStoreUnavailable";
  }
}

export type ScoutDoc = {
  settings: ScoutSettings;
  rows: ProgrammeRow[];
  briefs: Record<string, string>;
};

export function emptyScoutDoc(): ScoutDoc {
  return { settings: { ...SCOUT_DEFAULTS }, rows: [], briefs: {} };
}

function briefsFor(rows: readonly ProgrammeRow[], value: unknown): Record<string, string> {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const briefs: Record<string, string> = {};
  for (const row of rows) {
    const text = raw[row.id];
    if (typeof text !== "string" || !text.trim()) continue;
    briefs[row.id] = text.slice(0, PROGRAMME_BRIEF_CAP);
  }
  return briefs;
}

/** A document from disk. A missing or broken one is off, with no rows. */
export function parseScoutDoc(value: unknown, now = 0): ScoutDoc {
  if (!value || typeof value !== "object") return emptyScoutDoc();
  const raw = value as Record<string, unknown>;
  const rows = parseProgrammeRows(raw.rows, now);
  return {
    settings: parseScoutSettings(raw.settings),
    rows,
    briefs: briefsFor(rows, raw.briefs),
  };
}

export async function readScoutDoc(disk: LocalHubDisk, now = 0): Promise<{ doc: ScoutDoc; rev: number }> {
  try {
    const current = await disk.readDoc(SCOUT_DOC_KEY);
    return { doc: parseScoutDoc(current.value, now), rev: current.rev };
  } catch {
    throw new ScoutStoreUnavailable();
  }
}

export async function readScoutSettings(disk: LocalHubDisk): Promise<ScoutSettings> {
  return (await readScoutDoc(disk)).doc.settings;
}

function sameDoc(a: ScoutDoc, b: ScoutDoc): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Change the record on top of the revision just read. A conflict reads again.
 * A store that does not answer throws, and nothing is treated as saved.
 */
export async function changeScoutDoc(
  disk: LocalHubDisk,
  change: (doc: ScoutDoc) => ScoutDoc,
  now = 0,
): Promise<ScoutDoc> {
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const { doc, rev } = await readScoutDoc(disk, now);
    const next = change(doc);
    if (sameDoc(doc, next)) return doc;
    let written: number | null;
    try {
      written = await disk.write(SCOUT_DOC_KEY, next, rev);
    } catch {
      throw new ScoutStoreUnavailable();
    }
    if (written != null) return next;
  }
  throw new ScoutStoreUnavailable();
}
