/**
 * Native subagent lineage for a parent thread.
 *
 * Claude and Codex already emit child-agent events. This folds those frames,
 * and the agent rows already stored on a session, into one list. Other CLIs
 * are labelled as not reporting children: lookalike frames are not invented
 * into a lineage. Ideas only, from T3 Code's v0.1.0 and v0.1.7 release notes.
 * No source is copied.
 */
import { formatAgentType, isAgentToolName } from "../../../integrations/harness/core/preview";
import { withoutEmDashes } from "../../../shared/text/noEmDash";

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
  /** Provider session or thread the child's own events arrive on. */
  sessionPort: string | null;
  /** Hivra session id, when that port is already a stored transcript. */
  transcriptSessionId: string | null;
};

export type Lineage =
  | { reported: false; label: typeof NOT_REPORTED_BY_CLI; children: [] }
  | { reported: true; children: LineageChild[] };

export type StoredSession = {
  id: string;
  providerSessionId?: string | null;
};

const NAME_CAP = 160;
const TEXT_CAP = 2000;

type Draft = {
  id: string;
  name: string;
  role: string | null;
  model: string | null;
  status: LineageStatus;
  result: string | null;
  error: string | null;
  sessionPort: string | null;
};

type PortHint = { port?: string; model?: string };

type AgentState = { status: LineageStatus; text: string | null };

function unreported(): Lineage {
  return { reported: false, label: NOT_REPORTED_BY_CLI, children: [] };
}

function reports(provider: string): provider is "claude" | "codex" {
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
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function usableModel(value: unknown): string | null {
  const model = trimmed(value);
  if (!model || /^(?:auto|default|inherit|unspecified)$/i.test(model)) return null;
  return model;
}

function isAgentTask(value: unknown): boolean {
  const key = trimmed(value)?.toLowerCase() ?? "";
  return key === "local_agent" || key === "remote_agent";
}

function terminal(status: LineageStatus): boolean {
  return status !== "running";
}

function claudeStatus(value: unknown): LineageStatus | null {
  const key = trimmed(value)?.toLowerCase() ?? "";
  if (key === "failed" || key === "error") return "failed";
  if (key === "killed" || key === "stopped" || key === "cancelled" || key === "canceled") {
    return "cancelled";
  }
  if (key === "completed" || key === "success" || key === "done") return "done";
  return null;
}

/** Codex settles a child from agentsStates. A spawn call returning is not enough. */
function codexStateStatus(value: unknown): LineageStatus | null {
  const key = trimmed(value)?.toLowerCase() ?? "";
  if (
    key === "errored" ||
    key === "error" ||
    key === "failed" ||
    key === "notfound" ||
    key === "not_found" ||
    key === "interrupted"
  ) {
    return "failed";
  }
  if (
    key === "completed" ||
    key === "complete" ||
    key === "done" ||
    key === "finished" ||
    key === "closed" ||
    key === "stopped" ||
    key === "cancelled" ||
    key === "canceled"
  ) {
    return "done";
  }
  return null;
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

function nameFromPath(value: unknown): string | null {
  const path = trimmed(value);
  if (!path) return null;
  const leaf = path.split(/[/\\]/).filter(Boolean).pop();
  if (!leaf) return null;
  const label = formatAgentType(leaf);
  if (!label || label === "Subagent") return null;
  return /subagent/i.test(label) ? label : `${label} subagent`;
}

function linkTranscript(port: string | null, stored: readonly StoredSession[]): string | null {
  if (!port) return null;
  const exact = stored.find((row) => row.id === port);
  if (exact) return exact.id;
  return stored.find((row) => row.providerSessionId === port)?.id ?? null;
}

function readStored(stored: readonly StoredSession[] | undefined): StoredSession[] {
  if (!stored) return [];
  return stored.flatMap((row) => {
    const rec = asRecord(row);
    const id = trimmed(rec?.id);
    if (!id) return [];
    const providerSessionId = trimmed(rec?.providerSessionId);
    return [{ id, ...(providerSessionId ? { providerSessionId } : {}) }];
  });
}

function blank(id: string): Draft {
  return {
    id,
    name: "Subagent",
    role: null,
    model: null,
    status: "running",
    result: null,
    error: null,
    sessionPort: null,
  };
}

function applyName(row: Draft, value: unknown) {
  const line = firstLine(value);
  if (!line || line === "Subagent") return;
  row.name = clip(line, NAME_CAP);
}

function applyRole(row: Draft, value: unknown) {
  const role = trimmed(value);
  if (role) row.role = role;
}

function applyModel(row: Draft, value: unknown) {
  const model = usableModel(value);
  if (model && !row.model) row.model = model;
}

function applyPort(row: Draft, value: unknown) {
  const port = trimmed(value);
  if (port && !row.sessionPort) row.sessionPort = port;
}

/**
 * A finished child stays finished. A late "running" or a success after a
 * failure does not wipe the outcome already recorded.
 */
function settle(row: Draft, status: LineageStatus, text: string | null) {
  if (row.status !== "running" && status === "running") return;
  if ((row.status === "failed" || row.status === "cancelled") && status === "done") return;
  row.status = status;
  if (row.status === "done" && text) row.result = clip(text, TEXT_CAP);
  if (row.status === "failed") {
    if (text) row.error = clip(text, TEXT_CAP);
    row.result = null;
  }
  if (row.status === "cancelled") row.result = null;
}

function toChild(row: Draft, stored: readonly StoredSession[]): LineageChild {
  return {
    id: row.id,
    name: row.name || "Subagent",
    role: row.role,
    model: row.model,
    status: row.status,
    result: row.result,
    error: row.error,
    sessionPort: row.sessionPort,
    transcriptSessionId: linkTranscript(row.sessionPort, stored),
  };
}

class ClaudeFold {
  private order: string[] = [];
  private rows = new Map<string, Draft>();
  private alias = new Map<string, string>();
  private hints = new Map<string, PortHint>();

  child(toolUseId: string | null, taskId: string | null, create: boolean): Draft | null {
    const known =
      (toolUseId && this.rows.has(toolUseId) ? toolUseId : null) ??
      (taskId ? this.alias.get(taskId) ?? null : null) ??
      (taskId && this.rows.has(taskId) ? taskId : null);
    const id = known ?? toolUseId ?? taskId;
    if (!id) return null;
    if (taskId) this.alias.set(taskId, id);
    const existing = this.rows.get(id);
    if (existing) return existing;
    if (!create) return null;
    const row = blank(id);
    this.rows.set(id, row);
    this.order.push(id);
    const hint = this.hints.get(id);
    if (hint?.port) applyPort(row, hint.port);
    if (hint?.model) applyModel(row, hint.model);
    return row;
  }

  hint(id: string, hint: PortHint) {
    const row = this.rows.get(this.alias.get(id) ?? id);
    if (row) {
      applyPort(row, hint.port);
      applyModel(row, hint.model);
      return;
    }
    const prev = this.hints.get(id) ?? {};
    this.hints.set(id, {
      port: hint.port ?? prev.port,
      model: hint.model ?? prev.model,
    });
  }

  take(): Draft[] {
    return this.order.flatMap((id) => {
      const row = this.rows.get(id);
      return row ? [row] : [];
    });
  }
}

function foldClaude(frames: readonly unknown[]): Draft[] {
  const fold = new ClaudeFold();
  for (const frame of frames) {
    const rec = asRecord(frame);
    if (!rec) continue;
    const type = trimmed(rec.type);
    const subtype = trimmed(rec.subtype);
    if (type === "system" && subtype === "task_started") {
      if (rec.ambient === true || !isAgentTask(rec.task_type)) continue;
      const row = fold.child(trimmed(rec.tool_use_id), trimmed(rec.task_id), true);
      if (!row) continue;
      applyName(row, rec.description);
      continue;
    }
    if (type === "system" && subtype === "task_progress") {
      const row = fold.child(trimmed(rec.tool_use_id), trimmed(rec.task_id), false);
      if (!row || terminal(row.status)) continue;
      applyName(row, rec.description);
      applyRole(row, rec.subagent_type);
      continue;
    }
    if (type === "system" && subtype === "task_updated") {
      const patch = asRecord(rec.patch) ?? {};
      const row = fold.child(null, trimmed(rec.task_id), false);
      if (!row) continue;
      applyName(row, patch.description);
      const status = claudeStatus(patch.status);
      if (status) settle(row, status, trimmed(patch.error));
      continue;
    }
    if (type === "system" && subtype === "task_notification") {
      if (rec.ambient === true) continue;
      const status = claudeStatus(rec.status) ?? "done";
      const row = fold.child(trimmed(rec.tool_use_id), trimmed(rec.task_id), true);
      if (!row) continue;
      settle(row, status, textContent(rec.summary));
      continue;
    }
    if (type === "system" && subtype === "background_tasks_changed") {
      const tasks = Array.isArray(rec.tasks) ? rec.tasks : [];
      for (const item of tasks) {
        const task = asRecord(item);
        if (!task || task.ambient === true || !isAgentTask(task.task_type)) continue;
        const row = fold.child(trimmed(task.tool_use_id), trimmed(task.task_id), true);
        if (!row || terminal(row.status)) continue;
        applyName(row, task.description);
      }
      continue;
    }
    const parent = trimmed(rec.parent_tool_use_id);
    if (parent) {
      const message = asRecord(rec.message);
      fold.hint(parent, {
        port: trimmed(rec.session_id) ?? undefined,
        model: usableModel(message?.model) ?? undefined,
      });
    }
    const message = asRecord(rec.message);
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const part = asRecord(block);
      if (!part) continue;
      const partType = trimmed(part.type);
      if (partType === "tool_use" && isAgentToolName(trimmed(part.name) ?? "")) {
        const row = fold.child(trimmed(part.id), null, true);
        if (!row) continue;
        const input = asRecord(part.input) ?? {};
        applyName(row, input.description ?? input.task ?? input.prompt);
        applyRole(row, input.subagent_type ?? input.subagentType ?? input.agent_type);
        applyModel(row, input.model);
        continue;
      }
      if (partType === "tool_result") {
        const row = fold.child(trimmed(part.tool_use_id), null, false);
        if (!row) continue;
        const text = textContent(part.content);
        if (part.is_error === true) settle(row, "failed", text);
        else settle(row, "done", text);
      }
    }
  }
  return fold.take();
}

class CodexFold {
  private order: string[] = [];
  private rows = new Map<string, Draft>();
  private owner = new Map<string, string>();
  private models = new Map<string, string>();
  private pending = new Map<string, AgentState>();

  row(id: string): Draft {
    const existing = this.rows.get(id);
    if (existing) return existing;
    const row = blank(id);
    this.rows.set(id, row);
    this.order.push(id);
    return row;
  }

  bind(threadId: string, callId: string) {
    if (!threadId || threadId === callId) return;
    const current = this.owner.get(threadId);
    if (current && current !== callId) return;
    this.owner.set(threadId, callId);
    const row = this.rows.get(callId);
    if (!row) return;
    applyPort(row, threadId);
    applyModel(row, this.models.get(threadId));
    const waiting = this.pending.get(threadId);
    if (waiting) {
      this.pending.delete(threadId);
      settle(row, waiting.status, waiting.text);
    }
  }

  ownedByOther(threadIds: string[], callId: string): boolean {
    return (
      threadIds.length > 0 &&
      threadIds.every((threadId) => {
        const owner = this.owner.get(threadId);
        return !!owner && owner !== callId;
      })
    );
  }

  applyStates(item: Record<string, unknown>, onlyOwner: string | null) {
    const states = asRecord(item.agentsStates) ?? asRecord(item.agents_states);
    for (const [threadId, value] of Object.entries(states ?? {})) {
      const state = asRecord(value);
      const status = codexStateStatus(state?.status);
      if (!threadId || !status) continue;
      const text = textContent(state?.message);
      const owner = this.owner.get(threadId);
      const target = onlyOwner ?? owner ?? null;
      if (!target || (owner && owner !== target)) {
        if (!owner) this.pending.set(threadId, { status, text });
        continue;
      }
      const row = this.rows.get(target);
      if (row) settle(row, status, text);
    }
  }

  closeRunning() {
    for (const row of this.rows.values()) {
      if (row.status === "running") row.status = "done";
    }
  }

  noteThread(threadId: string, model: string) {
    this.models.set(threadId, model);
    const owner = this.owner.get(threadId);
    const row = owner ? this.rows.get(owner) : undefined;
    if (row) applyModel(row, model);
  }

  take(): Draft[] {
    return this.order.flatMap((id) => {
      const row = this.rows.get(id);
      return row ? [row] : [];
    });
  }
}

function threadIds(item: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const add = (value: unknown) => {
    const id = trimmed(value);
    if (id && !ids.includes(id)) ids.push(id);
  };
  add(item.agentThreadId);
  add(item.agent_thread_id);
  const receivers = item.receiverThreadIds ?? item.receiver_thread_ids;
  if (Array.isArray(receivers)) {
    for (const value of receivers) add(value);
  }
  const states = asRecord(item.agentsStates) ?? asRecord(item.agents_states);
  for (const key of Object.keys(states ?? {})) add(key);
  return ids;
}

function itemFailed(item: Record<string, unknown>): boolean {
  const kind = trimmed(item.kind)?.toLowerCase() ?? "";
  const status = trimmed(item.status)?.toLowerCase() ?? "";
  return kind === "interrupted" || status === "failed" || status === "error";
}

function foldCodex(frames: readonly unknown[]): Draft[] {
  const fold = new CodexFold();
  for (const frame of frames) {
    const rec = asRecord(frame);
    if (!rec) continue;
    const method = trimmed(rec.method) ?? "";
    const params = asRecord(rec.params) ?? rec;
    if (method === "thread/started") {
      const thread = asRecord(params.thread);
      const threadId = trimmed(thread?.id);
      const model = usableModel(thread?.model);
      if (threadId && model) fold.noteThread(threadId, model);
      continue;
    }
    if (method === "turn/completed" || method === "turn/failed" || method === "turn/interrupted") {
      fold.closeRunning();
      continue;
    }
    if (method !== "item/started" && method !== "item/completed") continue;
    const item = asRecord(params.item);
    if (!item) continue;
    const callId = trimmed(item.id);
    const itemType = trimmed(item.type) ?? "";
    if (!callId) continue;
    if (itemType !== "collabAgentToolCall" && itemType !== "subAgentActivity") continue;
    const tool = trimmed(item.tool) ?? "";
    const threads = threadIds(item);
    const spawns = tool === "spawnAgent" || tool === "resumeAgent";
    const activity = itemType === "subAgentActivity";
    const foreign = fold.ownedByOther(threads, callId);
    if (foreign && itemFailed(item)) {
      const row = fold.row(callId);
      applyName(row, nameFromPath(item.agentPath ?? item.agent_path));
      const threadId = threads[0];
      if (threadId) applyPort(row, threadId);
      settle(row, "failed", textContent(item.message) ?? "Subagent interrupted.");
      continue;
    }
    if (foreign) {
      fold.applyStates(item, null);
      continue;
    }
    if (!spawns && !activity) continue;
    const row = fold.row(callId);
    if (spawns) {
      applyName(row, item.prompt);
      applyName(row, nameFromPath(item.agentPath ?? item.agent_path));
      applyModel(row, item.model);
    } else {
      applyName(row, nameFromPath(item.agentPath ?? item.agent_path));
    }
    for (const threadId of threads) fold.bind(threadId, callId);
    if (itemFailed(item) && !spawns) {
      settle(row, "failed", textContent(item.message) ?? "Subagent interrupted.");
    } else if (trimmed(item.status)?.toLowerCase() === "failed") {
      settle(row, "failed", textContent(item.message) ?? "Subagent operation failed.");
    }
    fold.applyStates(item, callId);
  }
  return fold.take();
}

function finish(rows: readonly Draft[], stored: readonly StoredSession[]): Lineage {
  return { reported: true, children: rows.map((row) => toChild(row, stored)) };
}

/** Fold provider frames into a lineage. Unknown providers are labelled, not invented. */
export function foldLineage(
  provider: string,
  frames: readonly unknown[],
  stored?: readonly StoredSession[],
): Lineage {
  if (!reports(provider)) return unreported();
  const sessions = readStored(stored);
  const key = provider.trim().toLowerCase();
  const rows = key === "claude" ? foldClaude(frames) : foldCodex(frames);
  return finish(rows, sessions);
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
    sessionPort: trimmed(run?.sessionPort),
    transcriptSessionId: null,
  };
}

/** The same list, read back off the agent rows a session already stored. */
export function lineageFromBlocks(
  provider: string,
  blocks: readonly unknown[],
  stored?: readonly StoredSession[],
): Lineage {
  if (!reports(provider)) return unreported();
  const sessions = readStored(stored);
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
  return {
    reported: true,
    children: rows.map((row) => ({
      ...row,
      transcriptSessionId: linkTranscript(row.sessionPort, sessions),
    })),
  };
}

function preferName(older: string, newer: string): string {
  if (newer && newer !== "Subagent") return newer;
  return older || "Subagent";
}

/** Second argument is the newer window. A running copy does not reopen a finished child. */
export function mergeLineage(older: Lineage, newer: Lineage): Lineage {
  if (!older.reported && !newer.reported) return unreported();
  if (!older.reported) return newer;
  if (!newer.reported) return older;
  const byId = new Map<string, LineageChild>();
  const order: string[] = [];
  for (const child of older.children) {
    byId.set(child.id, child);
    order.push(child.id);
  }
  for (const child of newer.children) {
    const prev = byId.get(child.id);
    if (!prev) {
      byId.set(child.id, child);
      order.push(child.id);
      continue;
    }
    byId.set(child.id, mergeChild(prev, child));
  }
  return {
    reported: true,
    children: order.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    }),
  };
}

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
    sessionPort: newer.sessionPort ?? older.sessionPort,
    transcriptSessionId: newer.transcriptSessionId ?? older.transcriptSessionId,
  };
}
