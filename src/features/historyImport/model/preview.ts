// Agent Zero's preview() counts chats and projects before import (MIT,
// Copyright (c) 2025 Agent Zero, s.r.o.). Licence: vendor/agent-zero-LICENSE.
//
// Agent Zero parses the whole upload. Hivra reads only the header the lister
// already took (the first 8192 bytes) and the result keeps none of that text,
// so a preview cannot show or hold a message.

import type { ListReport, Preview, SourceId } from "./types";
import { parseTranscript } from "./parse";
import { projectName } from "./text";

type Seen = { id: string; project: string; from: number | null; to: number | null; mtimeMs: number };

function sessionsInHeader(source: SourceId, filePath: string, header: string, mtimeMs: number): Seen[] {
  const found = header.trim() ? parseTranscript(source, filePath, header) : [];
  if (found.length === 0) {
    return [{ id: filePath, project: projectName(null, filePath), from: mtimeMs, to: mtimeMs, mtimeMs }];
  }
  return found.map((conversation) => {
    const times = conversation.messages.map((message) => message.timestamp);
    return {
      id: conversation.id,
      project: conversation.project,
      from: times.length ? Math.min(...times) : mtimeMs,
      to: times.length ? Math.max(...times) : mtimeMs,
      mtimeMs,
    };
  });
}

function emptyPreview(missing: boolean): Preview {
  return {
    missing,
    conversations: 0,
    from: null,
    to: null,
    projects: [],
    files: [],
    active: 0,
    duplicates: 0,
    secretsNote: 0,
    tooBig: 0,
    links: 0,
    database: false,
    truncated: false,
  };
}

/** Counts, dates and projects. The header is not copied onto the result. */
export function previewFrom(source: SourceId, reports: readonly ListReport[]): Preview {
  if (reports.length === 0) return emptyPreview(true);
  const preview = emptyPreview(reports.every((report) => report.missing));
  const byId = new Map<string, Seen>();
  for (const report of reports) {
    preview.active += report.active;
    preview.links += report.links;
    preview.database = preview.database || report.database;
    preview.truncated = preview.truncated || report.truncated;
    if (report.missing) continue;
    for (const file of report.files) {
      preview.files.push({ path: file.path, bytes: file.bytes, mtimeMs: file.mtimeMs });
      if (file.tooBig) {
        preview.tooBig += 1;
        continue;
      }
      for (const session of sessionsInHeader(source, file.path, file.header, file.mtimeMs)) {
        const prev = byId.get(session.id);
        if (!prev) {
          byId.set(session.id, session);
          continue;
        }
        preview.duplicates += 1;
        if (session.mtimeMs >= prev.mtimeMs) byId.set(session.id, session);
      }
    }
  }
  const projects = new Map<string, number>();
  for (const session of byId.values()) {
    preview.conversations += 1;
    preview.from = preview.from == null ? session.from : Math.min(preview.from, session.from ?? session.mtimeMs);
    preview.to = preview.to == null ? session.to : Math.max(preview.to, session.to ?? session.mtimeMs);
    projects.set(session.project, (projects.get(session.project) ?? 0) + 1);
  }
  preview.projects = [...projects.entries()]
    .map(([name, conversations]) => ({ name, conversations }))
    .sort((a, b) => b.conversations - a.conversations || a.name.localeCompare(b.name));
  return preview;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function rangeText(from: number | null, to: number | null): string {
  if (from == null) return "no date";
  const start = formatDay(from);
  const end = to == null ? start : formatDay(to);
  return start === end ? start : `${start} to ${end}`;
}
