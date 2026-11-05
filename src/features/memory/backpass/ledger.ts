// Copyright (c) 2026 Kun Chen
// SPDX-License-Identifier: MIT
// Source: https://github.com/kunchenguid/backpass src/gap-ledger.js
// The licence text is LICENSE beside this file.
//
// Rewrite reason: the observer-identity migration is for backpass's own older ledger
// files. Hivra starts empty, so only the corroboration rules are kept: a citation
// wins, otherwise similarity, sessions are never double-counted, and merge keeps
// the shortest phrasing. The 90-day expiry is ported. Skill-body coverage is not:
// the skill-body parser was left behind with the skill write path.

import { sha256 } from "./sha";
import { similarity } from "./similarity";

/** Two gap phrasings at or above this score are one gap. */
export const GAP_SIMILARITY_THRESHOLD = 0.45;
/** A memory-file instruction this similar to a gap's proposal covers it. */
export const GAP_COVERED_THRESHOLD = 0.6;

export type GapObservation = {
  quote: string;
  firstObservedAt: string;
  observedAt: string;
  phrasings: string[];
  domain: "project" | "orchestration";
  sourceSessionId?: string;
  sightingIds?: string[];
  unattributedSightings?: boolean;
  coveredBySkill?: string;
  project?: string;
  projectRoot?: string;
};

export type GapEntry = {
  id: string;
  memoryPath: string;
  proposedInstruction: string;
  phrasings: string[];
  aliases: string[];
  sessions: Record<string, GapObservation>;
};

export type GapLedger = { version: 1; entries: Record<string, GapEntry> };

export function emptyGapLedger(): GapLedger {
  return { version: 1, entries: {} };
}

function normalize(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function gapEntryId(memoryPath: string, proposedInstruction: string): string {
  return sha256(`${memoryPath}\n${normalize(proposedInstruction)}`).slice(0, 16);
}

function gapEntryById(ledger: GapLedger, id: string): GapEntry | null {
  const direct = ledger.entries[id];
  if (direct) return direct;
  return Object.values(ledger.entries).find((entry) => (entry.aliases || []).includes(id)) || null;
}

/** The ledger entry a proposed instruction belongs to, or null. Same file only. */
export function findGapEntry(ledger: GapLedger, memoryPath: string, proposedInstruction: string): GapEntry | null {
  let best: GapEntry | null = null;
  let bestScore = 0;
  for (const entry of Object.values(ledger.entries)) {
    if (entry.memoryPath !== memoryPath) continue;
    const phrasings = [...new Set([entry.proposedInstruction, ...(entry.phrasings || [])])];
    const score = Math.max(...phrasings.map((phrasing) => similarity(phrasing, proposedInstruction)));
    if (score >= GAP_SIMILARITY_THRESHOLD && score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}

export type Sighting = {
  sessionId: string;
  quote: string;
  proposedInstruction: string;
  file: string;
  matchesGap?: string;
  observedAt: string;
};

/**
 * Record sightings. A 16-hex citation wins over a lexical match. An unknown citation,
 * or one on another file, falls through. The same session is not counted twice.
 * The shortest phrasing stays the canonical one.
 */
export function recordSightings(ledger: GapLedger, sightings: Sighting[]): GapLedger {
  for (const sighting of sightings) {
    if (!sighting.sessionId || !sighting.proposedInstruction) continue;
    const cited =
      typeof sighting.matchesGap === "string" && /^[0-9a-f]{16}$/.test(sighting.matchesGap)
        ? gapEntryById(ledger, sighting.matchesGap)
        : null;
    const citedHere = cited && cited.memoryPath === sighting.file ? cited : null;
    const entry = citedHere ?? findGapEntry(ledger, sighting.file, sighting.proposedInstruction);
    if (!entry) {
      const id = gapEntryId(sighting.file, sighting.proposedInstruction);
      ledger.entries[id] = {
        id,
        memoryPath: sighting.file,
        proposedInstruction: sighting.proposedInstruction,
        phrasings: [sighting.proposedInstruction],
        aliases: [],
        sessions: {
          [sighting.sessionId]: {
            quote: sighting.quote,
            firstObservedAt: sighting.observedAt,
            observedAt: sighting.observedAt,
            phrasings: [sighting.proposedInstruction],
            domain: "project",
            sourceSessionId: sighting.sessionId,
            sightingIds: [sighting.sessionId],
          },
        },
      };
      continue;
    }
    const prior = entry.sessions[sighting.sessionId];
    if (!prior) {
      entry.sessions[sighting.sessionId] = {
        quote: sighting.quote,
        firstObservedAt: sighting.observedAt,
        observedAt: sighting.observedAt,
        phrasings: [sighting.proposedInstruction],
        domain: "project",
        sourceSessionId: sighting.sessionId,
        sightingIds: [sighting.sessionId],
      };
    } else {
      const earlier = Date.parse(sighting.observedAt) < Date.parse(prior.firstObservedAt);
      if (earlier) prior.firstObservedAt = sighting.observedAt;
      prior.phrasings = [...new Set([...(prior.phrasings || []), sighting.proposedInstruction])];
    }
    entry.phrasings = [
      ...new Set([entry.proposedInstruction, ...(entry.phrasings || []), sighting.proposedInstruction]),
    ];
    if (sighting.proposedInstruction.length < entry.proposedInstruction.length) {
      entry.proposedInstruction = sighting.proposedInstruction;
    }
  }
  return ledger;
}

export function sessionCount(entry: GapEntry): number {
  return Object.keys(entry.sessions).length;
}

function hasUnattributedSightings(observation: GapObservation): boolean {
  return Boolean(observation.unattributedSightings || !observation.sourceSessionId);
}

/**
 * Merge groups the consolidation pass judged to be one gap. Unknown ids, cross-path
 * groups, and groups under two known entries are dropped. Sessions are not double-counted.
 * The shortest phrasing stays canonical. Returns how many entries were absorbed.
 */
export function mergeGapEntries(ledger: GapLedger, groups: unknown): number {
  let absorbed = 0;
  const claimed = new Set<string>();
  for (const group of Array.isArray(groups) ? groups : []) {
    const ids = [...new Set((Array.isArray(group) ? group : []).map(String))].filter(
      (id) => ledger.entries[id] && !claimed.has(id),
    );
    if (ids.length < 2) continue;
    const paths = new Set(ids.map((id) => ledger.entries[id].memoryPath));
    if (paths.size !== 1) continue;
    for (const id of ids) claimed.add(id);

    const entries = ids.map((id) => ledger.entries[id]);
    const target = entries.reduce((best, e) =>
      Object.keys(e.sessions).length > Object.keys(best.sessions).length ? e : best,
    );
    for (const entry of entries) {
      if (entry === target) continue;
      for (const [sessionId, obs] of Object.entries(entry.sessions)) {
        const prior = target.sessions[sessionId];
        if (!prior) {
          target.sessions[sessionId] = obs;
        } else {
          const earlier =
            Date.parse(obs.firstObservedAt || obs.observedAt) < Date.parse(prior.firstObservedAt || prior.observedAt);
          if (earlier) prior.firstObservedAt = obs.firstObservedAt || obs.observedAt;
          if (prior.domain === "orchestration" && obs.domain !== "orchestration") prior.domain = "project";
          if (!prior.coveredBySkill && obs.coveredBySkill) prior.coveredBySkill = obs.coveredBySkill;
          if (!prior.project && obs.project) prior.project = obs.project;
          if (!prior.projectRoot && obs.projectRoot) prior.projectRoot = obs.projectRoot;
          prior.sightingIds = [...new Set([...(prior.sightingIds || []), ...(obs.sightingIds || [])])];
          if (hasUnattributedSightings(prior) || hasUnattributedSightings(obs)) prior.unattributedSightings = true;
          prior.phrasings = [
            ...new Set([
              ...(prior.phrasings || [target.proposedInstruction]),
              ...(obs.phrasings || [entry.proposedInstruction]),
            ]),
          ];
        }
      }
      target.aliases = [...new Set([...(target.aliases || []), entry.id, ...(entry.aliases || [])])];
      target.phrasings = [
        ...new Set([
          target.proposedInstruction,
          ...(target.phrasings || []),
          entry.proposedInstruction,
          ...(entry.phrasings || []),
        ]),
      ];
      if (entry.proposedInstruction.length < target.proposedInstruction.length) {
        target.proposedInstruction = entry.proposedInstruction;
      }
      delete ledger.entries[entry.id];
      absorbed += 1;
    }
  }
  return absorbed;
}

/**
 * A duration like `90d`. `all` and `0` mean no age limit. Anything else is also
 * no age limit: a bad value from disk must not wipe the ledger.
 */
export function parseSince(since: string | null | undefined): number | null {
  if (since === null || since === undefined || since === "all" || since === "0") return null;
  const match = String(since)
    .trim()
    .match(/^(\d+)\s*([dhwm])$/i);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  const ms: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const size = ms[unit];
  return size === undefined ? null : n * size;
}

/**
 * Drop sightings first seen more than `maxAge` ago. Skill coverage is not applied.
 */
export function pruneGapLedger(
  ledger: GapLedger,
  options: { maxAge?: string | null; nowMs: number },
): { expired: number } {
  const maxAgeMs = parseSince(options.maxAge ?? "90d");
  const cutoff = maxAgeMs === null ? Number.NEGATIVE_INFINITY : options.nowMs - maxAgeMs;
  let expired = 0;
  for (const [id, entry] of Object.entries(ledger.entries)) {
    for (const [sessionId, obs] of Object.entries(entry.sessions)) {
      const when = Date.parse(obs.firstObservedAt || obs.observedAt);
      if (!Number.isFinite(when) || when < cutoff) {
        expired += 1;
        delete entry.sessions[sessionId];
      }
    }
    if (!Object.keys(entry.sessions).length) delete ledger.entries[id];
  }
  return { expired };
}
