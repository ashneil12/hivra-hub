// WP-85. Hook payloads and transcript lines become Hivra chat blocks.
// The same block id updates in place. Empty text and unknown kinds are ignored.
// A diff is a preview on the tool block. A permission prompt is an approval block.

export type MirrorPreviewLine = { kind: "add" | "del" | "context"; text: string };

export type MirrorBlock = {
  id: string;
  role: "user" | "assistant" | "tool" | "approval";
  text: string;
  tool?: {
    callId?: string;
    title?: string;
    kind?: string;
    status?: string;
    detail?: string;
    preview?: { kind: "write"; lines: MirrorPreviewLine[] };
    command?: string;
  };
  approval?: {
    requestId: number;
    call?: { tool: string; command?: string };
  };
};

export type SessionState = "running" | "idle" | "waiting" | "stopped";

export type Mapped =
  | { kind: "ignore" }
  | {
      kind: "session";
      id: string;
      folder: string;
      title: string;
      state: SessionState;
      transcript?: string;
    }
  | {
      kind: "blocks";
      sessionId: string;
      blocks: MirrorBlock[];
      state?: SessionState;
      permission?: { requestId: string; tool: string };
    }
  | { kind: "status"; sessionId: string; state: SessionState };

const STATES = new Set<SessionState>(["running", "idle", "waiting", "stopped"]);

function textOf(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
}

function cleanId(value: unknown): string {
  if (typeof value !== "string") return "";
  const id = value.replace(/[\u0000-\u001f]/g, "").trim();
  return id.slice(0, 200);
}

function cleanTitle(value: unknown): string {
  const title = textOf(value).replace(/[\u0000-\u001f]/g, "").slice(0, 200);
  return title || "Terminal";
}

function asState(value: unknown): SessionState | null {
  return typeof value === "string" && STATES.has(value as SessionState) ? (value as SessionState) : null;
}

function eventKind(row: Record<string, unknown>): string {
  return (textOf(row.kind) || textOf(row.type) || textOf(row.hook_event_name)).toLowerCase();
}

function numericId(text: string): number {
  let n = 0;
  for (const char of text) n = (Math.imul(n, 33) + char.charCodeAt(0)) >>> 0;
  return n || 1;
}

export function diffPreview(diff: string): { kind: "write"; lines: MirrorPreviewLine[] } | null {
  const body = diff.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!body.trim()) return null;
  const lines: MirrorPreviewLine[] = [];
  for (const line of body.split("\n")) {
    if (!line || line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) lines.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) lines.push({ kind: "del", text: line.slice(1) });
    else lines.push({ kind: "context", text: line.startsWith(" ") ? line.slice(1) : line });
    if (lines.length >= 400) break;
  }
  return lines.length ? { kind: "write", lines } : null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const row = part as { type?: unknown; text?: unknown };
      if (row.type === "text") return textOf(row.text);
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function toolUses(content: unknown): { id: string; name: string; input: unknown }[] {
  if (!Array.isArray(content)) return [];
  const uses = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const row = part as { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
    if (row.type !== "tool_use") continue;
    const name = textOf(row.name);
    if (!name) continue;
    uses.push({ id: cleanId(row.id) || `tool-${uses.length}-${name}`, name, input: row.input });
  }
  return uses;
}

function toolBlock(id: string, name: string, detail: string, diff: string, command: string): MirrorBlock | null {
  const preview = diffPreview(diff);
  if (!name && !detail && !preview) return null;
  const block: MirrorBlock = {
    id,
    role: "tool",
    text: name || "Tool",
    tool: {
      title: name || "Tool",
      kind: "tool",
      ...(detail ? { detail } : {}),
      ...(preview ? { preview } : {}),
      ...(command ? { command } : {}),
    },
  };
  return block;
}

function fromRecord(row: Record<string, unknown>): Mapped {
  const kind = eventKind(row);
  if (kind === "session" || kind === "sessionstart") {
    const id = cleanId(row.id) || cleanId(row.sessionId) || cleanId(row.session_id);
    if (!id) return { kind: "ignore" };
    const transcript = textOf(row.transcript) || textOf(row.transcript_path);
    return {
      kind: "session",
      id,
      folder: textOf(row.folder) || textOf(row.cwd) || "",
      title: cleanTitle(row.title),
      state: asState(row.state) ?? "running",
      ...(transcript ? { transcript } : {}),
    };
  }
  const sessionId = cleanId(row.sessionId) || cleanId(row.session_id);
  if (kind === "status" || kind === "stop") {
    if (!sessionId) return { kind: "ignore" };
    return { kind: "status", sessionId, state: asState(row.state) ?? (kind === "stop" ? "idle" : "running") };
  }
  if (!sessionId && kind !== "user" && kind !== "assistant") return { kind: "ignore" };
  return { kind: "ignore" };
}

function blocksFrom(row: Record<string, unknown>): Mapped {
  const kind = eventKind(row);
  const sessionId = cleanId(row.sessionId) || cleanId(row.session_id) || "session";
  if (kind === "user" || kind === "userpromptsubmit") {
    const text = textOf(row.text) || textOf(row.prompt) || contentText(row.message && typeof row.message === "object" ? (row.message as { content?: unknown }).content : row.content);
    if (!text) return { kind: "ignore" };
    const id = cleanId(row.id) || cleanId(row.uuid) || `user-${numericId(text)}`;
    return { kind: "blocks", sessionId, blocks: [{ id, role: "user", text }], state: "running" };
  }
  if (kind === "assistant") {
    const message = row.message && typeof row.message === "object" ? (row.message as { content?: unknown }) : null;
    const content = message?.content ?? row.content;
    const text = textOf(row.text) || contentText(content);
    const blocks: MirrorBlock[] = [];
    if (text) {
      const id = cleanId(row.id) || cleanId(row.uuid) || `assistant-${numericId(text)}`;
      blocks.push({ id, role: "assistant", text });
    }
    for (const use of toolUses(content)) {
      const input = use.input && typeof use.input === "object" ? (use.input as Record<string, unknown>) : {};
      const diff = textOf(input.diff) || textOf(row.diff);
      const detail = textOf(input.command) || textOf(JSON.stringify(use.input ?? ""));
      const block = toolBlock(use.id, use.name, detail === '""' ? "" : detail, diff, textOf(input.command));
      if (block) blocks.push(block);
    }
    if (!blocks.length) return { kind: "ignore" };
    return { kind: "blocks", sessionId, blocks };
  }
  if (kind === "tool" || kind === "posttooluse" || kind === "diff") {
    const name = textOf(row.name) || textOf(row.tool_name) || textOf(row.tool);
    const detail = textOf(row.detail) || textOf(row.output) || textOf(row.tool_response);
    const diff = textOf(row.diff);
    const id = cleanId(row.id) || cleanId(row.tool_use_id) || `tool-${numericId(name + detail + diff)}`;
    const block = toolBlock(id, name, detail, diff, textOf(row.command));
    if (!block) return { kind: "ignore" };
    return { kind: "blocks", sessionId, blocks: [block] };
  }
  if (kind === "permission" || kind === "permissionrequest") {
    const requestId = textOf(row.requestId) || textOf(row.request_id);
    const tool = textOf(row.tool) || textOf(row.tool_name) || "Tool";
    if (!requestId && !tool) return { kind: "ignore" };
    const id = cleanId(row.id) || `perm-${requestId || tool}`;
    return {
      kind: "blocks",
      sessionId,
      state: "waiting",
      permission: requestId ? { requestId, tool } : undefined,
      blocks: [
        {
          id,
          role: "approval",
          text: `Allow ${tool}?`,
          approval: { requestId: numericId(requestId || tool), call: { tool } },
        },
      ],
    };
  }
  return { kind: "ignore" };
}

/** One hook payload or one transcript line. Unknown shapes and empty text are ignored, not errors. */
export function mapEvent(raw: unknown): Mapped {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { kind: "ignore" };
  const row = raw as Record<string, unknown>;
  const kind = eventKind(row);
  if (kind === "session" || kind === "sessionstart" || kind === "status" || kind === "stop") return fromRecord(row);
  if (!kind) return { kind: "ignore" };
  return blocksFrom(row);
}
