// WP-85. A terminal session joins the chat list for its folder, with a mark the sidebar can read.

import { sameProjectPath } from "../../projects/model/recents";
import type { SessionSummary } from "../../sessions/data/sessionStore";
import type { TerminalSession } from "../../../../plugins/hivra-mirror/src/book.ts";
import type { MirrorBlock } from "../../../../plugins/hivra-mirror/src/mapper.ts";
// Pulls the plugin into the app's type check. The plugin stays free of app imports.
import "./plugin";

export type TerminalMarkInfo = { state: string; folder: string };

export function terminalStateLabel(state: string): string {
  switch (state) {
    case "running":
      return "Running";
    case "idle":
      return "Idle";
    case "waiting":
      return "Waiting";
    case "stopped":
      return "Stopped";
    default:
      return "Running";
  }
}

export function terminalStatusText(info: TerminalMarkInfo): string {
  return `${terminalStateLabel(info.state)} · ${info.folder}`;
}

export function terminalSummary(session: TerminalSession): SessionSummary {
  return {
    id: `terminal:${session.id}`,
    cwd: session.folder,
    harness: "claude",
    model: "claude",
    runtimeMode: "supervised",
    title: session.title || "Terminal",
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
    terminal: { state: session.state, folder: session.folder },
  };
}

/** Sessions for other folders stay out. A row already in the list is not added twice. */
export function mergeTerminalSessions(
  rows: readonly SessionSummary[],
  terminals: readonly TerminalSession[],
  cwd: string,
): SessionSummary[] {
  if (!cwd || cwd === "~") return [...rows];
  const ids = new Set(rows.map((row) => row.id));
  const extra = terminals
    .filter((session) => session.folder && sameProjectPath(session.folder, cwd))
    .map(terminalSummary)
    .filter((row) => !ids.has(row.id));
  return [...extra, ...rows];
}

export function terminalSessionId(rowId: string): string | null {
  return rowId.startsWith("terminal:") ? rowId.slice("terminal:".length) : null;
}

const STATES = new Set(["running", "idle", "waiting", "stopped"]);

function clean(value: unknown, max = 500): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, max);
}

function lineKind(value: unknown): "add" | "del" | "context" | null {
  if (value === "add" || value === "del" || value === "context") return value;
  return null;
}

function asBlock(value: unknown): MirrorBlock | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = clean(row.id, 200);
  const role = row.role;
  if (!id || (role !== "user" && role !== "assistant" && role !== "tool" && role !== "approval")) return null;
  const text = clean(row.text, 100_000);
  if (!text) return null;
  const block: MirrorBlock = { id, role, text };
  if (row.tool && typeof row.tool === "object" && !Array.isArray(row.tool)) {
    const tool = row.tool as { title?: unknown; preview?: unknown };
    const preview = tool.preview;
    if (preview && typeof preview === "object" && !Array.isArray(preview)) {
      const lines = (preview as { lines?: unknown }).lines;
      if (Array.isArray(lines)) {
        const kept = lines.flatMap((line) => {
          if (!line || typeof line !== "object") return [];
          const item = line as { kind?: unknown; text?: unknown };
          const kind = lineKind(item.kind);
          if (!kind) return [];
          return [{ kind, text: clean(item.text, 2_000) }];
        });
        if (kept.length) block.tool = { title: clean(tool.title, 200) || text, preview: { kind: "write", lines: kept.slice(0, 400) } };
      }
    }
  }
  return block;
}

/** A list from the app is untrusted. A bad row is left out, not thrown. */
export function sessionsFromWire(value: unknown): TerminalSession[] {
  if (!Array.isArray(value)) return [];
  const sessions: TerminalSession[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const id = clean(row.id, 200);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const state = typeof row.state === "string" && STATES.has(row.state) ? row.state : "running";
    const permission = row.pendingPermission;
    let pending: TerminalSession["pendingPermission"];
    if (permission && typeof permission === "object" && !Array.isArray(permission)) {
      const ask = permission as { requestId?: unknown; tool?: unknown };
      const requestId = clean(ask.requestId, 200);
      if (requestId) pending = { requestId, tool: clean(ask.tool, 200) || "Tool" };
    }
    sessions.push({
      id,
      title: clean(row.title, 200) || "Terminal",
      folder: clean(row.folder),
      state: state as TerminalSession["state"],
      blocks: Array.isArray(row.blocks)
        ? row.blocks.flatMap((item) => {
            const block = asBlock(item);
            return block ? [block] : [];
          })
        : [],
      updatedAt: typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
      ...(pending ? { pendingPermission: pending } : {}),
    });
  }
  return sessions;
}
