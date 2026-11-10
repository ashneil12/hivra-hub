// WP-138: the one-line note from a new worktree. The session row does not store it.
// A value from disk or another process is untrusted, so only a short first line is kept.

import { pathKey } from "../../../shared/lib/paths";

/** Long enough for every warning the copy can build, short enough that it cannot be a file. */
const MAX_LINE = 600;

export type WorktreeIncludeLines = {
  note?: string;
  warning?: string;
};

type Remembered = WorktreeIncludeLines & { path: string };

const remembered = new Map<string, Remembered>();

/** The first line, with control characters removed. Anything longer is dropped, not cut. */
export function worktreeIncludeLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const first = value.split(/\r\n|\n|\r/, 1)[0] ?? "";
  let text = "";
  for (const char of first) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) continue;
    text += char;
  }
  text = text.trim();
  if (!text || text.length > MAX_LINE) return undefined;
  return text;
}

/**
 * Keep a create result for this chat. A later list of worktrees has no note, so an
 * empty result does not clear one already kept. Returns the lines safe to show.
 */
export function rememberWorktreeInclude(
  sessionId: string,
  tree: { path?: string; includeNote?: string; includeWarning?: string },
): WorktreeIncludeLines {
  const note = worktreeIncludeLine(tree.includeNote);
  const warning = worktreeIncludeLine(tree.includeWarning);
  const lines: WorktreeIncludeLines = {
    ...(note ? { note } : {}),
    ...(warning ? { warning } : {}),
  };
  if (!sessionId || !tree.path || (!note && !warning)) return lines;
  remembered.set(sessionId, { path: tree.path, ...lines });
  return lines;
}

/**
 * Lines for the chat header. Fields on the session win. After a reload from the
 * session row, the kept note is used only while this chat is still on that worktree.
 */
export function worktreeIncludeLines(session: {
  id: string;
  worktreeCwd?: string;
  includeNote?: string;
  includeWarning?: string;
}): WorktreeIncludeLines {
  const note = worktreeIncludeLine(session.includeNote);
  const warning = worktreeIncludeLine(session.includeWarning);
  if (note || warning) {
    return {
      ...(note ? { note } : {}),
      ...(warning ? { warning } : {}),
    };
  }
  const saved = session.id ? remembered.get(session.id) : undefined;
  if (!saved || !session.worktreeCwd) return {};
  if (pathKey(saved.path) !== pathKey(session.worktreeCwd)) return {};
  return {
    ...(saved.note ? { note: saved.note } : {}),
    ...(saved.warning ? { warning: saved.warning } : {}),
  };
}

/** The lines a create result carries, safe to show. */
export function worktreeIncludeLinesOf(tree: {
  includeNote?: string;
  includeWarning?: string;
}): WorktreeIncludeLines {
  const note = worktreeIncludeLine(tree.includeNote);
  const warning = worktreeIncludeLine(tree.includeWarning);
  return {
    ...(note ? { note } : {}),
    ...(warning ? { warning } : {}),
  };
}

/**
 * A worktree from a fresh listing, with the note and warning of the create result that
 * made it. A listing never has them, so a picker that re-reads the list after a create
 * would otherwise lose a failed copy.
 */
export function withCreatedInclude<T extends { includeNote?: string; includeWarning?: string }>(
  listed: T,
  created: { includeNote?: string; includeWarning?: string },
): T {
  const lines = worktreeIncludeLinesOf(created);
  if (!lines.note && !lines.warning) return listed;
  return {
    ...listed,
    ...(lines.note ? { includeNote: lines.note } : {}),
    ...(lines.warning ? { includeWarning: lines.warning } : {}),
  };
}

/** Test hook. A window starts with nothing kept. */
export function resetWorktreeIncludeNotes() {
  remembered.clear();
}
