// Copyright (c) 2026 Kun Chen
// SPDX-License-Identifier: MIT
// Source: https://github.com/kunchenguid/backpass src/state.js (rejection memory)
// The licence text is LICENSE beside this file.
//
// A rejected edit stays rejected until it is backed by strictly more transcripts.
// Add, rewrite and remove also match on gap or instruction ids. Extract and move
// stay hunk-key only. A reason never revives an edit.

import type { Hunk } from "./diff";
import { sha256 } from "./sha";

export const REJECT_REASONS = ["wrong-evidence", "already-covered", "too-narrow", "too-broad", "disagree"] as const;

const IDENTITY_KINDS = new Set(["add", "rewrite", "remove"]);

export type RejectReason = (typeof REJECT_REASONS)[number];

export type RejectEdit = {
  kind: string;
  file: string;
  title?: string;
  transcripts?: number;
  find?: string;
  replace?: string;
  hunks?: (Pick<Hunk, "find" | "replace"> & { file?: string })[];
  gapIds?: string[];
  instructionIds?: string[];
};

export type RejectionEntry = {
  kind: string;
  file: string;
  title?: string;
  transcripts: number;
  rejectedAt: string;
  gapIds?: string[];
  instructionIds?: string[];
  reason?: RejectReason;
};

export type Rejections = { entries: Record<string, RejectionEntry> };

export function emptyRejections(): Rejections {
  return { entries: {} };
}

export function normalizeRejectReason(reason: unknown): RejectReason | undefined {
  const token = String(reason || "")
    .trim()
    .toLowerCase();
  return (REJECT_REASONS as readonly string[]).includes(token) ? (token as RejectReason) : undefined;
}

function intersects(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || !right.length) return false;
  const other = new Set(right);
  return left.some((id) => other.has(id));
}

export function rejectionKey(edit: RejectEdit): string {
  let body: string;
  if (Array.isArray(edit.hunks)) {
    const files = new Set(edit.hunks.map((hunk) => hunk.file || edit.file).filter(Boolean));
    body = edit.hunks
      .map((hunk) =>
        files.size > 1 ? `${hunk.file || edit.file}\u0000${hunk.find}\u0000${hunk.replace}` : `${hunk.find}\u0000${hunk.replace}`,
      )
      .join("\u0001");
  } else {
    body = `${edit.find || ""}\u0000${edit.replace || ""}`;
  }
  return sha256([edit.kind, edit.file, body].join(" ")).slice(0, 16);
}

export function isSuppressedByRejection(edit: RejectEdit, rejections: Rejections | null | undefined): boolean {
  const entries = rejections?.entries || {};
  const transcripts = edit.transcripts || 0;
  const prior = entries[rejectionKey(edit)];
  if (prior && transcripts <= (prior.transcripts || 0)) return true;
  if (!IDENTITY_KINDS.has(edit.kind)) return false;
  for (const remembered of Object.values(entries)) {
    if (remembered.kind !== edit.kind || remembered.file !== edit.file) continue;
    if (transcripts > (remembered.transcripts || 0)) continue;
    if (intersects(edit.gapIds, remembered.gapIds) || intersects(edit.instructionIds, remembered.instructionIds)) {
      return true;
    }
  }
  return false;
}

export function recordRejection(edit: RejectEdit, rejections: Rejections, at: string, reason?: unknown): Rejections {
  const entry: RejectionEntry = {
    kind: edit.kind,
    file: edit.file,
    title: edit.title,
    transcripts: edit.transcripts || 0,
    rejectedAt: at,
  };
  if (Array.isArray(edit.gapIds) && edit.gapIds.length) entry.gapIds = [...edit.gapIds];
  if (Array.isArray(edit.instructionIds) && edit.instructionIds.length) entry.instructionIds = [...edit.instructionIds];
  const normalized = normalizeRejectReason(reason);
  if (normalized) entry.reason = normalized;
  rejections.entries[rejectionKey(edit)] = entry;
  return rejections;
}
