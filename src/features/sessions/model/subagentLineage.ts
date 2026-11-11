import { withoutEmDashes } from "../../../shared/text/noEmDash";
/**
 * Native subagents on a parent thread.
 *
 * Claude and Codex already report their children, and the adapters already fold those frames into agent rows
 * (a tool block with its `agentRun`): name, model, status, the report it handed back. This reads the children off
 * those rows, so the list is the same one the transcript shows, built from what the app stored. Other CLIs are
 * labelled as not reporting children: an agent-looking row there is not turned into a list. Ideas only, from T3
 * Code's v0.1.0 and v0.1.7 release notes. No source is copied.
 */

export const NOT_REPORTED_BY_CLI = "not reported by this CLI";

export type LineageStatus = "running" | "done" | "failed" | "cancelled";

export type LineageChild = {
  id: string;
  name: string;
  role: string | null;
  model: string | null;
  status: LineageStatus;
  result: string | null;
  error: string | null;
};

export type Lineage =
  | { reported: false; label: typeof NOT_REPORTED_BY_CLI; children: [] }
  | { reported: true; children: LineageChild[] };

const NAME_CAP = 160;
const TEXT_CAP = 2000;

function unreported(): Lineage {
  return { reported: false, label: NOT_REPORTED_BY_CLI, children: [] };
}

function reports(provider: string): boolean {
  const key = provider.trim().toLowerCase();
  return key === "claude" || key === "codex";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function stringish(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? value : null;
}

function trimmed(value: unknown): string | null {
  const raw = stringish(value);
  if (!raw) return null;
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  return text || null;
}

function firstLine(value: unknown): string | null {
  const text = trimmed(value);
  if (!text) return null;
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  return line || null;
}

function plain(value: string): string {
  return withoutEmDashes(value).trim();
}

function clip(value: string, max: number): string {
  const text = plain(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}\u2026`;
}

function usableModel(value: unknown): string | null {
  const model = trimmed(value);
  if (!model || /^(?:auto|default|inherit|unspecified)$/i.test(model)) return null;
  return model;
}

function textContent(value: unknown): string | null {
  if (typeof value === "string") return trimmed(value);
  if (!Array.isArray(value)) return null;
  const parts = value.flatMap((part) => {
    if (typeof part === "string") return trimmed(part) ? [trimmed(part)!] : [];
    const rec = asRecord(part);
    if (!rec) return [];
    const text = trimmed(rec.text) ?? trimmed(rec.content);
    return text ? [text] : [];
  });
  const joined = parts.join("\n").trim();
  return joined || null;
}

function blockStatus(value: unknown): LineageStatus {
  const key = trimmed(value)?.toLowerCase() ?? "";
  if (key === "failed" || key === "error") return "failed";
  if (key === "killed" || key === "stopped" || key === "cancelled" || key === "canceled") {
    return "cancelled";
  }
  if (key === "completed" || key === "success" || key === "done") return "done";
  return "running";
}

function childFromBlock(block: unknown): LineageChild | null {
  const rec = asRecord(block);
  if (!rec || trimmed(rec.role) !== "tool") return null;
  if (rec.workflowRun != null) return null;
  const tool = asRecord(rec.tool);
  const kind = trimmed(tool?.kind)?.toLowerCase() ?? "";
  if (kind === "workflow") return null;
  const run = asRecord(rec.agentRun);
  if (kind !== "agent" && kind !== "task" && kind !== "subagent" && !run) return null;
  const id = trimmed(tool?.callId) ?? trimmed(rec.id);
  if (!id) return null;
  const status = blockStatus(tool?.status);
  const detail = textContent(tool?.detail);
  const name = firstLine(run?.name ?? tool?.title ?? rec.text) ?? "Subagent";
  return {
    id,
    name: name === "Subagent" ? name : clip(name, NAME_CAP),
    role: trimmed(run?.agentType),
    model: usableModel(run?.model),
    status,
    result: status === "done" ? (detail ? clip(detail, TEXT_CAP) : null) : null,
    error: status === "failed" ? (detail ? clip(detail, TEXT_CAP) : null) : null,
  };
}

function preferName(older: string, newer: string): string {
  if (newer && newer !== "Subagent") return newer;
  return older || "Subagent";
}

/** The same call seen twice. A running copy does not reopen a finished child. */
function mergeChild(older: LineageChild, newer: LineageChild): LineageChild {
  const status =
    newer.status === "running" && older.status !== "running" ? older.status : newer.status;
  const closed = status === "failed" || status === "cancelled";
  return {
    id: older.id,
    name: preferName(older.name, newer.name),
    role: newer.role ?? older.role,
    model: newer.model ?? older.model,
    status,
    result: closed ? null : (newer.result ?? older.result),
    error: status === "failed" ? (newer.error ?? older.error) : null,
  };
}

/**
 * What the parent thread shows for the children its agent started, read off the agent rows the session already
 * holds. A CLI that does not report children gets the label instead of a list, and only when a row there looks
 * like an agent. Null when nothing in the thread started one, so the pane renders nothing.
 */
export function lineageForThread(
  provider: string,
  blocks: readonly unknown[],
): Lineage | null {
  const rows: LineageChild[] = [];
  const index = new Map<string, number>();
  for (const block of blocks) {
    const child = childFromBlock(block);
    if (!child) continue;
    const at = index.get(child.id);
    if (at == null) {
      index.set(child.id, rows.length);
      rows.push(child);
      continue;
    }
    rows[at] = mergeChild(rows[at]!, child);
  }
  if (rows.length === 0) return null;
  return reports(provider) ? { reported: true, children: rows } : unreported();
}

const TALLY_ORDER: ReadonlyArray<readonly [LineageStatus, string]> = [
  ["running", "working"],
  ["done", "done"],
  ["failed", "failed"],
  ["cancelled", "stopped"],
];

/**
 * What the list says about its children before it is opened: how many are in each state. It is the whole list in
 * one line, so a thread with a dozen children costs one row until the reader asks for the rest.
 */
export function lineageTally(children: readonly LineageChild[]): string {
  return TALLY_ORDER.flatMap(([status, word]) => {
    const count = children.filter((child) => child.status === status).length;
    return count > 0 ? [`${count} ${word}`] : [];
  }).join(", ");
}
