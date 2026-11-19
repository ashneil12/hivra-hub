// WP-88: an answer is only what was read. A line that names something unread is dropped.

import { cleanLine } from "../../home/model/lines";
import { resolveProject, type CopyProject } from "./reads";

export type ReadingKind = "task" | "doc" | "decision" | "chat";

export type Reading = {
  kind: ReadingKind;
  id: string;
  projectId: string;
  text: string;
  stuck: boolean;
};

export type AnswerLine = {
  kind: ReadingKind;
  id: string;
  projectId: string;
  text: string;
};

export type AskResult =
  | { kind: "lines"; lines: AnswerLine[] }
  | { kind: "question"; text: string }
  | { kind: "file"; projectId: string; title: string };

const TOKEN = /\b(task|doc|decision|chat):([A-Za-z0-9_-]+)\b/g;

function keyOf(kind: string, id: string): string {
  return `${kind}:${id}`;
}

/** Lines whose every id was read. A made-up id drops the whole line. The wording shown is the reading's, not the reply's. */
export function linesFromReply(reply: string, readings: readonly Reading[]): AnswerLine[] {
  const byKey = new Map(readings.map((reading) => [keyOf(reading.kind, reading.id), reading]));
  const out: AnswerLine[] = [];
  const seen = new Set<string>();
  for (const raw of reply.replace(/\r\n?/g, "\n").split("\n")) {
    const tokens = [...raw.matchAll(TOKEN)];
    if (!tokens.length) continue;
    if (tokens.some((token) => !byKey.has(keyOf(token[1], token[2])))) continue;
    for (const token of tokens) {
      const key = keyOf(token[1], token[2]);
      if (seen.has(key)) continue;
      seen.add(key);
      const reading = byKey.get(key);
      if (!reading) continue;
      out.push({ kind: reading.kind, id: reading.id, projectId: reading.projectId, text: cleanLine(reading.text) });
    }
  }
  return out;
}

export type QuestionKind = "happening" | "stuck" | "decision" | "work";

/** The three questions the chat answers. Anything else is a request to file work, not to do it. */
export function questionKind(text: string): QuestionKind {
  const q = text.replace(/\r\n?/g, " ").replace(/\s+/g, " ").trim().toLowerCase().replace(/[.?!]+$/g, "");
  if (!q) return "work";
  if (/what(?:'s| is|s) (?:going on|happening)/.test(q)) return "happening";
  if (/what(?:'s| is|s) stuck/.test(q)) return "stuck";
  if (/what did we decide/.test(q)) return "decision";
  return "work";
}

/** A name or id as its own word. "crew" is not inside "screw", and "a.b" is not "axb". */
function mentions(text: string, needle: string): boolean {
  const wanted = needle.trim();
  if (!wanted) return false;
  const body = wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, "u").test(text);
}

function topicOf(text: string): string {
  const match = /\babout\s+(.+)$/i.exec(text.trim());
  return match?.[1]?.replace(/[?.!]+$/g, "").trim().toLowerCase() ?? "";
}

function shown(reading: Reading, projects: readonly CopyProject[]): string {
  const project = projects.find((item) => item.id === reading.projectId);
  const text = cleanLine(reading.text);
  return project && text ? `${project.name} · ${text}` : text || project?.name || reading.id;
}

function asLines(readings: readonly Reading[], projects: readonly CopyProject[]): AnswerLine[] {
  const seen = new Set<string>();
  const out: AnswerLine[] = [];
  for (const reading of readings) {
    const key = keyOf(reading.kind, reading.id);
    if (!reading.id || seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: reading.kind, id: reading.id, projectId: reading.projectId, text: shown(reading, projects) });
  }
  return out;
}

/**
 * Answer from readings, or file into one named project. It does not start the work.
 * Nothing loaded yet is a retry, not an empty answer.
 */
export function askChief(
  text: string,
  input: { readings: readonly Reading[]; projects: readonly CopyProject[]; loaded: boolean },
): AskResult {
  const kind = questionKind(text);
  if (!input.loaded && kind !== "work") return { kind: "question", text: "I couldn't read that just now. Try again." };
  if (kind === "happening") return { kind: "lines", lines: asLines(input.readings, input.projects) };
  if (kind === "stuck") return { kind: "lines", lines: asLines(input.readings.filter((reading) => reading.stuck), input.projects) };
  if (kind === "decision") {
    const topic = topicOf(text);
    const decisions = input.readings.filter((reading) => reading.kind === "decision" || reading.kind === "doc");
    const matched = topic
      ? decisions.filter((reading) => reading.text.toLowerCase().includes(topic))
      : decisions.filter((reading) => reading.kind === "decision");
    return { kind: "lines", lines: asLines(matched, input.projects) };
  }
  const trimmed = text.trim();
  // With no project there is nowhere to file it: asking which one would be a question with no answer.
  if (trimmed && !input.projects.length) return { kind: "question", text: "There are no projects yet. Add one first, then tell it what to do." };
  if (!trimmed) return { kind: "question", text: "Which project should this go in?" };
  const named = input.projects.filter((project) => mentions(trimmed, project.name) || mentions(trimmed, project.id));
  if (named.length !== 1) return { kind: "question", text: "Which project should this go in?" };
  const title = cleanLine(trimmed).slice(0, 200);
  if (!title) return { kind: "question", text: "Which project should this go in?" };
  return { kind: "file", projectId: named[0].id, title };
}

export function projectNamed(text: string, projects: readonly CopyProject[]): CopyProject | undefined {
  return resolveProject(text, projects);
}

/** File a task. A rejection is not "filed". This does not delegate or start work. */
export async function fileIntoProject(
  store: (command: string, args: Record<string, unknown>) => Promise<unknown>,
  projectId: string,
  title: string,
): Promise<{ ok: true; id?: string } | { ok: false; text: string }> {
  try {
    const written = await store("tasks_create", {
      actor: { id: "home", project: projectId, kind: "person" },
      input: { title, project: projectId },
    });
    const id = idOf(written);
    return id ? { ok: true, id } : { ok: true };
  } catch {
    return { ok: false, text: "Couldn't file that. Try again." };
  }
}

function idOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rec = value as { id?: unknown; task?: { id?: unknown } };
  if (typeof rec.id === "string" && rec.id.trim()) return rec.id.trim();
  if (rec.task && typeof rec.task.id === "string" && rec.task.id.trim()) return rec.task.id.trim();
  return undefined;
}
