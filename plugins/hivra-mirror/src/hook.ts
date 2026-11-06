// WP-85. One hook invocation. Hivra down, or a session Hivra started, is silence: Claude Code carries on.

import { mapEvent } from "./mapper.ts";
import { discover, hivraPid, hivraStarted } from "./protocol.ts";
import { loadTranscript, transcriptEvents } from "./transcript.ts";
import { hookDecision, type Steer } from "./steer.ts";

/** Mapped frames the loopback port stores. Unknown events are left out. */
export function toWire(raw: unknown): unknown[] {
  const mapped = mapEvent(raw);
  if (mapped.kind === "ignore") return [];
  if (mapped.kind === "blocks") {
    return mapped.blocks.map((block) => ({
      kind: "block",
      sessionId: mapped.sessionId,
      block,
      ...(mapped.state ? { state: mapped.state } : {}),
      ...(mapped.permission ? { permission: mapped.permission } : {}),
    }));
  }
  return [mapped];
}

export type HookResult = {
  silent: boolean;
  frames: unknown[];
  output: string | null;
};

function asSteer(value: unknown): Steer | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { kind?: unknown; text?: unknown; requestId?: unknown; allow?: unknown; answers?: unknown };
  if (row.kind === "reply" && typeof row.text === "string" && row.text.trim()) return { kind: "reply", text: row.text };
  if (row.kind === "stop") return { kind: "stop" };
  if (row.kind === "permission" && typeof row.requestId === "string" && typeof row.allow === "boolean") {
    const answers =
      row.answers && typeof row.answers === "object" && !Array.isArray(row.answers)
        ? (row.answers as Record<string, string>)
        : undefined;
    return { kind: "permission", requestId: row.requestId, allow: row.allow, ...(answers ? { answers } : {}) };
  }
  return null;
}

export function sessionIdOf(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const row = event as { sessionId?: unknown; session_id?: unknown; id?: unknown; kind?: unknown; type?: unknown };
  const kind = typeof row.kind === "string" ? row.kind : typeof row.type === "string" ? row.type : "";
  if (kind === "session" || kind === "sessionstart") return typeof row.id === "string" ? row.id : "";
  if (typeof row.sessionId === "string") return row.sessionId;
  if (typeof row.session_id === "string") return row.session_id;
  return "";
}

/** The loopback message. The hook name is how a reply knows it is the next turn. */
export function eventsEnvelope(hook: string, frames: unknown[]): { type: "events"; hook: string; events: unknown[] } {
  return { type: "events", hook, events: frames };
}

export function requestIdOf(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const row = event as { requestId?: unknown; request_id?: unknown };
  if (typeof row.requestId === "string" && row.requestId.trim()) return row.requestId.trim();
  if (typeof row.request_id === "string" && row.request_id.trim()) return row.request_id.trim();
  return "";
}

export function steersFrom(values: unknown[]): Steer[] {
  return values.flatMap((item) => {
    const steer = asSteer(item);
    return steer ? [steer] : [];
  });
}

function transcriptOf(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const row = event as { transcript?: unknown; transcript_path?: unknown };
  if (typeof row.transcript === "string") return row.transcript;
  if (typeof row.transcript_path === "string") return row.transcript_path;
  return "";
}

/**
 * Pure hook step. `send` is the loopback call. A throw or a refusal is silence, and the session still works.
 * Transcript lines are included when the path is allowed. A refused path is not read.
 */
export function onHook(input: {
  env: Readonly<Record<string, string | undefined>>;
  ancestors: readonly number[];
  running: unknown;
  alive: boolean;
  event: unknown;
  readFile: (file: string) => string;
  send: (frames: unknown[]) => { ok: boolean; steers: unknown[] };
}): HookResult {
  const quiet = { silent: true, frames: [], output: null };
  if (hivraStarted(input.env, input.ancestors, hivraPid(input.running))) return quiet;
  const found = discover({ running: input.running, alive: input.alive });
  if (!found.mirror) return quiet;
  const frames: unknown[] = [];
  const transcript = transcriptOf(input.event);
  if (transcript) {
    const loaded = loadTranscript(transcript, input.readFile);
    if (!loaded.refused && loaded.text) {
      const sid = sessionIdOf(input.event);
      for (const line of transcriptEvents(loaded.text)) {
        if (line && typeof line === "object" && !Array.isArray(line) && sid) {
          const row = line as Record<string, unknown>;
          if (typeof row.sessionId !== "string" && typeof row.session_id !== "string") row.sessionId = sid;
        }
        frames.push(line);
      }
    }
  }
  frames.push(input.event);
  let sent: { ok: boolean; steers: unknown[] };
  try {
    sent = input.send(frames);
  } catch {
    return quiet;
  }
  if (!sent.ok) return quiet;
  const steers = steersFrom(sent.steers);
  const eventName =
    input.event && typeof input.event === "object"
      ? String((input.event as { hook_event_name?: unknown; type?: unknown }).hook_event_name ?? (input.event as { type?: unknown }).type ?? "")
      : "";
  return { silent: false, frames, output: hookDecision(eventName, steers, requestIdOf(input.event)) };
}
